/**
 * CDP Accessibility 树 → 文本快照的纯转换层。
 * 不碰 chrome.* API。
 *
 * 输出格式（与 ego-browser 的 snapshotText 约定对齐）：
 *   [ref=N] role "name" key=value...   —— ref 直接是 backendDOMNodeId，跨快照保号
 *   text: 静态文本
 * 树形缩进两个空格一层；ignored/无信息节点折叠（自身不出行，子节点提升）。
 */

import { fullerText, rangeAttributes, type InputRangeReadout } from "../../../shared/page-readout.js";

/** CDP AXNode 的最小形状（只取我们用的字段）。 */
export interface AxNodeLite {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  backendDOMNodeId?: number;
  frameId?: string;
  role?: { value?: string };
  name?: { value?: string };
  /** Chrome puts title / aria-description here when it did not use them for the name. */
  description?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
}

/**
 * 输出字符预算。ego 的做法是不截断（380KB 照吐，靠 scope 控范围）；
 * 我们要照顾 LLM 上下文：24K 字符约 6k token，已覆盖一页复杂站点的主要交互区。
 * 超预算时优先保留可交互/可引用行（ref），先丢纯文本行，见 renderBudgeted。
 */
const MAX_OUTPUT_CHARS = 24_000;

const MAX_LINE_TEXT = 200;
// Research facts often sit beyond a paragraph's first sentence. Keep a bounded
// paragraph while the whole snapshot still obeys its existing character budget.
const MAX_PARAGRAPH_TEXT = 1000;

const MAX_NAME = 60;

/**
 * 链接和标题的名字是模型要原样转述给用户的（文章标题、条目名）：给到一行的上限，不按 MAX_NAME 截。
 * 名字是由下面几行文字拼成的（整张卡片包在一个链接里）时仍按 MAX_NAME 截：那些文字各自成行，已经说全了。
 */
const FULL_NAME_ROLES = new Set(["link", "heading"]);

/** “在哪一项”最多写几个字。 */
const ITEM_MAX_CHARS = 40;

/** 整页快照里“在哪一项”合计最多占这么多字（预算的八分之一）：再多就挤掉页面本身的行了，后面的项不再写。 */
const MAX_NOTE_CHARS = 3_000;

/** 行尾的“在哪一项”：快照和动作后的变化摘要用同一个写法。 */
export function itemNote(text: string): string {
  return ` — in item ${JSON.stringify(text.length > ITEM_MAX_CHARS ? `${text.slice(0, ITEM_MAX_CHARS - 1)}…` : text)}`;
}

/** 可交互/可引用角色：这些节点输出行带 ref（= backendDOMNodeId）。 */
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

/** 可能是原生范围输入框的角色（时间/日期框、数字框、滑块）；只有它们去查 DOM 的 min/max/step。 */
export const RANGE_INPUT_ROLES = new Set(["InputTime", "Date", "DateTime", "spinbutton", "slider"]);

/** 整棵子树丢弃的角色。 */
const DROP_SUBTREE_ROLES = new Set(["InlineTextBox", "LineBreak"]);

/** 自身不出行但子节点提升的角色。 */
const COLLAPSE_ROLES = new Set(["generic", "none", "presentation", "Ignored"]);

// These containers delimit complete source text even without accessible names.
const CONTENT_SCOPE_ROLES = new Set(["article", "main", "region", "blockquote"]);

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();

  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function propValue(node: AxNodeLite, name: string): unknown {
  const p = node.properties?.find((x) => x.name === name);

  return p?.value?.value;
}

/** 静态文本节点说的话；其它角色返回 null。用于折叠「父节点名字 + 子静态文本」的重复。 */
function staticTextOf(node: AxNodeLite): string | null {
  return (node.role?.value ?? "") === "StaticText" ? String(node.name?.value ?? "") : null;
}

/** 节点自身是否值得占一行（不含 ref 前缀）。 */
function describe(node: AxNodeLite, parent: AxNodeLite | undefined, inputs: ReadonlyMap<number, InputRangeReadout>, secret: ReadonlySet<number>, nameMax = MAX_NAME, textMax = MAX_LINE_TEXT): string | null {
  const role = node.role?.value ?? "";

  if (DROP_SUBTREE_ROLES.has(role)) return null;
  const name = node.name?.value ?? "";
  // 页面把文字截成「…」显示、元素自带更完整的 title/aria 时，同时给出完整值（规则见 shared/page-readout.ts）。
  const full = name ? fullerText(name, [node.description?.value, role === "StaticText" ? parent?.description?.value : undefined]) : undefined;
  const fullPart = full ? ` full=${JSON.stringify(clip(full, MAX_LINE_TEXT))}` : "";

  if (role === "StaticText") {
    return name ? `text: ${clip(name, textMax)}${fullPart}` : null;
  }

  if (COLLAPSE_ROLES.has(role)) return null;

  if (!name && !REF_ROLES.has(role) && !CONTENT_SCOPE_ROLES.has(role) && role !== "img" && role !== "iframe") {
    // 无名非交互节点没信息量（容器、装饰），折叠
    return null;
  }

  const parts: string[] = [role];

  if (name) parts.push(`"${clip(name, nameMax)}"${fullPart}`);
  const value = node.value?.value;
  const hasValue = value !== undefined && value !== null && value !== "";
  const range = node.backendDOMNodeId === undefined ? undefined : inputs.get(node.backendDOMNodeId);
  // 密码、卡号、验证码这类栏（判定见 exec/snapshot.ts）：只说填了，不给值。
  const hidden = node.backendDOMNodeId !== undefined && secret.has(node.backendDOMNodeId);

  if (hidden) { if (hasValue || range?.value) parts.push("value=<filled, hidden>"); }
  else if (hasValue) parts.push(`value=${JSON.stringify(clip(String(value), MAX_NAME))}`);

  if (range) {
    // AX 树不给时间/日期框的值与 min/max/step：用 DOM 读数补上，越界时直接标出浏览器的判定。
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

  // 链接/iframe 带目标 URL：模型不点击就能读链接（ego 行为约定）
  if (role === "link" || role === "iframe") {
    const url = propValue(node, "url");

    if (typeof url === "string" && url) parts.push(`url=${clip(url, 120)}`);
  }

  return parts.join(" ");
}

interface AxTextResult {
  text: string;
  /** 本次快照输出的全部 ref（backendDOMNodeId），调用方记录供 click/fill 校验。 */
  backendIds: number[];
  truncated: boolean;
}

export interface AxLine {
  text: string;
  /** 可交互/可引用（ref）行：超预算时不会被丢。 */
  interactive: boolean;
  ref?: number;
  /** 去掉缩进和 ref 前缀的这一行：比较前后两次读页时，按它认出同一个东西。 */
  body: string;
  expandedBody?: string;
  depth: number;
  /** 在输入框里面（输入框自己的文字）：比较变化时不算新出现的内容。 */
  inField: boolean;
}

/** 输入框类角色：它们下面的静态文字就是框里的值。 */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/**
 * 按预算渲染：先保下全部 ref 行的空间，再按文档顺序填文本行。
 * 文档顺序不变（模型靠缩进理解结构），只是文本行先被丢弃。
 */
function renderBudgeted(entries: readonly AxLine[], budget: number): { text: string; truncated: boolean; keptRefs: number[]; kept: AxLine[]; droppedRefs: number; droppedText: number } {
  // Expand paragraphs only from spare space after every original line fits.
  // More detail must never evict an existing control, state, or source line.
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

  // 极端情况：页面可交互节点本身就超预算（巨型表格/列表）。此时连 ref 也只能按文档顺序截。
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

/**
 * 把一整棵 AX 树转成文本快照（带预算与重复文本折叠）。
 * items：ref → 它所在那一项（itemTexts），写在那一项第一个控件的行尾；只进 text，不进 body，比较前后两次读页不受影响。
 */
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

/** 按预算把几行拼成文字（变化摘要用；规则同快照：先保 ref 行）。 */
export function renderLines(entries: readonly AxLine[], budget: number): { text: string; truncated: boolean; keptRefs: number[] } {
  return renderBudgeted(entries, budget);
}

/** 整棵树按文档顺序转成行，不截断。 */
function axTreeLines(nodes: AxNodeLite[], inputs: ReadonlyMap<number, InputRangeReadout>, secret: ReadonlySet<number>, zeroSize: ReadonlyMap<number, boolean>, items: ReadonlyMap<number, ItemNote>): AxLine[] {
  const byId = new Map<string, AxNodeLite>();

  for (const n of nodes) byId.set(n.nodeId, n);
  // 一项只在它第一个控件的行尾写一次：一项的节点在文档里连成一段，后面同一项的控件紧跟在下面。
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
  // 名字是否由下面几行文字说全了（这些文字和名字不同，会各自成行）。
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
  // 沿当前路径已经说过的文字（名字/静态文本）：子节点重复同一句话时不再占一行。
  const spoken = new Map<string, number>();
  const say = (text: string): void => { spoken.set(text, (spoken.get(text) ?? 0) + 1); };

  const unsay = (text: string): void => {
    const next = (spoken.get(text) ?? 0) - 1;

    if (next > 0) spoken.set(text, next); else spoken.delete(text);
  };

  // parentFlat：父节点是零尺寸节点。
  const walk = (node: AxNodeLite, depth: number, parentFlat = false, inField = false): void => {
    const role = node.role?.value ?? "";

    if (DROP_SUBTREE_ROLES.has(role)) return;
    const zero = node.backendDOMNodeId === undefined ? undefined : zeroSize.get(node.backendDOMNodeId);
    const flatSelf = zero !== undefined;

    if (node.ignored) {
      // ignored 节点：子节点仍可能有内容（如 display:contents 容器），继续下钻
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);

        if (child) walk(child, depth, flatSelf, inField);
      }

      return;
    }

    const name = String(node.name?.value ?? "");
    // 零尺寸节点（宽或高为 0）点不到也填不进：不给 ref。有名字的留一行并标 zero-size（如勾选状态），
    // 没名字的和零尺寸文字不占行；子节点照常展开，它们有自己的盒子。
    // 零尺寸控件自己的文字（提交按钮的「Go」）也不给 ref：点它落到的是那个零尺寸控件。
    // 原生下拉框和文件框（zero 为 true）照常给 ref 并出行，只标 zero-size：对它们的动作不用坐标。
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
      // 同一个字符串在同一路径上已经出现过（父节点名字与子静态文本重复）就不再输出。
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

    // 敏感栏的子节点（输入框里的文字）就是值本身，不展开。
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

/** 控件：它们身上的字是控件名，不算“这一项”的内容。链接、单元格、行的字算（列表项的标题常是链接）。 */
const CONTROL_ROLES = new Set(["button", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio"]);

/** 同名控件超过这么多个就不找（巨型表格）。一项最多这么多个节点：再大就是页面的一大块（页眉页脚各有一个「首页」时的主体），不算一项。 */
const MAX_TWINS = 300;
const MAX_ITEM_NODES = 500;

/**
 * 列表里重复的控件各在哪一项：控件 ref → 那一项的节点（backendDOMNodeId）和从控件往上第几层开始读字；items 是认出来的全部项。
 * 只记是哪个节点、哪一层，字到用的时候再按当时的页面读。
 */
export interface RepeatedItems {
  byRef: Map<number, { item: number; from: number }>;
  items: Set<number>;
}

/**
 * 一项里最长的一段文字；控件上的字、可编辑区里的字、无障碍树里藏起来的字不算，skip（控件自己）也不算。节点太多（不是一项）返回 null。
 * 零尺寸的字（font-size:0 这类）也不算，和快照正文同一条规则：看不见的字不能拿来说是哪一项，取最长的一段时它还会盖过真正的字。
 */
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

/**
 * 页面上同角色、同名字的控件（每条笔记都有的「More」）：快照是平的，模型看不出哪个属于哪一项。
 * 每个这样的控件，往上找“只包住它自己、不包住同名另一个”的最高一层，那层有字、又不太大，就是它所在的一项。
 * 只用已经读到的无障碍树，不再进页面。
 */
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
  // 两个节点最低的共同祖先有多深；不在同一棵读到的树里（分开读的几处）返回 -1。
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
    // 按文档顺序排好，和它共同祖先最深的同名控件一定是前一个或后一个。
    group.sort((a, b) => order.get(a.nodeId)! - order.get(b.nodeId)!);

    // 每个控件最多能往上走几层（再往上就包住了同名的另一个）。
    const reach = group.map((n, i) => {
      const shared = Math.max(i > 0 ? meet(n, group[i - 1]!) : -1, i + 1 < group.length ? meet(n, group[i + 1]!) : -1);

      return shared < 0 ? 0 : depth.get(n.nodeId)! - shared - 1;
    });
    const usable = reach.filter(steps => steps > 0);

    if (!usable.length) continue;
    // 分组列表里（某一组当时只有一张卡片）最高那层是整组，不是卡片：从各控件共同能走到的层数开始，取第一个有字的那层。
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

    // 从哪一层读字：同组里这一层的字独一份，才认得出是哪一项。
    // 字都一样（头一行都是同一个作者、我的两条回复都是“谢谢”）时，只有上一层里没有别的带字的条目，才往上再比；
    // 有别的条目（旁边别人的评论），宁可不说在哪一项（from = -1），也不说成别人那条。
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

        // 一直到记下的那一项字都一样（两张都叫“Bug”）：用最下面那层，那层只是这一条自己。
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

/**
 * 这些节点里，某一项现在的字。节点里没有这一项返回 undefined；控件已经不在这一项里、太大或没有字，返回空串。
 * from：认的时候定好的“从控件往上第几层读”（同组里那一层的字各不相同）；-1 表示分不清、不说；0 表示没定过（页面上只有一个的新控件），
 * 这时取往上第一层有字的。往上碰到包住同名另一个控件的层就停（后来又加了同样的卡片），用下面那层的字。
 */
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

/** 整页快照里一个控件所在的那一项：哪个节点（同一项只写一次）、写什么字。 */
interface ItemNote {
  item: number;
  text: string;
}

/**
 * 整页快照：认出来的每个重复控件 → 它所在的那一项；分不清的不给。字从同一份节点读，规则同 itemTextOf。
 * 只给按钮、菜单项、输入框这类控件（CONTROL_ROLES）写，不给链接和表格单元格写：链接所在的“项”常常只是并排的一小串链接，
 * 字是旁边另一个链接的，写了反而误导，还占预算。
 */
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
  // 控件往上到记下的那一项为止；到不了（控件已经挪出这一项）就不给。
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

/** 控件往上碰到的第一个认得的项（只在给的这些节点里找）。 */
export function enclosingItem(nodes: readonly AxNodeLite[], ref: number, isItem: (id: number) => boolean): number | undefined {
  const byId = new Map<string, AxNodeLite>();
  let at: AxNodeLite | undefined;

  for (const n of nodes) { byId.set(n.nodeId, n); if (n.backendDOMNodeId === ref) at = n; }

  for (let hops = 0; at && hops < 64; hops++, at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (at.backendDOMNodeId !== undefined && at.backendDOMNodeId !== ref && isItem(at.backendDOMNodeId)) return at.backendDOMNodeId;
  }

  return undefined;
}
