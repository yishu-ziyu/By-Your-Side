import type { TabInfo } from "../../../../shared/protocol.js";
import { getWorkingTabId, resolveWorkingTab, setWorkingTab, activateTab } from "../state.js";
import { waitForLoad } from "./navigate.js";

export async function listTabs(): Promise<{ tabs: TabInfo[] }> {
  const workingId = await getWorkingTabId();
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

export async function openTab(params: { url?: string }): Promise<{ tabId: number; url: string; title: string }> {
  const tab = await chrome.tabs.create({ url: params.url, active: true });
  if (tab.id == null) throw new Error("创建标签页失败");
  await setWorkingTab(tab.id);
  if (params.url) await waitForLoad(tab.id, 30_000);
  const after = await chrome.tabs.get(tab.id);
  return { tabId: tab.id, url: after.url ?? params.url ?? "", title: after.title ?? "" };
}

export async function switchTab(params: { tabId: number }): Promise<{ tabId: number }> {
  const tab = await resolveWorkingTab(params.tabId);
  await activateTab(tab);
  return { tabId: params.tabId };
}

export async function closeTab(params: { tabId?: number }): Promise<{ closed: true }> {
  let id = params.tabId;
  if (id == null) {
    const tab = await resolveWorkingTab();
    id = tab.id ?? undefined;
  }
  if (id == null) throw new Error("没有可关闭的标签页");
  await chrome.tabs.remove(id);
  if ((await getWorkingTabId()) === id) await setWorkingTab(null);
  return { closed: true };
}
