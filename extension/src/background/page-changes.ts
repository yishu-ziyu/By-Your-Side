/**
 * 动作之后“页面上新出现了什么”：和模型上一次读到的这一页比，只给新出现的行（docs/evals/20261014-action-page-changes.md）。
 * 基准是模型看过的那一页（快照、上一次变化摘要），不是动作前另读一次：动作前读一次整页会让每个动作都多等一份读页时间。
 * 所以摘要说的是“自上次读页以来新出现的”，不断言都是这次动作引起的。
 * 只给新增，不给消失的行：消失的多半是旧值、旧提示，旧值不能再交给模型（还原填写的规则）。
 */
import { renderLines, type AxLine } from "./axtree.js";

/** 摘要上限（字）：只带变化，绝不带整页。 */
export const PAGE_CHANGES_MAX_CHARS = 2000;

/** 新行多到这个比例、又不少于这么多行：页面多半整块重画了，只说一句，让模型自己读。 */
const REDRAW_SHARE = 0.6;
const REDRAW_MIN_LINES = 40;

interface Baseline { ids: Set<number>; counts: Map<string, number> }

const baselines = new Map<number, Baseline>();

/** 同一个东西的身份：可点的行按 ref，文字按内容；页面重画后 ref 全换，所以同时按内容计数。 */
const keyOf = (line: AxLine) => line.body;

/** 模型刚读到这一页（快照、变化摘要）：记成下一次比较的基准。 */
export function rememberPage(tabId: number, lines: readonly AxLine[]): void {
  const ids = new Set<number>();
  const counts = new Map<string, number>();

  for (const line of lines) {
    if (line.ref !== undefined) ids.add(line.ref);
    counts.set(keyOf(line), (counts.get(keyOf(line)) ?? 0) + 1);
  }

  baselines.set(tabId, { ids, counts });
}

export function forgetPage(tabId: number): void {
  baselines.delete(tabId);
}

export function hasPageBaseline(tabId: number): boolean {
  return baselines.has(tabId);
}

export type PageChangesText = { text: string; refs: number[] } | { redrawn: true } | null;

/**
 * 和基准比出新出现的行。一行算新的：它的 ref 不在基准里，并且这种内容比基准里多出来了（重画后 ref 全换、内容没变的不算）。
 * 输入框里面的文字（框里的值）不算。没有基准返回 null：不能把整页都说成“新出现的”。
 */
export function pageChangesSince(tabId: number, lines: readonly AxLine[]): PageChangesText {
  const base = baselines.get(tabId);

  if (!base) return null;
  const surplus = new Map<string, number>();

  for (const line of lines) surplus.set(keyOf(line), (surplus.get(keyOf(line)) ?? 0) + 1);
  for (const [key, n] of base.counts) surplus.set(key, (surplus.get(key) ?? 0) - n);

  const fresh = lines.filter(line => {
    if (line.inField || (line.ref !== undefined && base.ids.has(line.ref))) return false;
    const left = surplus.get(keyOf(line)) ?? 0;

    if (left <= 0) return false;
    surplus.set(keyOf(line), left - 1);

    return true;
  });

  rememberPage(tabId, lines);

  if (!fresh.length) return { text: "", refs: [] };

  if (fresh.length >= REDRAW_MIN_LINES && fresh.length / lines.length >= REDRAW_SHARE) return { redrawn: true };
  // 缩进按新出现的这几行里最浅的一层对齐。
  const top = Math.min(...fresh.map(line => line.depth));
  const shifted = fresh.map(line => ({ ...line, text: line.text.slice(top * 2) }));
  const { text, truncated, keptRefs } = renderLines(shifted, PAGE_CHANGES_MAX_CHARS);

  return { text: truncated ? `${text}\n… [more new lines not shown; snapshot to read them]` : text, refs: keptRefs };
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") baselines.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  baselines.delete(tabId);
});
