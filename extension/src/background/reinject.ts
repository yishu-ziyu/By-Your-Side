/**
 * 扩展安装、更新、重载后，给已经打开的网页补装网页脚本（10-07：重载后按右 ⌥ 没反应，要刷新网页才行）。
 * Chrome 只在网页加载时注入 manifest 里的 content_scripts；已打开的网页要我们自己补。
 * 旧脚本还留在网页里，只是断开了，它们见到断开就不再接按键和鼠标（content/alive.ts）。
 */
export function installReinject(): void {
  chrome.runtime.onInstalled.addListener(() => { void reinjectOpenTabs(); });
}

async function reinjectOpenTabs(): Promise<void> {
  const files = chrome.runtime.getManifest().content_scripts?.flatMap(script => script.js ?? []) ?? [];

  if (!files.length) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });

  await Promise.all(tabs.map(tab => tab.id == null || tab.discarded ? undefined
    // 应用商店、受保护的网页、还没加载完的标签页会拒绝注入：跳过，它们下次加载时照常注入。
    : chrome.scripting.executeScript({ target: { tabId: tab.id }, files }).catch(() => {})));
}
