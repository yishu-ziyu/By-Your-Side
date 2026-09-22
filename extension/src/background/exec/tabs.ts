import { LEAD_SESSION_ID, isLeadSession, type SwitchTabVerification, type TabInfo } from "../../../../shared/protocol.js";
import { ensureAttached } from "../debugger.js";
import { getTabResource, getWorkingTabId, maybeActivateTab, resolveWorkingTab, setWorkingTab, shouldActivateForKey } from "../state.js";
import { parseExecutionKey } from "../tab-bindings.js";
import { waitForInteractive, type PageReadiness } from "./page-readiness.js";

export async function listTabs(sessionId: string = LEAD_SESSION_ID): Promise<{ tabs: TabInfo[] }> {
  const workingId = await getWorkingTabId(sessionId);
  const tabs = await chrome.tabs.query({});
  const resources = await Promise.all(tabs.map((tab) => tab.id == null ? undefined : getTabResource(tab.id)));

  return {
    tabs: tabs
      .filter((t, index) => t.id != null && (isLeadSession(parseExecutionKey(sessionId).sessionId) || resources[index]?.collaborators.includes(sessionId)))
      .map((t) => ({
        id: t.id!,
        title: t.title ?? "",
        url: t.url ?? "",
        active: t.active,
        windowId: t.windowId,
        working: t.id === workingId,
      })),
  };
}

/** 用户此刻正盯着的标签页（纯查询，不认领为工作标签页）；无活动标签时返回 null。 */
export async function getActiveTab(sessionId: string = LEAD_SESSION_ID): Promise<{ tab: TabInfo | null }> {
  const workingId = await getWorkingTabId(sessionId);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = active ?? (await chrome.tabs.query({ active: true }))[0];

  if (!tab || tab.id == null) return { tab: null };

  return {
    tab: {
      id: tab.id,
      title: tab.title ?? "",
      url: tab.url ?? "",
      active: true,
      windowId: tab.windowId,
      working: tab.id === workingId,
    },
  };
}

export async function openTab(
  params: { url?: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ tabId: number; url: string; title: string; readiness?:PageReadiness["readiness"]; waitMs?:number; documentId?:string }> {
  const tab = await chrome.tabs.create({ url: params.url, active: shouldActivateForKey(sessionId) });

  if (tab.id == null) throw new Error("创建标签页失败");
  await setWorkingTab(tab.id, sessionId);

  // 尽量在页面自己的请求发出前开始记录；attach 失败不影响打开。
  try{await ensureAttached(tab.id);}catch{/* DevTools 占用或页面受限：本次加载无网络记录 */}

  const ready=params.url?await waitForInteractive(tab.id,10_000):undefined;
  const after = await chrome.tabs.get(tab.id);

  return { tabId: tab.id, url: after.pendingUrl ?? after.url ?? params.url ?? "", title: after.title ?? "", ...ready };
}

export async function switchTab(
  params: { tabId: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ tabId: number; verification?: SwitchTabVerification }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  await maybeActivateTab(tab, sessionId);

  return { tabId: params.tabId, verification: await readSwitchVerification(params.tabId, sessionId) };
}

/**
 * 执行后读一次浏览器当前事实：工作目标、目标窗口内实际活动的标签、窗口焦点。
 * 只证明核验这一刻的状态：不等待页面加载、不轮询重试、不抢焦点（激活规则沿用
 * shouldActivateForKey / mayActivateTabInWindow，核验只读不改）。目标消失或读取
 * 失败时如实返回 verified:false（不带事实字段），不伪造成功结论。
 */
async function readSwitchVerification(tabId: number, sessionId: string): Promise<SwitchTabVerification> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    const workingTabId = await getWorkingTabId(sessionId);
    const activeTabId = active?.id;
    const windowFocused = win.focused === true;

    return {
      verified: activeTabId === tabId && windowFocused && workingTabId === tabId,
      ...(activeTabId != null ? { activeTabId } : {}),
      windowId: tab.windowId,
      windowFocused,
      workingTabId,
    };
  } catch {
    return { verified: false };
  }
}

export async function closeTab(
  params: { tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ closed: true }> {
  let id = params.tabId;

  if (id == null) {
    const tab = await resolveWorkingTab(undefined, sessionId);
    id = tab.id ?? undefined;
  }

  if (id == null) throw new Error("没有可关闭的标签页");
  await resolveWorkingTab(id, sessionId);
  await chrome.tabs.remove(id);

  if ((await getWorkingTabId(sessionId)) === id) await setWorkingTab(null, sessionId);

  return { closed: true };
}
