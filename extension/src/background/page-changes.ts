/**
 * 动作之后“页面上新出现了什么”：只读动作期间变过的几处，和模型上一次读到的这一页比，只给新出现的行（docs/evals/20261014-action-page-changes.md）。
 * 基准是模型看过的那一页（快照、上一次变化摘要），不是动作前另读一次：大页面读一次整页要 1 秒多（维基百科长条目 3.4 万个节点）。
 * 所以摘要说的是“自上次读页以来新出现的”，不断言都是这次动作引起的。
 * 只给新增，不给消失的行：消失的多半是旧值、旧提示，旧值不能再交给模型（还原填写的规则）。
 */
import { renderLines, type AxLine } from "./axtree.js";

/** 摘要上限（字）：只带变化，绝不带整页。 */
export const PAGE_CHANGES_MAX_CHARS = 2000;

/** 输入框类的行：同一个框只是值变了，不算新出现。 */
const FIELD_LINE = /^(textbox|searchbox|combobox)\b/;

/** 每个标签页：模型读到过的 ref → 那一行当时的样子。 */
const baselines = new Map<number, Map<number, string>>();

/** 模型刚读到这一页（整页快照）：记成下一次比较的基准。 */
export function rememberPage(tabId: number, lines: readonly AxLine[]): void {
  baselines.set(tabId, new Map(lines.flatMap(line => line.ref === undefined ? [] : [[line.ref, line.body] as const])));
}

export function forgetPage(tabId: number): void {
  baselines.delete(tabId);
}

export function hasPageBaseline(tabId: number): boolean {
  return baselines.has(tabId);
}

/**
 * 变过的几处里，哪些行是新的：ref 没读到过（新加的、原来藏着的），或同一个 ref 的字变了。
 * 输入框里的文字（框里的值）和只变了值的输入框不算。读到的行并进基准，下一次不再说一遍。
 * scrub 去掉每行内容里的旧值（还原填写记下的，见 fill-undo.ts）。
 */
export function pageChangesSince(tabId: number, lines: readonly AxLine[], scrub: (body: string) => string): { text: string; refs: number[] } | null {
  const base = baselines.get(tabId);

  if (!base) return null;
  const fresh = lines.filter(line => {
    // 框里的字不算；框里的选项（老式组合框把建议列表放在框里面）算。
    if ((line.inField && line.body.startsWith("text:")) || line.ref === undefined) return false;
    const before = base.get(line.ref);

    return before === undefined || (before !== line.body && !FIELD_LINE.test(line.body));
  });

  for (const line of lines) if (line.ref !== undefined) base.set(line.ref, line.body);

  if (!fresh.length) return { text: "", refs: [] };
  // 缩进按新出现的这几行里最浅的一层对齐。
  const top = Math.min(...fresh.map(line => line.depth));
  // 去旧值只动这一行的内容，不碰缩进和 ref 前缀（旧值是数字时会把 ref 弄坏）。
  const shifted = fresh.map(line => ({ ...line, text: line.text.slice(top * 2, line.text.length - line.body.length) + scrub(line.body) }));
  const { text, truncated, keptRefs } = renderLines(shifted, PAGE_CHANGES_MAX_CHARS);

  return { text: truncated ? `${text}\n… [more new lines not shown; snapshot to read them]` : text, refs: keptRefs };
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") baselines.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  baselines.delete(tabId);
});
