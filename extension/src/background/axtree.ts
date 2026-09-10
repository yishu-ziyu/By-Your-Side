/**
 * CDP Accessibility 树 → 文本快照的纯转换层。
 * 不碰 chrome.* API，vitest 可直接覆盖。
 *
 * 输出格式（与 ego-browser 的 snapshotText 约定对齐）：
 *   [ref=N] role "name" key=value...   —— ref 直接是 backendDOMNodeId，跨快照保号
 *   text: 静态文本
 * 树形缩进两个空格一层；ignored/无信息节点折叠（自身不出行，子节点提升）。
 */

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
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
}

/**
 * 输出字符预算。ego 的做法是不截断（380KB 照吐，靠 scope 控范围）；
 * 我们要照顾 LLM 上下文：24K 字符约 6k token，已覆盖一页复杂站点的主要交互区。
 * 超预算时优先保留可交互/可引用行（ref），先丢纯文本行，见 renderBudgeted。
 */
export const MAX_OUTPUT_CHARS = 24_000;
const MAX_LINE_TEXT = 200;
const MAX_NAME = 60;

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

/** 整棵子树丢弃的角色。 */
const DROP_SUBTREE_ROLES = new Set(["InlineTextBox", "LineBreak"]);

/** 自身不出行但子节点提升的角色。 */
const COLLAPSE_ROLES = new Set(["generic", "none", "presentation", "Ignored"]);

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
function describe(node: AxNodeLite): string | null {
  const role = node.role?.value ?? "";
  if (DROP_SUBTREE_ROLES.has(role)) return null;
  const name = node.name?.value ?? "";

  if (role === "StaticText") {
    return name ? `text: ${clip(name, MAX_LINE_TEXT)}` : null;
  }
  if (COLLAPSE_ROLES.has(role)) return null;
  if (!name && !REF_ROLES.has(role) && role !== "img" && role !== "iframe") {
    // 无名非交互节点没信息量（容器、装饰），折叠
    return null;
  }

  const parts: string[] = [role];
  if (name) parts.push(`"${clip(name, MAX_NAME)}"`);
  const value = node.value?.value;
  if (value !== undefined && value !== null && value !== "") parts.push(`value=${JSON.stringify(clip(String(value), MAX_NAME))}`);
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

export interface AxTextResult {
  text: string;
  /** 本次快照输出的全部 ref（backendDOMNodeId），调用方记录供 click/fill 校验。 */
  backendIds: number[];
  truncated: boolean;
}

interface AxLine {
  text: string;
  /** 可交互/可引用（ref）行：超预算时不会被丢。 */
  interactive: boolean;
  ref?: number;
}

/**
 * 按预算渲染：先保下全部 ref 行的空间，再按文档顺序填文本行。
 * 文档顺序不变（模型靠缩进理解结构），只是文本行先被丢弃。
 */
function renderBudgeted(entries: readonly AxLine[], budget: number): { text: string; truncated: boolean; keptRefs: number[] } {
  const interactiveCost = entries.reduce((sum, entry) => sum + (entry.interactive ? entry.text.length + 1 : 0), 0);
  // 极端情况：页面可交互节点本身就超预算（巨型表格/列表）。此时连 ref 也只能按文档顺序截。
  if (interactiveCost > budget) {
    const kept: string[] = [];
    const keptRefs: number[] = [];
    let used = 0;
    let cut = false;
    for (const entry of entries) {
      const cost = entry.text.length + 1;
      if (used + cost > budget) { cut = true; continue; }
      used += cost;
      kept.push(entry.text);
      if (entry.ref !== undefined) keptRefs.push(entry.ref);
    }
    return { text: kept.join("\n"), truncated: cut, keptRefs };
  }
  let left = budget - interactiveCost;
  const kept: string[] = [];
  const keptRefs: number[] = [];
  let dropped = false;
  for (const entry of entries) {
    if (entry.interactive) {
      kept.push(entry.text);
      if (entry.ref !== undefined) keptRefs.push(entry.ref);
      continue;
    }
    if (entry.text.length + 1 > left) { dropped = true; continue; }
    left -= entry.text.length + 1;
    kept.push(entry.text);
  }
  return { text: kept.join("\n"), truncated: dropped, keptRefs };
}

/** 把一整棵 AX 树转成文本快照（带预算与重复文本折叠）。 */
export function axTreeToText(nodes: AxNodeLite[], budget: number = MAX_OUTPUT_CHARS): AxTextResult {
  const byId = new Map<string, AxNodeLite>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  const entries: AxLine[] = [];
  // 沿当前路径已经说过的文字（名字/静态文本）：子节点重复同一句话时不再占一行。
  const spoken = new Map<string, number>();
  const say = (text: string): void => { spoken.set(text, (spoken.get(text) ?? 0) + 1); };
  const unsay = (text: string): void => {
    const next = (spoken.get(text) ?? 0) - 1;
    if (next > 0) spoken.set(text, next); else spoken.delete(text);
  };

  const walk = (node: AxNodeLite, depth: number): void => {
    const role = node.role?.value ?? "";
    if (DROP_SUBTREE_ROLES.has(role)) return;
    if (node.ignored) {
      // ignored 节点：子节点仍可能有内容（如 display:contents 容器），继续下钻
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) walk(child, depth);
      }
      return;
    }

    const described = describe(node);
    const name = String(node.name?.value ?? "");
    const textPayload = staticTextOf(node);
    let childDepth = depth;
    const words: string[] = [];
    if (described !== null) {
      const backendId = node.backendDOMNodeId;
      const hasRef = backendId !== undefined && role !== "RootWebArea" && role !== "WebArea";
      // 同一个字符串在同一路径上已经出现过（父节点名字与子静态文本重复）就不再输出。
      const repeatedText = textPayload !== null && textPayload.length > 0 && (spoken.get(textPayload) ?? 0) > 0;
      if (!repeatedText) {
        const prefix = hasRef ? `[ref=${backendId}] ` : "";
        entries.push({ text: `${"  ".repeat(depth)}${prefix}${described}`, interactive: hasRef, ...(hasRef ? { ref: backendId } : {}) });
        if (name) { say(name); words.push(name); }
        if (textPayload && textPayload !== name) { say(textPayload); words.push(textPayload); }
        childDepth = depth + 1;
      } else {
        childDepth = depth;
      }
    }

    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) walk(child, childDepth);
    }
    for (const word of words) unsay(word);
  };

  for (const root of roots) walk(root, 0);

  const { text, truncated, keptRefs } = renderBudgeted(entries, budget);
  const finalText = truncated
    ? `${text}\n... [truncated，优先保住了全部可交互 ref；文本行超出 ${budget} 字符预算。有效恢复方式：先滚动目标进入视口再 snapshot(scope=viewport)，或用 read_element / js 精确提取]`
    : text;
  return { text: finalText, backendIds: keptRefs, truncated };
}
