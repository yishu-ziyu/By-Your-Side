/**
 * 侧栏怎么画回答里的卡片（解析和取数在 shared/answer-cards.ts，验收见 docs/evals/20261014-answer-cards.md）。
 * 流式时按已放出的前缀算出整段 HTML，再由 patchAnswer 按组件对比：已画出的组件节点不动，只补新出现的、刚写完的。
 * 开了头没写完的组件先占一个尺寸接近的空位；写得慢时空位里浮出很淡的占位条，写完后内容在原位淡入。
 * 按钮只做两件事：把按钮上的话当作用户的下一句发出，或切到某个标签页。不直接动页面。
 */
import { type Block, type Card, type PendingComponent, resolveProse, splitAnswer } from "../../../shared/answer-cards.js";
import { toast } from "./sonar-citations.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 内容摘要：同一位置的组件内容没变，patchAnswer 就保留原节点。 */
function digest(s: string): string {
  let h = 5381;

  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) | 0;

  return (h >>> 0).toString(36);
}

/** 给组件的最外层标签加上位置键和内容摘要。 */
const keyed = (key: string, html: string) => html.replace(/^<(\w+)/, `<$1 data-gc-key="${key}" data-gc-sig="${digest(html)}"`);

const BAR = '<i class="gc-bar"></i>';

/** 写到一半的组件的空位：结构与写完时一样，字换成占位条；已写出的可选属性（备注、说明）多占一行。 */
function placeholder(p: PendingComponent, key: string, cols: number): string {
  const has = (name: string) => new RegExp(String.raw`(?:^|\s)${name}=`).test(p.written);
  const ph = `data-gc-key="${key}" aria-hidden="true"`;

  switch (p.tag) {
    case "stat": return `<div class="gc-stat gc-ph" ${ph}><div class="k">${BAR}</div><div class="v">${BAR}</div>${has("note") || /(?:^|\s)value="=/.test(p.written) ? `<div class="n">${BAR}</div>` : ""}</div>`;
    case "step": return `<li class="gc-step gc-ph" ${ph}><span class="num"></span><div><div class="t">${BAR}</div>${has("detail") ? `<div class="d">${BAR}</div>` : ""}</div></li>`;
    case "option": return `<div class="gc-option gc-ph" ${ph}><div class="gc-row">${BAR}${has("meta") ? `<span class="meta">${BAR}</span>` : ""}</div><div class="gc-why">${BAR}</div></div>`;
    case "tr": return `<tr class="gc-ph" ${ph}>${`<td>${BAR}</td>`.repeat(cols)}</tr>`;
    case "check": return `<li class="gc-check gc-ph" ${ph}><label><span></span><span><span class="t">${BAR}</span>${has("note") ? `<span class="d">${BAR}</span>` : ""}</span></label></li>`;
    case "callout": return `<div class="gc-callout gc-ph" ${ph}>${BAR}</div>`;
    case "table": return `<div class="gc-ph gc-ph-table" ${ph}>${BAR}</div>`;
  }
}

const KIND: Record<PendingComponent["tag"], Block["kind"]> = { stat: "stats", step: "steps", option: "options", table: "table", tr: "table", check: "checks", callout: "callout" };

/** 一个块的 HTML；extra 是排在这个块末尾的空位（写到一半的同类组件）。 */
function blockHtml(b: Block, i: number, extra: string): string {
  const key = (j: number) => `b${i}.${j}`;

  switch (b.kind) {
    case "stats":
      return `<div class="gc-stats" data-gc-key="b${i}">${b.items.map((s, j) => keyed(key(j), `<div class="gc-stat${s.tag ? " best" : ""}"><div class="k"><span>${esc(s.label)}</span>${s.tag ? `<span class="tag">${esc(s.tag)}</span>` : ""}</div><div class="v">${esc(s.value)}</div><div class="n">${esc([s.note, s.formula].filter(Boolean).join(" · "))}</div></div>`)).join("")}${extra}</div>`;
    case "steps":
      return `<ol class="gc-steps" data-gc-key="b${i}">${b.items.map((s, j) => keyed(key(j), `<li class="gc-step"><span class="num">${j + 1}</span><div><div class="t">${esc(s.title)}</div>${s.detail ? `<div class="d">${esc(s.detail)}</div>` : ""}</div></li>`)).join("")}${extra}</ol>`;
    case "options":
      return `<div class="gc-options" data-gc-key="b${i}">${b.items.map((o, j) => keyed(key(j), `<div class="gc-option${o.pick ? " pick" : ""}"><div class="gc-row"><span class="name">${esc(o.name)}</span>${o.pick ? '<span class="badge">推荐</span>' : ""}${o.value ? `<span class="price">${esc(o.value)}</span>` : ""}${o.meta ? `<span class="meta">${esc(o.meta)}</span>` : ""}</div><div class="gc-why">${esc(o.why)}</div></div>`)).join("")}${extra}</div>`;
    case "table":
      return `<table class="gc-table" data-gc-key="b${i}"><thead><tr>${b.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r, j) => keyed(key(j), `<tr${r.tag ? ' class="best"' : ""}>${r.cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)).join("")}${extra}</tbody></table>`;
    case "checks":
      return `<ul class="gc-checks" data-gc-key="b${i}">${b.items.map((c, j) => keyed(key(j), `<li class="gc-check"><label><input type="checkbox"><span><span class="t">${esc(c.text)}</span>${c.note ? `<span class="d">${esc(c.note)}</span>` : ""}</span></label></li>`)).join("")}${extra}</ul>`;
    case "callout":
      return keyed(`b${i}`, `<div class="gc-callout ${b.tone}">${esc(b.text)}</div>`);
  }
}

function cardHtml(card: Card): string {
  const blocks = card.blocks.map((b, i) => {
    const p = card.pending;
    const joins = p && i === card.blocks.length - 1 && p.tag !== "table" && p.tag !== "callout" && KIND[p.tag] === b.kind;
    const items = b.kind === "table" ? b.rows.length : b.kind === "callout" ? 0 : b.items.length;

    return blockHtml(b, i, joins ? placeholder(p, `b${i}.${items}`, b.kind === "table" ? b.cols.length : 0) : "");
  });
  const p = card.pending;
  const n = card.blocks.length;

  // 写到一半的组件和上一个块不同类：在末尾另起一块放空位（表格行只跟在表格后面）。
  if (p && p.tag !== "tr" && (p.tag === "table" || p.tag === "callout" || card.blocks.at(-1)?.kind !== KIND[p.tag])) {
    const wrap = { stat: "div class=\"gc-stats\"", step: "ol class=\"gc-steps\"", option: "div class=\"gc-options\"", check: "ul class=\"gc-checks\"" } as const;

    blocks.push(p.tag === "table" || p.tag === "callout" ? placeholder(p, `b${n}`, 0) : `<${wrap[p.tag]} data-gc-key="b${n}">${placeholder(p, `b${n}.0`, 0)}</${wrap[p.tag].split(" ")[0]}>`);
  }

  const body = blocks.join("");
  // 按钮等卡片写完再出现，免得用户点到写了一半的那张。
  const buttons = card.closed ? card.buttons.map((b) => `<button type="button" class="gc-btn${b.primary ? " primary" : ""}" ${b.tab ? `data-card-tab="${esc(b.tab)}"` : `data-card-say="${esc(b.label)}"`}>${esc(b.label)}</button>`).join("") : "";

  return `<div class="gen-card">${card.title ? `<div class="gc-head"><div class="gc-title">${esc(card.title)}</div>${card.sub ? `<div class="gc-sub">${esc(card.sub)}</div>` : ""}</div>` : ""}${body ? `<div class="gc-body">${body}</div>` : ""}${buttons ? `<div class="gc-actions">${buttons}</div>` : ""}${card.source && card.closed ? `<div class="gc-foot">${esc(card.source)}</div>` : ""}</div>`;
}

/** 回答原文 → HTML。没有卡片时与原来的 Markdown 渲染一样；返回值仍需调用方消毒。 */
export function renderAnswerHtml(text: string, renderProse: (markdown: string) => string): string {
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const bold = (value: string) => `**${value}**`;

  return parts.map((p) => ("prose" in p ? (p.prose.trim() ? renderProse(resolveProse(p.prose, cards, bold)) : "") : p.card ? cardHtml(p.card) : "")).join("");
}

/** 同一位置的同一个东西：标签相同、位置键相同；写完的组件还要内容摘要相同。 */
function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;

  if (!(a instanceof Element) || !(b instanceof Element)) return true;

  return a.tagName === b.tagName && a.getAttribute("data-gc-key") === b.getAttribute("data-gc-key") && a.getAttribute("data-gc-sig") === b.getAttribute("data-gc-sig");
}

/** 新放进已有卡片的组件（写完的内容、刚出现的块）原位淡入；空位不淡入，它有自己的延迟。 */
function enter(node: Node): void {
  if (node instanceof Element && !node.classList.contains("gc-ph")) node.classList.add("gc-in");
}

/** 把 from 的属性抄到 to 上；gc-in 是本地加的淡入，留着让动画走完。 */
function syncAttributes(to: Element, from: Element): void {
  const fading = to.classList.contains("gc-in");

  for (const { name } of [...to.attributes]) if (!from.hasAttribute(name)) to.removeAttribute(name);

  for (const { name, value } of [...from.attributes]) if (to.getAttribute(name) !== value) to.setAttribute(name, value);

  if (fading) to.classList.add("gc-in");
}

/** 卡片内按位置对比：同一个就留着（写完的组件整个不碰），不同就原位换掉，多的删、少的补。 */
function syncChildren(to: Element, from: Element): void {
  const next = [...from.childNodes];

  next.forEach((node, i) => {
    const old = to.childNodes[i];

    if (!old) { enter(node); to.append(node);

 return; }

    if (!same(old, node)) { enter(node); old.replaceWith(node);

 return; }

    if (old instanceof Element && node instanceof Element) {
      if (node.hasAttribute("data-gc-sig")) return;
      syncAttributes(old, node);
      syncChildren(old, node);
    } else if (old.nodeValue !== node.nodeValue) old.nodeValue = node.nodeValue;
  });

  while (to.childNodes.length > next.length) to.lastChild!.remove();
}

/** 回答已经是最终稿（写完、被停止、被截断、历史回放）：后面不会再来字，空位不留。 */
export function dropPlaceholders(root: HTMLElement): void {
  for (const el of root.querySelectorAll(".gen-card .gc-ph")) el.remove();

  for (const el of root.querySelectorAll(".gen-card .gc-stats, .gen-card .gc-steps, .gen-card .gc-options, .gen-card .gc-checks")) if (!el.children.length) el.remove();
}

/**
 * 把一段回答的 HTML 放进 root。正文照旧整段换新；卡片按顺序对上已有的那张，只补变化的组件，
 * 已显示的组件节点不被替换，淡入、悬停、文字选择不被打断。
 */
export function patchAnswer(root: HTMLElement, html: string): void {
  const next = document.createElement("template");
  next.innerHTML = html;
  const shown = root.childNodes.length > 0;
  const kept = [...root.children].filter((el) => el.classList.contains("gen-card"));
  const want: Node[] = [];
  let k = 0;

  // 流式光标的标记每次重新算；留着的卡片里可能还有上一帧的。
  for (const el of root.querySelectorAll<HTMLElement>("[data-tail]")) delete el.dataset.tail;

  for (const node of [...next.content.childNodes]) {
    const old = node instanceof Element && node.classList.contains("gen-card") ? kept[k++] : undefined;

    if (old && node instanceof Element) {
      syncAttributes(old, node);
      syncChildren(old, node);
      want.push(old);
    } else {
      if (shown && node instanceof Element && node.classList.contains("gen-card")) enter(node);
      want.push(node);
    }
  }

  // 先删掉不再要的，再按顺序插入新的：留下的卡片在文档里不移动。
  for (const node of [...root.childNodes]) if (!want.includes(node)) node.remove();
  let at = root.firstChild;

  for (const node of want) {
    if (node === at) { at = at.nextSibling;

 continue; }
    root.insertBefore(node, at);
  }
}

/**
 * 卡片按钮：say 把按钮上的话当作用户下一句发出；tab 切到那一页。用事件委托，流式重画后不用重新绑定。
 * 只认显示的字和要发的字一样的按钮：正文里夹带的原始 HTML 做不出“看着是 A、发出去是 B”的按钮。
 */
export function bindAnswerCards(root: HTMLElement, say: (text: string) => void): void {
  root.addEventListener("click", async (event) => {
    // SAFETY: click 事件的 target 是 Element。
    const button = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-btn");

    if (!button) return;
    const label = button.textContent?.trim() ?? "";

    if (button.dataset.cardSay !== undefined) {
      if (button.dataset.cardSay === label && label) say(label);

      return;
    }
    const tabId = Number(button.dataset.cardTab);
    const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;

    if (!tab?.id) { toast("那一页已经关掉了");

 return; }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
    const win = await chrome.windows.getCurrent().catch(() => null);

    if (tab.windowId !== win?.id) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  });
}
