import { itemNote, renderLines, type AxLine, type RepeatedItems } from "./axtree.js";

const PAGE_CHANGES_MAX_CHARS = 2000;

const FIELD_LINE = /^(textbox|searchbox|combobox|spinbutton|slider|Date|DateTime|InputTime|InputMonth|InputWeek|checkbox|radio|switch|listbox|option)\b/;

const baselines = new Map<number, Map<number, string>>();

const pageItems = new Map<number, RepeatedItems>();

export function rememberPage(tabId: number, lines: readonly AxLine[], items: RepeatedItems): void {
  baselines.set(tabId, new Map(lines.flatMap(line => line.ref === undefined ? [] : [[line.ref, line.body] as const])));
  pageItems.set(tabId, items);
}

export function forgetPage(tabId: number): void {
  baselines.delete(tabId);
  pageItems.delete(tabId);
}

export function knownItems(tabId: number): RepeatedItems {
  return pageItems.get(tabId) ?? { byRef: new Map(), items: new Set() };
}

export function hasPageBaseline(tabId: number): boolean {
  return baselines.has(tabId);
}

export function freshLines(tabId: number, lines: readonly AxLine[]): AxLine[] | null {
  const base = baselines.get(tabId);

  if (!base) return null;

  return lines.filter(line => {
    if ((line.inField && line.body.startsWith("text:")) || line.ref === undefined) return false;
    const before = base.get(line.ref);

    return before === undefined || (before !== line.body && !FIELD_LINE.test(line.body));
  });
}

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
  const shownText = new Set(fresh.flatMap(line => line.body.startsWith("text: ") ? [line.body.slice(6)] : []));
  const open: Array<{ depth: number; item: string }> = [];
  const noteOf = (line: AxLine) => {
    const item = line.ref === undefined ? undefined : items.get(line.ref);

    while (open.length && open[open.length - 1]!.depth >= line.depth) open.pop();

    if (!item || shownText.has(item) || open.some(o => o.item === item)) return "";
    open.push({ depth: line.depth, item });
    const clean = scrub(item);

    return clean ? itemNote(clean) : "";
  };
  const top = Math.min(...fresh.map(line => line.depth));
  const shifted = fresh.map(line => ({ ...line, text: line.text.slice(top * 2, line.text.length - line.body.length) + scrub(line.body) + noteOf(line) }));
  const { text, truncated, keptRefs } = renderLines(shifted, PAGE_CHANGES_MAX_CHARS);

  return { text: truncated ? `${text}\n… [more new lines not shown; snapshot to read them]` : text, refs: keptRefs };
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") forgetPage(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetPage(tabId);
});
