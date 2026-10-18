/**
 * 侧栏怎么画回答里的卡片（解析和取数在 shared/answer-cards.ts，验收见 docs/evals/20261014-answer-cards.md）。
 * 流式时按已放出的前缀算出整段 HTML，再由 patchAnswer 按组件对比：已画出的组件节点不动，只补新出现的、刚写完的。
 * 开了头没写完的组件先占一个尺寸接近的空位；写得慢时空位里浮出很淡的占位条，写完后内容在原位淡入。
 * 按钮只做两件事：把按钮上的话当作用户的下一句发出，或切到某个标签页。不直接动页面。
 * 写完的卡片若有算式或出处，右上角可翻到依据面：每个数的结果、算式、出处，同一张卡原位换面（学 Our World in Data 的图 / 表 / 出处）。
 * 结构图：整张卡写完前只放空位；写完后由 Pele 画成 SVG，点方块在图下显示模型摘的原文（cite）。
 */
import DOMPurify from "dompurify";
import { isPopout, targetWindowId } from "./target-window.js";
import { createElement as icon, LayoutGrid, Table2 } from "lucide";
import { type Block, type Card, type PendingComponent, cardEvidence, resolveProse, splitAnswer } from "../../../shared/answer-cards.js";
import { keepOpenedImages } from "../shared/answer-html.js";
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
    case "diagram": return `<div class="gc-diagram gc-ph" ${ph}>${BAR.repeat(3)}</div>`;
  }
}

const KIND: Record<PendingComponent["tag"], Block["kind"]> = { stat: "stats", step: "steps", option: "options", table: "table", tr: "table", check: "checks", callout: "callout", diagram: "diagram" };

/** 自己成一块、不和同类组件排在一起的组件：空位单独占一块。 */
const STANDALONE = new Set<PendingComponent["tag"]>(["table", "callout", "diagram"]);

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
    case "diagram": {
      const cites = Object.entries(b.cites);
      const list = cites.length ? `<ul class="gc-cites" hidden>${cites.map(([node, c]) => `<li data-node="${esc(node)}" data-from="${esc(c.from ?? "")}">${esc(c.text)}</li>`).join("")}</ul><div class="gc-diagram-hint">点方块看原文</div><div class="gc-quote" hidden><div class="gc-quote-from"></div><q></q></div>` : "";

      // 编码后再放进属性：DOMPurify 会删掉值里带「-->」的属性，而流程图的每条箭头都是 -->。
      return keyed(`b${i}`, `<div class="gc-diagram" data-diagram="${encodeURIComponent(b.source)}"><div class="gc-diagram-canvas"></div>${list}</div>`);
    }
  }
}

function cardHtml(card: Card): string {
  const blocks = card.blocks.map((b, i) => {
    const p = card.pending;
    const joins = p && i === card.blocks.length - 1 && !STANDALONE.has(p.tag) && KIND[p.tag] === b.kind;
    const items = b.kind === "table" ? b.rows.length : b.kind === "callout" || b.kind === "diagram" ? 0 : b.items.length;

    return blockHtml(b, i, joins ? placeholder(p, `b${i}.${items}`, b.kind === "table" ? b.cols.length : 0) : "");
  });
  const p = card.pending;
  const n = card.blocks.length;

  // 写到一半的组件和上一个块不同类：在末尾另起一块放空位（表格行只跟在表格后面）。
  if (p && p.tag !== "tr" && (STANDALONE.has(p.tag) || card.blocks.at(-1)?.kind !== KIND[p.tag])) {
    const wrap = { stat: "div class=\"gc-stats\"", step: "ol class=\"gc-steps\"", option: "div class=\"gc-options\"", check: "ul class=\"gc-checks\"" } as const;

    blocks.push(p.tag === "table" || p.tag === "callout" || p.tag === "diagram" ? placeholder(p, `b${n}`, 0) : `<${wrap[p.tag]} data-gc-key="b${n}">${placeholder(p, `b${n}.0`, 0)}</${wrap[p.tag].split(" ")[0]}>`);
  }

  const body = blocks.join("");
  // 按钮等卡片写完再出现，免得用户点到写了一半的那张。
  const buttons = card.closed ? card.buttons.map((b) => `<button type="button" class="gc-btn${b.primary ? " primary" : ""}" ${b.tab ? `data-card-tab="${esc(b.tab)}"` : `data-card-say="${esc(b.label)}"`}>${esc(b.label)}</button>`).join("") : "";
  // 依据面和开关也等卡片写完（cardEvidence 对没写完的卡片给空）；带位置键和摘要，流式重画不碰它们，翻开的状态和高度不丢。
  const rows = cardEvidence(card);
  // 出处多半是整张卡共用一句：合成一格，不逐行重复；「指给我看」挂在那一项的名字下面。
  const shared = rows.every((r) => r.source === rows[0]?.source);
  const sourceCell = (r: (typeof rows)[number], i: number) => (shared && i > 0 ? "" : `<td class="s"${shared ? ` rowspan="${rows.length}"` : ""}>${r.source ? esc(r.source) : "—"}</td>`);
  const evidence = rows.length ? keyed("ev", `<div class="gc-evidence" hidden><table><thead><tr><th>项</th><th>结果</th><th>怎么算</th><th>出处</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${esc(r.label)}${r.tab ? `<button type="button" class="gc-btn gc-point" data-card-tab="${esc(r.tab)}">指给我看</button>` : ""}</td><td class="r">${esc(r.value)}</td><td class="f">${r.formula ? esc(r.formula) : "—"}</td>${sourceCell(r, i)}</tr>`).join("")}</tbody></table></div>`) : "";
  const faces = rows.length ? keyed("faces", `<div class="gc-faces" role="group" aria-label="结论 / 依据">${FACE_BUTTONS}</div>`) : "";
  const head = card.title ? `<div class="gc-head${faces ? " has-faces" : ""}"><div class="gc-title">${esc(card.title)}</div>${card.sub ? `<div class="gc-sub">${esc(card.sub)}</div>` : ""}</div>` : faces ? '<div class="gc-head has-faces" data-gc-key="head"></div>' : "";

  return `<div class="gen-card">${head}${body ? `<div class="gc-body" data-gc-key="body">${body}</div>` : ""}${evidence}${buttons ? `<div class="gc-actions">${buttons}</div>` : ""}${card.source && card.closed ? `<div class="gc-foot">${esc(card.source)}</div>` : ""}${faces}</div>`;
}

const svg = (node: Parameters<typeof icon>[0]) => {
  const el = icon(node);
  el.setAttribute("width", "14");
  el.setAttribute("height", "14");
  el.setAttribute("aria-hidden", "true");

  return el.outerHTML;
};

/** 两个小图标按钮：结论（卡片原样）/ 依据（每个数的结果、算式、出处）。 */
const FACE_BUTTONS = `<button type="button" class="gc-face" data-face="answer" aria-pressed="true" title="结论" aria-label="结论">${svg(LayoutGrid)}</button><button type="button" class="gc-face" data-face="evidence" aria-pressed="false" title="依据" aria-label="依据">${svg(Table2)}</button>`;

type Engine = typeof import("./diagram-engine.js");

// 路径写成变量，esbuild 就不把 Pele 打进侧栏主包；构建产物里它是同目录下单独的 diagram-engine.js。
const ENGINE_URL = "./diagram-engine.js";

let engine: Promise<Engine> | undefined;

// SAFETY: ENGINE_URL 就是 diagram-engine.ts 的构建产物。
const loadEngine = () => (engine ??= import(ENGINE_URL) as Promise<Engine>);

/**
 * Pele 已转义图里的字、关掉了链接和图片；图的原文出自模型，可能被网页内容带偏，所以再按 SVG 白名单消毒一遍。
 * 主题靠 SVG 上的 style 传 CSS 变量，style 留着，但能发出请求的 url() 不留。
 */
function cleanSvg(svg: string): Node {
  const fragment = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true }, FORBID_TAGS: ["a", "image", "use", "foreignObject", "style"], RETURN_DOM_FRAGMENT: true });

  for (const el of fragment.querySelectorAll("[style]")) if (/url\(|@import|expression/i.test(el.getAttribute("style") ?? "")) el.removeAttribute("style");

  return fragment;
}

/** 画一张写完的结构图。画不出（语法错、不是流程图）就原样显示图的文字，不留空框。 */
async function drawDiagram(figure: HTMLElement): Promise<void> {
  figure.dataset.drawn = "";
  const canvas = figure.querySelector<HTMLElement>(":scope > .gc-diagram-canvas");
  const source = decodeURIComponent(figure.dataset.diagram ?? "");

  if (!canvas) return;
  const fail = () => {
    const pre = document.createElement("pre");
    pre.className = "gc-diagram-source";
    pre.textContent = source;
    canvas.replaceChildren(pre);

    for (const el of figure.querySelectorAll(":scope > .gc-diagram-hint, :scope > .gc-quote")) el.remove();
  };
  const cited = new Set([...figure.querySelectorAll<HTMLElement>(":scope > .gc-cites > li")].map((li) => li.dataset.node));

  try {
    const { mount } = await loadEngine();

    mount(canvas, source, {
      fontSize: 13, zoom: false, links: false, images: false, sanitize: cleanSvg, onError: fail,
      onRender: () => {
        for (const node of canvas.querySelectorAll<SVGElement>(".pele-node[data-id], .pele-cluster[data-id]")) {
          if (!cited.has(node.dataset.id)) continue;
          node.dataset.cited = "";
          node.setAttribute("tabindex", "0");
          node.setAttribute("role", "button");
        }
      },
    });
  } catch {
    fail();
  }
}

/** 点方块：图下显示这个方块的原文；再点同一个就收起。 */
function toggleCite(node: SVGElement): void {
  const figure = node.closest<HTMLElement>(".gc-diagram");
  const cite = figure && [...figure.querySelectorAll<HTMLElement>(":scope > .gc-cites > li")].find((li) => li.dataset.node === node.dataset.id);
  const quote = figure?.querySelector<HTMLElement>(":scope > .gc-quote");

  if (!figure || !cite || !quote) return;
  const again = node.classList.contains("gc-sel");

  for (const el of figure.querySelectorAll(".gc-sel")) el.classList.remove("gc-sel");
  quote.hidden = again;

  if (again) return;
  node.classList.add("gc-sel");
  quote.querySelector(".gc-quote-from")!.textContent = cite.dataset.from ? `原文 · ${cite.dataset.from}` : "原文";
  quote.querySelector("q")!.textContent = cite.textContent;
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

/** 把 from 的属性抄到 to 上；gc-in 是本地加的淡入，留着让动画走完；data-face 是用户翻到的那一面，卡片后面的正文还在写时也不翻回去。 */
function syncAttributes(to: Element, from: Element): void {
  const fading = to.classList.contains("gc-in");
  const face = to.getAttribute("data-face");

  for (const { name } of [...to.attributes]) if (!from.hasAttribute(name)) to.removeAttribute(name);

  for (const { name, value } of [...from.attributes]) if (to.getAttribute(name) !== value) to.setAttribute(name, value);

  if (fading) to.classList.add("gc-in");

  if (face && to.classList.contains("gen-card")) to.setAttribute("data-face", face);
}

/** 翻到结论或依据。依据面至少和结论面一样高，翻过去卡片不缩；翻回结论时按钮、数字都是原来的节点。 */
function showFace(card: HTMLElement, face: string): void {
  const body = card.querySelector<HTMLElement>(":scope > .gc-body");
  const evidence = card.querySelector<HTMLElement>(":scope > .gc-evidence");
  const foot = card.querySelector<HTMLElement>(":scope > .gc-foot");

  if (!evidence) return;

  // 依据面里已有出处，底部那行出处在依据面不显示，它的高度也算进来。
  if (face === "evidence" && card.dataset.face !== "evidence" && body) evidence.style.minHeight = `${body.offsetHeight + (foot?.offsetHeight ?? 0)}px`;
  card.dataset.face = face;
  evidence.hidden = face !== "evidence";

  for (const b of card.querySelectorAll<HTMLElement>(":scope > .gc-faces .gc-face")) b.setAttribute("aria-pressed", String(b.dataset.face === face));
}

/** 卡片内按位置对比：同一个就留着（写完的组件整个不碰），不同就原位换掉，多的删、少的补。 */
function syncChildren(to: Element, from: Element): void {
  const next = [...from.childNodes];

  next.forEach((node, i) => {
    const old = to.childNodes[i];

    if (!old) { enter(node); to.append(node);

 return; }

    if (!same(old, node)) {
      enter(node);
      const oldKey = old instanceof Element ? old.getAttribute("data-gc-key") : null;

      // 新东西插在前面（没有标题的卡片收尾时多出一行放开关）：原来那个后面还要，就让它往后挪，不被换掉。
      if (oldKey && next.slice(i + 1).some((n) => n instanceof Element && n.getAttribute("data-gc-key") === oldKey)) to.insertBefore(node, old);
      else old.replaceWith(node);

      return;
    }

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
  keepOpenedImages(next.content, root);
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

      // 翻到的那一面跟着最新的卡片走：依据面被换掉（内容变了）就按原来翻到的那面重放，卡片没有依据面了就回到结论。
      if (old instanceof HTMLElement && old.dataset.face) {
        if (old.querySelector(":scope > .gc-evidence")) showFace(old, old.dataset.face);
        else delete old.dataset.face;
      }
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
  // 写完的图不管从流式、重开侧栏还是切会话进来，都在出现时画一次。
  const draw = () => {
    for (const el of root.querySelectorAll<HTMLElement>(".gc-diagram:not(.gc-ph):not([data-drawn])")) void drawDiagram(el);
  };

  new MutationObserver(draw).observe(root, { childList: true, subtree: true });
  draw();
  root.addEventListener("keydown", (event) => {
    // SAFETY: keydown 事件的 target 是 Element。
    const node = (event.target as Element).closest<SVGElement>(".gc-diagram [data-cited]");

    if (!node || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleCite(node);
  });
  root.addEventListener("click", async (event) => {
    // SAFETY: click 事件的 target 是 Element。
    const node = (event.target as Element).closest<SVGElement>(".gc-diagram [data-cited]");

    if (node) { toggleCite(node);

 return; }
    // SAFETY: click 事件的 target 是 Element。
    const face = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-face");
    const card = face?.closest<HTMLElement>(".gen-card");

    if (face && card) { showFace(card, face.dataset.face ?? "answer");

 return; }
    // SAFETY: 同上。
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
    const targetWindow = await targetWindowId();

    // 在会话小窗口里点：标签页所在的浏览器窗口可能压在后面，要提到前面才看得见。
    if (tab.windowId !== targetWindow || isPopout) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  });
}
