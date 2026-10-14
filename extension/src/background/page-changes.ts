/**
 * 动作之后“页面上新出现了什么”：只读动作期间变过的几处，和模型上一次读到的这一页比，只给新出现的行（docs/evals/20261014-action-page-changes.md）。
 * 基准是模型看过的那一页（快照、上一次变化摘要），不是动作前另读一次：大页面读一次整页要 1 秒多（维基百科长条目 3.4 万个节点）。
 * 所以摘要说的是“自上次读页以来新出现的”，不断言都是这次动作引起的。
 * 只给新增，不给消失的行：消失的多半是旧值、旧提示，旧值不能再交给模型（还原填写的规则）。
 * 列表里每项都有的同名控件（每条笔记的「More」），行尾写明它在哪一项：快照是平的，模型分不清（10-14 Memos 置顶点错了笔记还说成功）。
 */
import { renderLines, type AxLine, type RepeatedItems } from "./axtree.js";

/** 摘要上限（字）：只带变化，绝不带整页。 */
export const PAGE_CHANGES_MAX_CHARS = 2000;

/** “在哪一项”最多写几个字。 */
const ITEM_MAX_CHARS = 40;

/** 能填、能选的控件的行：同一个控件只是值或勾选状态变了，不算新出现（它自己的变化由效果证据报）。 */
const FIELD_LINE = /^(textbox|searchbox|combobox|spinbutton|slider|Date|DateTime|InputTime|InputMonth|InputWeek|checkbox|radio|switch|listbox|option)\b/;

/** 每个标签页：模型读到过的 ref → 那一行当时的样子。 */
const baselines = new Map<number, Map<number, string>>();

/** 每个标签页：列表里重复的控件各在哪一项（axtree.ts repeatedItems）。 */
const pageItems = new Map<number, RepeatedItems>();

/** 模型刚读到这一页（整页快照）：记成下一次比较的基准。 */
export function rememberPage(tabId: number, lines: readonly AxLine[], items: RepeatedItems): void {
  baselines.set(tabId, new Map(lines.flatMap(line => line.ref === undefined ? [] : [[line.ref, line.body] as const])));
  pageItems.set(tabId, items);
}

export function forgetPage(tabId: number): void {
  baselines.delete(tabId);
  pageItems.delete(tabId);
}

/** 这一页认出来的项（整页快照时认的，加上之后读到的几处里新认的）。 */
export function knownItems(tabId: number): RepeatedItems {
  return pageItems.get(tabId) ?? { byRef: new Map(), items: new Set() };
}

export function hasPageBaseline(tabId: number): boolean {
  return baselines.has(tabId);
}

/** 变过的几处里，哪些行是新的：ref 没读到过（新加的、原来藏着的），或同一个 ref 的字变了。输入框里的文字和只变了值的输入框不算。不改基准。 */
export function freshLines(tabId: number, lines: readonly AxLine[]): AxLine[] | null {
  const base = baselines.get(tabId);

  if (!base) return null;

  return lines.filter(line => {
    // 框里的字不算；框里的选项（老式组合框把建议列表放在框里面）算。
    if ((line.inField && line.body.startsWith("text:")) || line.ref === undefined) return false;
    const before = base.get(line.ref);

    return before === undefined || (before !== line.body && !FIELD_LINE.test(line.body));
  });
}

/**
 * 交回新出现的行，读到的行并进基准，下一次不再说一遍；这几处新认出的项并进这一页记下的。
 * items：ref → 它所在那一项现在的字（exec/snapshot.ts 读）。scrub 去掉旧值（还原填写记下的，见 fill-undo.ts），“在哪一项”也先去旧值再截短。
 */
export function pageChangesSince(tabId: number, lines: readonly AxLine[], scrub: (body: string) => string, items: ReadonlyMap<number, string>, found: RepeatedItems): { text: string; refs: number[] } | null {
  const fresh = freshLines(tabId, lines);
  const base = baselines.get(tabId);

  if (!fresh || !base) return null;

  for (const line of lines) if (line.ref !== undefined) base.set(line.ref, line.body);
  const known = knownItems(tabId);

  for (const [ref, item] of found.byRef) known.byRef.set(ref, item);

  for (const item of found.items) known.items.add(item);
  pageItems.set(tabId, known);

  if (!fresh.length) return { text: "", refs: [] };
  // 那一项的字已经作为新行出现了（新出现的一整列）：不再在每个控件后面重复一遍。
  const shownText = new Set(fresh.flatMap(line => line.body.startsWith("text: ") ? [line.body.slice(6)] : []));
  const itemNote = (ref: number | undefined) => {
    const item = ref === undefined ? undefined : items.get(ref);
    const clean = item && !shownText.has(item) ? scrub(item) : "";

    return clean ? ` — in item ${JSON.stringify(clean.length > ITEM_MAX_CHARS ? `${clean.slice(0, ITEM_MAX_CHARS - 1)}…` : clean)}` : "";
  };
  // 缩进按新出现的这几行里最浅的一层对齐。
  const top = Math.min(...fresh.map(line => line.depth));
  // 去旧值只动这一行的内容，不碰缩进和 ref 前缀（旧值是数字时会把 ref 弄坏）。
  const shifted = fresh.map(line => ({ ...line, text: line.text.slice(top * 2, line.text.length - line.body.length) + scrub(line.body) + itemNote(line.ref) }));
  const { text, truncated, keptRefs } = renderLines(shifted, PAGE_CHANGES_MAX_CHARS);

  return { text: truncated ? `${text}\n… [more new lines not shown; snapshot to read them]` : text, refs: keptRefs };
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") forgetPage(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetPage(tabId);
});
