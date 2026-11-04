import { findSessionsForTab } from "./state.js";

const KEY = "sideagent_quieted_tabs";
const opened = new Set<number>();

async function quieted(): Promise<number[]> {
  const value = (await chrome.storage.local.get(KEY))[KEY];

  return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
}

async function setQuieted(ids: number[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: ids.slice(-200) });
}

async function isAssistantTab(tabId: number): Promise<boolean> {
  return opened.has(tabId) || (await findSessionsForTab(tabId).catch(() => [])).length > 0;
}

export async function quietIfBackground(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (!tab || tab.active || tab.mutedInfo?.muted) return;
  await chrome.tabs.update(tabId, { muted: true });
  await setQuieted([...(await quieted()).filter(id => id !== tabId), tabId]);
}

export async function quietOpenedTab(tabId: number): Promise<void> {
  opened.add(tabId);
  await quietIfBackground(tabId).catch(() => {});
}

async function requiet(): Promise<void> {
  const ids = await quieted();

  if (!ids.length) return;
  const tabs = await chrome.tabs.query({});
  const open = tabs.filter(tab => tab.id !== undefined && ids.includes(tab.id));

  for (const tab of open) if (!tab.active && !tab.mutedInfo?.muted) await chrome.tabs.update(tab.id!, { muted: true }).catch(() => {});
  await setQuieted(open.filter(tab => !tab.active).map(tab => tab.id!));
}

export function installQuietTabs(): void {
  void requiet().catch(() => {});
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
