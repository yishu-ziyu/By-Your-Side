/**
 * AX 快照的 ref 登记表（SW 内存，按标签页隔离）。
 * ref 就是 backendDOMNodeId；这里只记「上次快照输出过哪些 ref」，供 click/fill
 * 区分 AX ref（走 CDP）与 DOM 回退快照的 ref（走 domops）。
 * SW 重启后登记表丢失：@N 会落到 domops 路径并提示「已失效，请重新 snapshot」。
 */

const byTab = new Map<number, Set<number>>();

export function recordAxSnapshot(tabId: number, backendIds: number[]): void {
  byTab.set(tabId, new Set(backendIds));
}

export function isAxRef(tabId: number, ref: number): boolean {
  return byTab.get(tabId)?.has(ref) ?? false;
}

// 导航后 backendDOMNodeId 全部失效，整表作废
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") byTab.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  byTab.delete(tabId);
});
