import { LEAD_SESSION_ID, type TabInfo } from "../../../../shared/protocol.js";
import { getTabResource, getWorkingTabId, maybeActivateTab, resolveWorkingTab, setWorkingTab, shouldActivateForKey } from "../state.js";
import { parseExecutionKey } from "../tab-bindings.js";
import { waitForLoad } from "./navigate.js";

export async function listTabs(sessionId: string = LEAD_SESSION_ID): Promise<{ tabs: TabInfo[] }> {
  const workingId = await getWorkingTabId(sessionId);
  const tabs = await chrome.tabs.query({});
  const conversationId = parseExecutionKey(sessionId).conversationId;
  const resources = await Promise.all(tabs.map((tab) => tab.id == null ? undefined : getTabResource(tab.id)));
  return {
    tabs: tabs
      .filter((t, index) => t.id != null && resources[index]?.conversationId === conversationId)
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
): Promise<{ tabId: number; url: string; title: string }> {
  const tab = await chrome.tabs.create({ url: params.url, active: shouldActivateForKey(sessionId) });
  if (tab.id == null) throw new Error("创建标签页失败");
  await setWorkingTab(tab.id, sessionId);
  if (params.url) await waitForLoad(tab.id, 30_000);
  const after = await chrome.tabs.get(tab.id);
  return { tabId: tab.id, url: after.url ?? params.url ?? "", title: after.title ?? "" };
}

export async function switchTab(
  params: { tabId: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ tabId: number }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  await maybeActivateTab(tab, sessionId);
  return { tabId: params.tabId };
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
