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

/** 同一次 AX 采集的补充登记（续读、控件清单）：并入而不是替换，正文里给过的 ref 仍可执行。 */
export function addAxRefs(tabId: number, backendIds: number[]): void {
  const known = byTab.get(tabId) ?? new Set<number>();

  for (const id of backendIds) known.add(id);
  byTab.set(tabId, known);
  latestKind.set(tabId, "ax");
}

export function isAxRef(tabId: number, ref: number): boolean {
  return byTab.get(tabId)?.has(ref) ?? false;
}

/**
 * 执行动作前取 AX ref 的 backendDOMNodeId：属于当前标签页就返回它，DOM 快照的 ref 或非 ref 返回 undefined（走 domops）。
 * ref 不在当前标签页、却是另一个标签页 AX 快照里的 ref 时直接拒绝：动作没带 tabId 落到了工作标签页，
 * 若照旧走 domops 只会报「ref 已失效」，模型重新 snapshot 拿到的还是同一个 ref，陷入循环。
 */
export function axBackendNodeFor(tabId: number, ref: number | null): number | undefined {
  if (ref === null) return undefined;

  if (isAxRef(tabId, ref)) return ref;

  if (latestKind.get(tabId) === "dom") return undefined;
  const owner = [...byTab].find(([otherTab, refs]) => otherTab !== tabId && refs.has(ref))?.[0];

  if (owner === undefined) return undefined;
  const error = new Error(`ref @${ref} 来自标签页 ${owner} 的快照，这次操作落在标签页 ${tabId}，未执行。请带 tabId=${owner} 重试；ref 本身仍有效，不必重新 snapshot。`);

  throw Object.assign(error, { executionFact: "not_executed" as const });
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
