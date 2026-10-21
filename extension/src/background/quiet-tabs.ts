/**
 * 助手在后台开的、或在后台出声的标签页先静音，用户切过去时恢复。
 * 不然助手点开的视频会在用户看不见的标签页里一直放声音（模拟用户一晚上留下三个同时出声的页）。
 * 用户自己静音的页不动；记录放 storage.session，后台重启后切过去仍能恢复声音。
 */
import { findSessionsForTab } from "./state.js";

const KEY = "sideagent_quieted_tabs";
const opened = new Set<number>();

async function quieted(): Promise<number[]> {
  const value = (await chrome.storage.session.get(KEY))[KEY];

  return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
}

async function setQuieted(ids: number[]): Promise<void> {
  await chrome.storage.session.set({ [KEY]: ids.slice(-200) });
}

async function isAssistantTab(tabId: number): Promise<boolean> {
  return opened.has(tabId) || (await findSessionsForTab(tabId).catch(() => [])).length > 0;
}

/** 不在眼前、也没被用户静音的页：静音并记下是助手静的。 */
export async function quietIfBackground(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (!tab || tab.active || tab.mutedInfo?.muted) return;
  await chrome.tabs.update(tabId, { muted: true });
  await setQuieted([...(await quieted()).filter(id => id !== tabId), tabId]);
}

/** 助手开在后台的新页：一开就静音（视频页常在加载完就自动播放）。 */
export async function quietOpenedTab(tabId: number): Promise<void> {
  opened.add(tabId);
  await quietIfBackground(tabId).catch(() => {});
}

export function installQuietTabs(): void {
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.audible && !tab.active) void isAssistantTab(tabId).then(mine => (mine ? quietIfBackground(tabId) : undefined)).catch(() => {});
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void quieted().then(async ids => {
      if (!ids.includes(tabId)) return;
      await setQuieted(ids.filter(id => id !== tabId));
      await chrome.tabs.update(tabId, { muted: false });
    }).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    opened.delete(tabId);
    void quieted().then(ids => (ids.includes(tabId) ? setQuieted(ids.filter(id => id !== tabId)) : undefined)).catch(() => {});
  });
}
