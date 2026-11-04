import { quietOpenedTab } from "../quiet-tabs.js";
import { activeTargetTabs, isPanelUrl } from "../target-window.js";
import { LEAD_SESSION_ID, isLeadSession, type SwitchTabVerification, type TabInfo } from "../../../../shared/protocol.js";
import { ensureAttached } from "../debugger.js";
import { bringForwardForUser } from "../foreground.js";
import { getTabResource, getWorkingTabId, resolveWorkingTab, setWorkingTab } from "../state.js";
import { parseExecutionKey } from "../tab-bindings.js";
import { ERROR_PAGE_NOTE, downloadNote, retryTransientErrorPage, settlesContent, waitForInteractive, waitForQuietDom, type PageReadiness } from "./page-readiness.js";

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

export async function getActiveTab(sessionId: string = LEAD_SESSION_ID): Promise<{ tab: TabInfo | null }> {
  const workingId = await getWorkingTabId(sessionId);
  const [active] = await activeTargetTabs();
  const tab = active ?? (await chrome.tabs.query({ active: true })).find(t => !isPanelUrl(t.url));

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
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
  cancelled?: () => boolean,
  beside?: chrome.tabs.Tab,
): Promise<{ tabId: number; url: string; title: string; note?: string; retry?: string; tabClosed?: true } & Partial<PageReadiness>> {
  const previous = await getWorkingTabId(sessionId);
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  const placement = beside?.id != null ? { windowId: beside.windowId, index: beside.index + 1, openerTabId: beside.id } : {};
  const tab = await chrome.tabs.create({ url: params.url, active: false, ...placement });

  if (tab.id == null) throw new Error("创建标签页失败");
  void quietOpenedTab(tab.id);
  await setWorkingTab(tab.id, sessionId);

  try{await ensureAttached(tab.id);}catch{}

  const opened=params.url?await retryTransientErrorPage(tab.id,params.url,await waitForInteractive(tab.id,10_000,{requestedUrl:params.url}),10_000,cancelled):undefined;
  const ready=opened?.ready;
  const retry=opened?.retry?{retry:opened.retry}:{};

  if (ready && settlesContent(ready.readiness)) { ready.quietMs = await waitForQuietDom(tab.id); ready.waitMs += ready.quietMs; }
  let after: chrome.tabs.Tab;

  try {
    after = await chrome.tabs.get(tab.id);
  } catch (error) {
    if (!ready?.download) throw error;
    const working = await getWorkingTabId(sessionId);

    if (working === tab.id || working == null) await setWorkingTab(previous, sessionId);

    return { tabId: tab.id, url: params.url ?? "", title: "", ...ready, ...retry, note: downloadNote(ready.download, "closed"), tabClosed: true };
  }

  return { tabId: tab.id, url: after.pendingUrl ?? after.url ?? params.url ?? "", title: after.title ?? "", ...ready, ...retry, ...(ready?.download ? { note: downloadNote(ready.download) } : ready?.readiness === "error_page" ? { note: ERROR_PAGE_NOTE } : {}) };
}

export async function switchTab(
  params: { tabId: number; show?: boolean },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<{ tabId: number; verification?: SwitchTabVerification }> {
  await resolveWorkingTab(params.tabId, sessionId);
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();

  if (params.show === true) await bringForwardForUser(params.tabId, "user_asked");

  return { tabId: params.tabId, verification: await readSwitchVerification(params.tabId, sessionId) };
}

async function readSwitchVerification(tabId: number, sessionId: string): Promise<SwitchTabVerification> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    const workingTabId = await getWorkingTabId(sessionId);
    const activeTabId = active?.id;
    const windowFocused = win.focused === true;

    const verification: SwitchTabVerification = {
      verified: activeTabId === tabId && windowFocused && workingTabId === tabId,
      windowId: tab.windowId,
      windowFocused,
      workingTabId,
    };

    if (activeTabId != null) verification.activeTabId = activeTabId;

    return verification;
  } catch {
    return { verified: false };
  }
}

export async function closeTab(
  params: { tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<{ closed: true }> {
  let id = params.tabId;

  if (id == null) {
    const tab = await resolveWorkingTab(undefined, sessionId);
    id = tab.id ?? undefined;
  }

  if (id == null) throw new Error("没有可关闭的标签页");
  await resolveWorkingTab(id, sessionId);
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  await chrome.tabs.remove(id);

  if ((await getWorkingTabId(sessionId)) === id) await setWorkingTab(null, sessionId);

  return { closed: true };
}
