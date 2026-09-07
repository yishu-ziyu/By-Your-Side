/**
 * AX 快照的 ref 登记表（SW 内存，按标签页隔离）。
 * ref 就是 backendDOMNodeId；这里只记「上次快照输出过哪些 ref」，供 click/fill
 * 区分 AX ref（走 CDP）与 DOM 回退快照的 ref（走 domops）。
 * SW 重启后登记表丢失：@N 会落到 domops 路径并提示「已失效，请重新 snapshot」。
 */

const byTab = new Map<number, Set<number>>();
const latestKind = new Map<number, "ax" | "dom">();

export function recordAxSnapshot(tabId: number, backendIds: number[]): void {
  byTab.set(tabId, new Set(backendIds));
  latestKind.set(tabId, "ax");
}

export function isAxRef(tabId: number, ref: number): boolean {
  return byTab.get(tabId)?.has(ref) ?? false;
}

/**
 * DOM 回退/视口快照后调用：旧 AX ref 不再适用，必须作废。
 * DOM 快照的 ref 是自增小编号，与 backendDOMNodeId 同处一个数字空间；
 * 不清表会导致 click/fill 经 isAxRef 误判、把 DOM ref 当旧 AX ref 走 CDP。
 */
export function clearAxSnapshot(tabId: number): void {
  byTab.delete(tabId);
  latestKind.set(tabId, "dom");
}

export function snapshotRefKind(tabId: number): "ax" | "dom" | undefined {
  return latestKind.get(tabId);
}

// 导航后 backendDOMNodeId 全部失效，整表作废
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") { byTab.delete(tabId); latestKind.delete(tabId); }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  byTab.delete(tabId);
  latestKind.delete(tabId);
});
