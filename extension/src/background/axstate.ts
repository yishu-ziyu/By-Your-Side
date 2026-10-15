/**
 * AX 快照的 ref 登记表（SW 内存，按标签页隔离）。
 * ref 就是 backendDOMNodeId；这里只记「上次快照输出过哪些 ref」，供 click/fill
 * 区分 AX ref（走 CDP）与 DOM 回退快照的 ref（走 domops）。
 * SW 重启后登记表丢失：@N 会落到 domops 路径并提示「已失效，请重新 snapshot」。
 */

const byTab = new Map<number, Set<number>>();

const latestKind = new Map<number, "ax" | "dom">();

/** 关掉的标签页最后登记的 ref，留给接回工作标签页时用。只留最近几页。 */
const closedByTab = new Map<number, Set<number>>();

/**
 * 接回后的新工作页上，来自已关闭工作页的 ref。backendDOMNodeId 在不同页面之间会重号，
 * 旧页的编号可能正好是新页上的另一个节点；每个这样的 ref 先拦一次，让模型在新页上重新确认。
 */
const staleByTab = new Map<number, { from: number; refs: Set<number> }>();

/** 页面重渲染后重新找到的节点：ref → 新的 backendDOMNodeId。下一次快照重新编号时作废。 */
const movedByTab = new Map<number, Map<number, number>>();

export function recordAxSnapshot(tabId: number, backendIds: number[]): void {
  byTab.set(tabId, new Set(backendIds));
  latestKind.set(tabId, "ax");
  movedByTab.delete(tabId);
}

/** ref 原来的节点被页面换掉、已按原身份找回唯一的新节点：之后这个 ref 指向新节点。 */
export function moveAxRef(tabId: number, ref: number, backendNodeId: number): void {
  if (!isAxRef(tabId, ref)) return;
  const moved = movedByTab.get(tabId) ?? new Map<number, number>();

  moved.set(ref, backendNodeId);
  movedByTab.set(tabId, moved);
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

/** backendDOMNodeId 属于这一页当前的 AX 登记：快照里的 ref 本身，或某个 ref 被找回后指向的新节点。 */
export function isAxNode(tabId: number, backendNodeId: number): boolean {
  return isAxRef(tabId, backendNodeId) || [...(movedByTab.get(tabId)?.values() ?? [])].includes(backendNodeId);
}

/**
 * 执行动作前取 AX ref 的 backendDOMNodeId：属于当前标签页就返回它，DOM 快照的 ref 或非 ref 返回 undefined（走 domops）。
 * ref 不在当前标签页、却是另一个标签页 AX 快照里的 ref 时直接拒绝：动作没带 tabId 落到了工作标签页，
 * 若照旧走 domops 只会报「ref 已失效」，模型重新 snapshot 拿到的还是同一个 ref，陷入循环。
 */
export function axBackendNodeFor(tabId: number, ref: number | null): number | undefined {
  if (ref === null) return undefined;
  const stale = staleByTab.get(tabId);

  if (stale?.refs.delete(ref)) {
    const error = new Error(`ref @${ref} 来自已关闭的标签页 ${stale.from}；工作标签页已接回到标签页 ${tabId}，这次操作未执行。请在这一页重新 snapshot，确认目标后再操作。`);

    throw Object.assign(error, { executionFact: "not_executed" as const });
  }

  if (isAxRef(tabId, ref)) return movedByTab.get(tabId)?.get(ref) ?? ref;

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
  movedByTab.delete(tabId);
  latestKind.set(tabId, "dom");
}

/** 工作标签页从关掉的 from 接回到 to：from 上登记过的 ref 在 to 上各拦一次。 */
export function carryClosedTabRefs(from: number, to: number): void {
  const refs = closedByTab.get(from);

  closedByTab.delete(from);

  if (refs?.size) staleByTab.set(to, { from, refs: new Set(refs) });
}

/** 这个 ref 已经因为接回被拦过一次，不再重复拦。 */
export function forgetStaleRef(tabId: number, ref: number): void {
  staleByTab.get(tabId)?.refs.delete(ref);
}

export function snapshotRefKind(tabId: number): "ax" | "dom" | undefined {
  return latestKind.get(tabId);
}

// 导航后 backendDOMNodeId 全部失效，整表作废
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") { byTab.delete(tabId); movedByTab.delete(tabId); latestKind.delete(tabId); staleByTab.delete(tabId); }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const refs = byTab.get(tabId);

  if (refs) {
    closedByTab.set(tabId, refs);

    for (const old of closedByTab.keys()) if (closedByTab.size > 8) closedByTab.delete(old);
  }

  staleByTab.delete(tabId);
  byTab.delete(tabId);
  movedByTab.delete(tabId);
  latestKind.delete(tabId);
});
