import { fullerText, rangeAttributes, type InputRangeReadout } from "../../../shared/page-readout.js";

export interface AxNodeLite {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  backendDOMNodeId?: number;
  frameId?: string;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
}

const MAX_OUTPUT_CHARS = 24_000;

const MAX_LINE_TEXT = 200;
const MAX_PARAGRAPH_TEXT = 1000;

const MAX_NAME = 60;

const FULL_NAME_ROLES = new Set(["link", "heading"]);

const ITEM_MAX_CHARS = 40;

const MAX_NOTE_CHARS = 3_000;

export function itemNote(text: string): string {
  return ` — in item ${JSON.stringify(text.length > ITEM_MAX_CHARS ? `${text.slice(0, ITEM_MAX_CHARS - 1)}…` : text)}`;
}

const REF_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "cell",
  "gridcell",
  "row",
  "columnheader",
  "rowheader",
]);

export const RANGE_INPUT_ROLES = new Set(["InputTime", "Date", "DateTime", "spinbutton", "slider"]);

const DROP_SUBTREE_ROLES = new Set(["InlineTextBox", "LineBreak"]);

const COLLAPSE_ROLES = new Set(["generic", "none", "presentation", "Ignored"]);

const CONTENT_SCOPE_ROLES = new Set(["article", "main", "region", "blockquote"]);

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();

  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function propValue(node: AxNodeLite, name: string): unknown {
  const p = node.properties?.find((x) => x.name === name);

  return p?.value?.value;
}

const ICON_GLYPHS = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

export function withoutIconGlyphs(text: string): string {
  const cleaned = text.replace(ICON_GLYPHS, "");

  return cleaned.trim() || cleaned === text ? cleaned : "[图标]";
}

function staticTextOf(node: AxNodeLite): string | null {
  return (node.role?.value ?? "") === "StaticText" ? withoutIconGlyphs(String(node.name?.value ?? "")) : null;
}

function describe(node: AxNodeLite, parent: AxNodeLite | undefined, inputs: ReadonlyMap<number, InputRangeReadout>, secret: ReadonlySet<number>, nameMax = MAX_NAME, textMax = MAX_LINE_TEXT): string | null {
  const role = node.role?.value ?? "";

  if (DROP_SUBTREE_ROLES.has(role)) return null;
  const name = withoutIconGlyphs(String(node.name?.value ?? ""));
  const full = name ? fullerText(name, [node.description?.value, role === "StaticText" ? parent?.description?.value : undefined]) : undefined;
  const fullPart = full ? ` full=${JSON.stringify(clip(full, MAX_LINE_TEXT))}` : "";

  if (role === "StaticText") {
    return name ? `text: ${clip(name, textMax)}${fullPart}` : null;
  }

  if (COLLAPSE_ROLES.has(role)) return null;

  if (!name && !REF_ROLES.has(role) && !CONTENT_SCOPE_ROLES.has(role) && role !== "img" && role !== "iframe") {
    return null;
  }

  const parts: string[] = [role];

  if (name) parts.push(`"${clip(name, nameMax)}"${fullPart}`);
  const value = node.value?.value;
  const hasValue = value !== undefined && value !== null && value !== "";
  const range = node.backendDOMNodeId === undefined ? undefined : inputs.get(node.backendDOMNodeId);
  const hidden = node.backendDOMNodeId !== undefined && secret.has(node.backendDOMNodeId);

  if (hidden) { if (hasValue || range?.value) parts.push("value=<filled, hidden>"); }
  else if (hasValue) parts.push(`value=${JSON.stringify(clip(String(value), MAX_NAME))}`);

  if (range) {
    if (!hasValue && !hidden && range.value) parts.push(`value=${JSON.stringify(clip(range.value, MAX_NAME))}`);
    parts.push(rangeAttributes(range).trim());

    if (range.problem) parts.push(`invalid=${range.problem}`);
  }

  const level = propValue(node, "level");

  if (typeof level === "number") parts.push(`level=${level}`);

  for (const key of ["checked", "selected", "expanded", "disabled", "focused", "required"] as const) {
    const v = propValue(node, key);

    if (v === true || typeof v === "string") parts.push(v === true ? key : `${key}=${JSON.stringify(String(v))}`);
  }

  if (role === "link" || role === "iframe") {
    const url = propValue(node, "url");

    if (typeof url === "string" && url) parts.push(`url=${clip(url, 120)}`);
  }

  return parts.join(" ");
}

interface AxTextResult {
  text: string;
  backendIds: number[];
  truncated: boolean;
}

export interface AxLine {
  text: string;
  interactive: boolean;
  ref?: number;
  body: string;
  expandedBody?: string;
  depth: number;
  inField: boolean;
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox"]);

function renderBudgeted(entries: readonly AxLine[], budget: number): { text: string; truncated: boolean; keptRefs: number[]; kept: AxLine[]; droppedRefs: number; droppedText: number } {
  let spare = budget - entries.reduce((sum, entry) => sum + entry.text.length + 1, 0);
  if (spare > 0) entries = entries.map(entry => {
    if (!entry.expandedBody) return entry;
    const extra = entry.expandedBody.length - entry.body.length;
    if (extra <= 0 || extra > spare) return entry;
    spare -= extra;
    const start = entry.text.indexOf(entry.body);
    return { ...entry, body: entry.expandedBody, text: entry.text.slice(0, start) + entry.expandedBody + entry.text.slice(start + entry.body.length) };
  });
  const interactiveCost = entries.reduce((sum, entry) => sum + (entry.interactive ? entry.text.length + 1 : 0), 0);

  if (interactiveCost > budget) {
    const kept: AxLine[] = [];
    const keptRefs: number[] = [];
    let used = 0;
    let droppedRefs = 0, droppedText = 0;

    for (const entry of entries) {
      const cost = entry.text.length + 1;

      if (used + cost > budget) { if (entry.interactive) droppedRefs++; else droppedText++; continue; }

      used += cost;
      kept.push(entry);

      if (entry.ref !== undefined) keptRefs.push(entry.ref);
    }

    return { text: kept.map(entry => entry.text).join("\n"), truncated: droppedRefs + droppedText > 0, keptRefs, kept, droppedRefs, droppedText };
  }

  let left = budget - interactiveCost;
  const kept: AxLine[] = [];
  const keptRefs: number[] = [];
  let droppedText = 0;

  for (const entry of entries) {
    if (entry.interactive) {
      kept.push(entry);

      if (entry.ref !== undefined) keptRefs.push(entry.ref);
      continue;
    }

    if (entry.text.length + 1 > left) { droppedText++; continue; }

    left -= entry.text.length + 1;
    kept.push(entry);
  }

  return { text: kept.map(entry => entry.text).join("\n"), truncated: droppedText > 0, keptRefs, kept, droppedRefs: 0, droppedText };
}

export function axTreeToText(nodes: AxNodeLite[], budget: number = MAX_OUTPUT_CHARS, inputs: ReadonlyMap<number, InputRangeReadout> = new Map(), secret: ReadonlySet<number> = new Set(), zeroSize: ReadonlyMap<number, boolean> = new Map(), items: ReadonlyMap<number, ItemNote> = new Map()): AxTextResult & { entries: AxLine[]; shown: AxLine[] } {
  const entries = axTreeLines(nodes, inputs, secret, zeroSize, items);
  const { text, truncated, keptRefs, kept, droppedRefs, droppedText } = renderBudgeted(entries, budget);
  const recover = "有效恢复方式：先滚动目标进入视口再 snapshot(scope=viewport)，或用 read_element / js 精确提取";

  const finalText = !truncated ? text
    : droppedRefs > 0
      ? `${text}\n... [truncated：这一页超出 ${budget} 字符预算，按文档顺序截掉了后面的 ${droppedRefs + droppedText} 行（其中 ${droppedRefs} 行带 ref），页面后半部分没有给出。${recover}]`
      : `${text}\n... [truncated，带 ref 的行都在；${droppedText} 行不带 ref 的文本超出 ${budget} 字符预算没有给出。${recover}]`;

  return { text: finalText, backendIds: keptRefs, truncated, entries: truncated ? entries : kept, shown: kept };
}

export function renderLines(entries: readonly AxLine[], budget: number): { text: string; truncated: boolean; keptRefs: number[] } {
  return renderBudgeted(entries, budget);
}

function axTreeLines(nodes: AxNodeLite[], inputs: ReadonlyMap<number, InputRangeReadout>, secret: ReadonlySet<number>, zeroSize: ReadonlyMap<number, boolean>, items: ReadonlyMap<number, ItemNote>): AxLine[] {
  const byId = new Map<string, AxNodeLite>();

  for (const n of nodes) byId.set(n.nodeId, n);
  const noted = new Set<number>();
  let noteChars = 0;
  const noteFor = (ref: number): string => {
    const found = items.get(ref);

    if (!found || noted.has(found.item)) return "";
    noted.add(found.item);
    const note = itemNote(found.text);

    if (noteChars + note.length > MAX_NOTE_CHARS) return "";
    noteChars += note.length;

    return note;
  };
  const textBelowSaysIt = (node: AxNodeLite, name: string): boolean => {
    const todo = (node.childIds ?? []).flatMap(id => byId.get(id) ?? []);

    for (let seen = 0; todo.length; seen++) {
      if (seen >= 200) return true;
      const n = todo.pop()!;

      if (!n.ignored && (n.role?.value ?? "") === "StaticText" && String(n.name?.value ?? "") && String(n.name?.value ?? "") !== name) return true;

      for (const id of n.childIds ?? []) { const child = byId.get(id); if (child) todo.push(child); }
    }

    return false;
  };
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  const entries: AxLine[] = [];
  const spoken = new Map<string, number>();
  const say = (text: string): void => { spoken.set(text, (spoken.get(text) ?? 0) + 1); };

  const unsay = (text: string): void => {
    const next = (spoken.get(text) ?? 0) - 1;

    if (next > 0) spoken.set(text, next); else spoken.delete(text);
  };

  const walk = (node: AxNodeLite, depth: number, parentFlat = false, inField = false): void => {
    const role = node.role?.value ?? "";

    if (DROP_SUBTREE_ROLES.has(role)) return;
    const zero = node.backendDOMNodeId === undefined ? undefined : zeroSize.get(node.backendDOMNodeId);
    const flatSelf = zero !== undefined;

    if (node.ignored) {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);

        if (child) walk(child, depth, flatSelf, inField);
      }

      return;
    }

    const name = withoutIconGlyphs(String(node.name?.value ?? ""));
    const flat = zero === false || (parentFlat && role === "StaticText");
    const nameMax = FULL_NAME_ROLES.has(role) && name.length > MAX_NAME && !textBelowSaysIt(node, name) ? MAX_LINE_TEXT : MAX_NAME;
    const shown = zero === false && (!name || role === "StaticText") ? null : describe(node, node.parentId ? byId.get(node.parentId) : undefined, inputs, secret, nameMax);
    const described = shown !== null && flatSelf ? `${shown} zero-size` : shown;
    const textPayload = staticTextOf(node);
    let childDepth = depth;
    const words: string[] = [];

    if (described !== null) {
      const backendId = node.backendDOMNodeId;
      const hasRef = backendId !== undefined && role !== "RootWebArea" && role !== "WebArea" && !flat;
      const repeatedText = textPayload !== null && textPayload.length > 0 && (spoken.get(textPayload) ?? 0) > 0;

      if (!repeatedText) {
        const prefix = hasRef ? `[ref=${backendId}] ` : "";
        const line: AxLine = { text: `${"  ".repeat(depth)}${prefix}${described}${hasRef ? noteFor(backendId) : ""}`, interactive: hasRef, body: described, depth, inField };

        if (hasRef) line.ref = backendId;
        if (role === "StaticText" && name.length > MAX_LINE_TEXT) {
          const expanded = describe(node, node.parentId ? byId.get(node.parentId) : undefined, inputs, secret, nameMax, MAX_PARAGRAPH_TEXT);
          if (expanded) line.expandedBody = flatSelf ? `${expanded} zero-size` : expanded;
        }
        entries.push(line);

        if (name) { say(name); words.push(name); }

        if (textPayload && textPayload !== name) { say(textPayload); words.push(textPayload); }

        childDepth = depth + 1;
      } else {
        childDepth = depth;
      }
    }

    const children = node.backendDOMNodeId !== undefined && secret.has(node.backendDOMNodeId) ? [] : node.childIds ?? [];

    for (const id of children) {
      const child = byId.get(id);

      if (child) walk(child, childDepth, flatSelf, inField || FIELD_ROLES.has(role));
    }

    for (const word of words) unsay(word);
  };

  for (const root of roots) walk(root, 0);

  return entries;
}

const CONTROL_ROLES = new Set(["button", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio"]);

const MAX_TWINS = 300;
const MAX_ITEM_NODES = 500;

export interface RepeatedItems {
  byRef: Map<number, { item: number; from: number }>;
  items: Set<number>;
}

function scanItem(byId: ReadonlyMap<string, AxNodeLite>, item: AxNodeLite, skip: AxNodeLite | undefined, zeroSize: ReadonlyMap<number, boolean>): string | null {
  let best = "";
  const todo = [item];

  for (let seen = 0; todo.length; seen++) {
    if (seen >= MAX_ITEM_NODES) return null;
    const node = todo.pop()!;
    const role = node.role?.value ?? "";

    if (node === skip || (node !== item && (CONTROL_ROLES.has(role) || node.properties?.some(p => p.name === "editable")))) continue;

    if (role === "StaticText" && !node.ignored && !(node.backendDOMNodeId !== undefined && zeroSize.get(node.backendDOMNodeId) === false)) {
      const words = String(node.name?.value ?? "").replace(/\s+/g, " ").trim();

      if (words.length > best.length) best = words;
    }

    for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) todo.push(child); }
  }

  return best;
}

export function repeatedItems(nodes: readonly AxNodeLite[], zeroSize: ReadonlyMap<number, boolean> = new Map()): RepeatedItems {
  const byId = new Map<string, AxNodeLite>();

  for (const n of nodes) byId.set(n.nodeId, n);
  const order = new Map<string, number>();
  const depth = new Map<string, number>();
  const stack: Array<[AxNodeLite, number]> = nodes.filter(n => !n.parentId || !byId.has(n.parentId)).reverse().map(n => [n, 0]);

  while (stack.length) {
    const [node, d] = stack.pop()!;

    if (order.has(node.nodeId)) continue;
    order.set(node.nodeId, order.size);
    depth.set(node.nodeId, d);
    const kids = node.childIds ?? [];

    for (let i = kids.length - 1; i >= 0; i--) {
      const child = byId.get(kids[i]!);

      if (child) stack.push([child, d + 1]);
    }
  }

  const groups = new Map<string, AxNodeLite[]>();

  for (const n of nodes) {
    const role = n.role?.value ?? "";
    const name = String(n.name?.value ?? "").trim();

    if (n.ignored || n.backendDOMNodeId === undefined || !name || !REF_ROLES.has(role) || !order.has(n.nodeId)) continue;
    const key = `${role}\u0000${name}`;
    const group = groups.get(key);

    if (group) group.push(n); else groups.set(key, [n]);
  }

  const parentOf = (n: AxNodeLite) => n.parentId ? byId.get(n.parentId) : undefined;
  const up = (n: AxNodeLite, steps: number): AxNodeLite | undefined => {
    let at: AxNodeLite | undefined = n;

    for (let i = 0; i < steps && at; i++) at = parentOf(at);

    return at;
  };
  const meet = (a: AxNodeLite, b: AxNodeLite): number => {
    const da = depth.get(a.nodeId)!, db = depth.get(b.nodeId)!;
    let x = da > db ? up(a, da - db) : a;
    let y = db > da ? up(b, db - da) : b;

    while (x && y && x !== y) { x = parentOf(x); y = parentOf(y); }

    return x && x === y ? depth.get(x.nodeId)! : -1;
  };
  const verdict = new Map<string, boolean>();
  const found: RepeatedItems = { byRef: new Map(), items: new Set() };

  for (const group of groups.values()) {
    if (group.length < 2 || group.length > MAX_TWINS) continue;
    group.sort((a, b) => order.get(a.nodeId)! - order.get(b.nodeId)!);

    const reach = group.map((n, i) => {
      const shared = Math.max(i > 0 ? meet(n, group[i - 1]!) : -1, i + 1 < group.length ? meet(n, group[i + 1]!) : -1);

      return shared < 0 ? 0 : depth.get(n.nodeId)! - shared - 1;
    });
    const usable = reach.filter(steps => steps > 0);

    if (!usable.length) continue;
    const start = Math.min(...usable);
    const members: Array<{ n: AxNodeLite; item: AxNodeLite; steps: number }> = [];

    group.forEach((n, i) => {
      for (let steps = start; steps <= reach[i]!; steps++) {
        const item = up(n, steps);

        if (!item || item.backendDOMNodeId === undefined) return;

        if (!verdict.has(item.nodeId)) verdict.set(item.nodeId, !!scanItem(byId, item, undefined, zeroSize));

        if (!verdict.get(item.nodeId)) continue;
        members.push({ n, item, steps });

        return;
      }
    });

    const textAt = (m: { n: AxNodeLite }, k: number) => {
      const at = up(m.n, k);

      return (at ? scanItem(byId, at, m.n, zeroSize) : null) ?? "";
    };
    const othersHaveText = (m: { n: AxNodeLite }, k: number) => {
      const at = up(m.n, k), via = up(m.n, k - 1);

      return !!at && (at.childIds ?? []).some(id => {
        const child = byId.get(id);

        if (!child || child === via) return false;
        return !!scanItem(byId, child, undefined, zeroSize);
      });
    };
    const from = new Map<AxNodeLite, number>();
    const textByLevel = members.map(m => Array.from({ length: m.steps }, (_, i) => textAt(m, i + 1)));

    members.forEach((m, j) => {
      let lowest = 0;

      for (let k = 1; k <= m.steps; k++) {
        const text = textByLevel[j]![k - 1]!;

        if (!text) continue;
        lowest ||= k;
        const shared = members.some((other, o) => o !== j && textByLevel[o]![k - 1] === text);

        if (!shared) { from.set(m.n, k); return; }

        if (k === m.steps) { from.set(m.n, lowest); return; }

        if (othersHaveText(m, k + 1)) { from.set(m.n, -1); return; }
      }
    });

    for (const m of members) {
      found.byRef.set(m.n.backendDOMNodeId!, { item: m.item.backendDOMNodeId!, from: from.get(m.n) ?? 1 });
      found.items.add(m.item.backendDOMNodeId!);
    }
  }

  return found;
}

export function itemTextOf(nodes: readonly AxNodeLite[], item: number, ref: number, from = 0): string | undefined {
  const byId = new Map<string, AxNodeLite>();
  let top: AxNodeLite | undefined;
  let control: AxNodeLite | undefined;

  for (const n of nodes) {
    byId.set(n.nodeId, n);

    if (n.backendDOMNodeId === item) top = n;

    if (n.backendDOMNodeId === ref) control = n;
  }

  if (!top) return undefined;

  return control ? itemTextIn(byId, top, control, from, new Map()) : "";
}

interface ItemNote {
  item: number;
  text: string;
}

export function itemTexts(nodes: readonly AxNodeLite[], found: RepeatedItems, zeroSize: ReadonlyMap<number, boolean> = new Map()): Map<number, ItemNote> {
  const byId = new Map<string, AxNodeLite>();
  const byBackend = new Map<number, AxNodeLite>();

  for (const n of nodes) {
    byId.set(n.nodeId, n);

    if (n.backendDOMNodeId !== undefined) byBackend.set(n.backendDOMNodeId, n);
  }

  const out = new Map<number, ItemNote>();

  for (const [ref, { item, from }] of found.byRef) {
    const top = byBackend.get(item), control = byBackend.get(ref);

    if (!top || !control || !CONTROL_ROLES.has(control.role?.value ?? "")) continue;
    const text = itemTextIn(byId, top, control, from, zeroSize);

    if (text) out.set(ref, { item, text });
  }

  return out;
}

function itemTextIn(byId: ReadonlyMap<string, AxNodeLite>, top: AxNodeLite, control: AxNodeLite, from: number, zeroSize: ReadonlyMap<number, boolean>): string {
  const key = `${control.role?.value ?? ""}\u0000${String(control.name?.value ?? "").trim()}`;
  const twinInside = (root: AxNodeLite) => {
    const todo = [root];

    for (let seen = 0; todo.length && seen < MAX_ITEM_NODES * 4; seen++) {
      const node = todo.pop()!;

      if (node !== control && !node.ignored && `${node.role?.value ?? ""}\u0000${String(node.name?.value ?? "").trim()}` === key) return true;

      for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) todo.push(child); }
    }

    return false;
  };
  const path: AxNodeLite[] = [];

  for (let at = control.parentId ? byId.get(control.parentId) : undefined; at && path.length < 64; at = at.parentId ? byId.get(at.parentId) : undefined) {
    path.push(at);

    if (at === top) break;
  }

  if (path.at(-1) !== top || from < 0) return "";
  let below = "";

  for (const [i, at] of path.entries()) {
    if (twinInside(at)) return below;
    const text = scanItem(byId, at, control, zeroSize);

    if (text === null) return below;

    if (text && i + 1 >= Math.max(from, 1)) return text;
    below = text || below;
  }

  return below;
}

export function enclosingItem(nodes: readonly AxNodeLite[], ref: number, isItem: (id: number) => boolean): number | undefined {
  const byId = new Map<string, AxNodeLite>();
  let at: AxNodeLite | undefined;

  for (const n of nodes) { byId.set(n.nodeId, n); if (n.backendDOMNodeId === ref) at = n; }

  for (let hops = 0; at && hops < 64; hops++, at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (at.backendDOMNodeId !== undefined && at.backendDOMNodeId !== ref && isItem(at.backendDOMNodeId)) return at.backendDOMNodeId;
  }

  return undefined;
}
