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
 * 我们要照顾 LLM 上下文，取平衡值 50K（约一页复杂站点的主要交互区）。
 */
export const MAX_OUTPUT_CHARS = 50_000;
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

/** 把一整棵 AX 树转成文本快照。 */
export function axTreeToText(nodes: AxNodeLite[]): AxTextResult {
  const byId = new Map<string, AxNodeLite>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  const lines: string[] = [];
  const backendIds: number[] = [];
  let totalChars = 0;
  let truncated = false;

  const walk = (node: AxNodeLite, depth: number): void => {
    if (truncated) return;
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

    const line = describe(node);
    let childDepth = depth;
    if (line !== null) {
      let prefix = "";
      const backendId = node.backendDOMNodeId;
      if (backendId !== undefined && REF_ROLES.has(node.role?.value ?? "")) {
        prefix = `[ref=${backendId}] `;
        backendIds.push(backendId);
      }
      totalChars += line.length + prefix.length + 1;
      if (totalChars > MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      lines.push(`${"  ".repeat(depth)}${prefix}${line}`);
      childDepth = depth + 1;
    }

    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) walk(child, childDepth);
    }
  };

  for (const root of roots) walk(root, 0);

  if (truncated) {
    lines.push(`... [truncated，输出超过 ${MAX_OUTPUT_CHARS} 字符，请用 js 工具精确提取或先滚动到目标区域再 snapshot]`);
  }
  return { text: lines.join("\n"), backendIds, truncated };
}
