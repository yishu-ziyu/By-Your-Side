const byTab = new Map<number, Set<number>>();

const latestKind = new Map<number, "ax" | "dom">();

const movedByTab = new Map<number, Map<number, number>>();

export function recordAxSnapshot(tabId: number, backendIds: number[]): void {
  byTab.set(tabId, new Set(backendIds));
  latestKind.set(tabId, "ax");
  movedByTab.delete(tabId);
}

export function moveAxRef(tabId: number, ref: number, backendNodeId: number): void {
  if (!isAxRef(tabId, ref)) return;
  const moved = movedByTab.get(tabId) ?? new Map<number, number>();

  moved.set(ref, backendNodeId);
  movedByTab.set(tabId, moved);
}

export function addAxRefs(tabId: number, backendIds: number[]): void {
  const known = byTab.get(tabId) ?? new Set<number>();

  for (const id of backendIds) known.add(id);
  byTab.set(tabId, known);
  latestKind.set(tabId, "ax");
}

export function isAxRef(tabId: number, ref: number): boolean {
  return byTab.get(tabId)?.has(ref) ?? false;
}

export function isAxNode(tabId: number, backendNodeId: number): boolean {
  return isAxRef(tabId, backendNodeId) || [...(movedByTab.get(tabId)?.values() ?? [])].includes(backendNodeId);
}

export function axBackendNodeFor(tabId: number, ref: number | null): number | undefined {
  if (ref === null) return undefined;

  if (isAxRef(tabId, ref)) return movedByTab.get(tabId)?.get(ref) ?? ref;

  if (latestKind.get(tabId) === "dom") return undefined;
  const owner = [...byTab].find(([otherTab, refs]) => otherTab !== tabId && refs.has(ref))?.[0];

  if (owner === undefined) return undefined;
  const error = new Error(`ref @${ref} 来自标签页 ${owner} 的快照，这次操作落在标签页 ${tabId}，未执行。请带 tabId=${owner} 重试；ref 本身仍有效，不必重新 snapshot。`);

  throw Object.assign(error, { executionFact: "not_executed" as const });
}

/**
 * WHY: DOM 回退/视口快照后调用：旧 AX ref 不再适用，必须作废。
 * DOM 快照的 ref 是自增小编号，与 backendDOMNodeId 同处一个数字空间；
 * 不清表会导致 click/fill 经 isAxRef 误判、把 DOM ref 当旧 AX ref 走 CDP。
 */
export function clearAxSnapshot(tabId: number): void {
  byTab.delete(tabId);
  movedByTab.delete(tabId);
  latestKind.set(tabId, "dom");
}

export function snapshotRefKind(tabId: number): "ax" | "dom" | undefined {
  return latestKind.get(tabId);
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") { byTab.delete(tabId); movedByTab.delete(tabId); latestKind.delete(tabId); }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  byTab.delete(tabId);
  movedByTab.delete(tabId);
  latestKind.delete(tabId);
});
