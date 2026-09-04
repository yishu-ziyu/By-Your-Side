import { LEAD_SESSION_ID, isLeadSession, type TabInfo } from "../../../../shared/protocol.js";
import { getWorkingTabId, maybeActivateTab, resolveWorkingTab, setWorkingTab } from "../state.js";
import { waitForLoad } from "./navigate.js";

export async function listTabs(sessionId: string = LEAD_SESSION_ID): Promise<{ tabs: TabInfo[] }> {
  const workingId = await getWorkingTabId(sessionId);
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs
      .filter((t) => t.id != null)
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

export async function openTab(
  params: { url?: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ tabId: number; url: string; title: string }> {
  const tab = await chrome.tabs.create({ url: params.url, active: isLeadSession(sessionId) });
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
  await chrome.tabs.remove(id);
  if ((await getWorkingTabId(sessionId)) === id) await setWorkingTab(null, sessionId);
  return { closed: true };
}
