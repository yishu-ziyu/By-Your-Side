export function installReinject(): void {
  chrome.runtime.onInstalled.addListener(() => { void reinjectOpenTabs(); });
}

async function reinjectOpenTabs(): Promise<void> {
  const files = chrome.runtime.getManifest().content_scripts?.flatMap(script => script.js ?? []) ?? [];

  if (!files.length) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });

  await Promise.all(tabs.map(tab => tab.id == null || tab.discarded ? undefined
    : chrome.scripting.executeScript({ target: { tabId: tab.id }, files }).catch(() => {})));
}
