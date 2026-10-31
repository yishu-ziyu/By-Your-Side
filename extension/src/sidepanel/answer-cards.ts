import { resolveDiagramCite, type AnswerSourceMap } from "../../../shared/answer-source.js";
import { withEvidence } from "./answer-evidence.js";
/**
 * 侧栏怎么画回答里的卡片（解析和取数在 shared/answer-cards.ts，
 * 流式时按已放出的前缀算出整段 HTML，再由 patchAnswer 按组件对比：已画出的组件节点不动，只补新出现的、刚写完的。
 * 开了头没写完的组件先占一个尺寸接近的空位；写得慢时空位里浮出很淡的占位条，写完后内容在原位淡入。
 * 按钮只做两件事：把按钮上的话当作用户的下一句发出，或切到某个标签页。不直接动页面。
 * 写完的卡片若有算式或出处，右上角可翻到依据面：每个数的结果、算式、出处，同一张卡原位换面（学 Our World in Data 的图 / 表 / 出处）。
 * 结构图：整张卡写完前只放空位；写完后由 Pele 画成 SVG，点方块在图下显示模型摘的原文（cite）。
 * 可调的数：用户改数时只在侧栏按 data-gc-expr 重算，不问模型；调过的数、勾过的项按卡片原文摘要存起来，重开侧栏还原。
 */
import DOMPurify from "dompurify";
import { isPopout, targetWindowId } from "./target-window.js";
import { createElement as icon, LayoutGrid, Table2 } from "lucide";
import { type Block, type Card, type CardField, type CardInput, type Cell, type RowSource, type PendingComponent, cardEvidence, evaluate, fillRefs, resolveProse, showFormula, showValue, splitAnswer } from "../../../shared/answer-cards.js";
import { keepOpenedImages } from "../shared/answer-html.js";
import { captureCitationContext, clearFailure, noteFailure } from "./sonar-citations.js";
import { isMiniAppsOn, MINI_APPS_KEY } from "../shared/mini-apps.js";
import { isPageElementSource, type PageElementSource } from "../../../shared/protocol.js";

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

/** 跟着可调的数重算的值：算式和单位放在属性上，侧栏改数时按它重算。 */
const live = (c: { expr?: string; unit?: string }) => (c.expr ? ` data-gc-expr="${esc(c.expr)}" data-gc-unit="${esc(c.unit ?? "")}"` : "");

/** 跟着可调的数重算的算式说明。 */
const formulaHtml = (formula: string, expr?: string) => (expr ? `<span data-gc-formula="${esc(expr)}">${esc(formula)}</span>` : esc(formula));

/** 这一行出自哪个标签页、去找哪个数：写完后侧栏到那一页去找，找到唯一一处才变成可点（linkRows）。 */
const fromAttrs = (from?: RowSource) => (from ? ` data-gc-tab="${esc(from.tab)}" data-gc-find="${esc(from.find)}"` : "");

const cellHtml = (c: Cell, tag: string, cls = "") => `<${tag}${cls}${live(c)}>${esc(c.value)}</${tag}>`;

/** 模型原样写的数和程序算出的数写法对齐：带货币符号的金额加千分位；不带符号的只有整格就是一个 5–10 位的数（可带常见单位）才加，
 *  电话、单号这类长串、夹在文字里的数和 4 位的年份不动。只改显示。 */
const tidyNumber = (text: string) => text
  .replace(/([¥$€£]\s?)([1-9]\d{3,14})(?![\d,])/g, (_, sign: string, digits: string) => sign + Number(digits).toLocaleString("zh-CN"))
  .replace(/^([1-9]\d{4,9})(?=(?:\.\d+)?\s*(?:[元万亿人个次件份台%]|km|kg)?$)/, (digits: string) => Number(digits).toLocaleString("zh-CN"));

/** 数字格里放不下一格的长数：这一组改成每格一行，不再切掉或贴边。 */
const WIDE_STAT = 10;
const wideStats = (values: string[]) => values.some((v) => v.length > WIDE_STAT);

/** 档位多于这个数时，加减之外再给一条滑块。 */
const SLIDER_STEPS = 20;

/** 问用户的一栏：有选项就是一排可点的选项，没有就是文字框；预填值的出处写在名字旁。 */
function fieldHtml(f: CardField): string {
  const head = `<div class="gc-field-head"><span class="k">${esc(f.label)}</span>${f.from ? `<span class="from">· ${esc(f.from)}</span>` : ""}<span class="gc-missing-note">还没填</span></div>`;
  const control = f.options
    ? `<div class="gc-chips" role="radiogroup" aria-label="${esc(f.label)}">${f.options.map((o) => `<button type="button" class="gc-chip" role="radio" aria-checked="${o === f.value}" data-gc-option="${esc(o)}">${esc(o)}</button>`).join("")}</div>`
    : `<input type="text" class="gc-text" value="${esc(f.value)}" aria-label="${esc(f.label)}">`;

  return `<div class="gc-field" data-gc-field="${esc(f.id)}" data-gc-label="${esc(f.label)}"${f.required ? " data-gc-required" : ""}>${head}${control}</div>`;
}

function inputHtml(v: CardInput): string {
  const range = `min="${v.min}" max="${v.max}" step="${v.step}" value="${v.value}" data-gc-var="${esc(v.id)}"`;
  const slider = (v.max - v.min) / v.step > SLIDER_STEPS ? `<input type="range" class="gc-range" ${range} aria-label="${esc(v.label)}">` : "";

  return `<div class="gc-input"><span class="k">${esc(v.label)}</span><span class="gc-stepper"><button type="button" class="gc-bump" data-gc-bump="-1" aria-label="减少${esc(v.label)}">−</button><input type="number" class="gc-num" inputmode="decimal" ${range} data-gc-unit="${esc(v.unit ?? "")}" aria-label="${esc(v.label)}">${v.unit ? `<span class="u">${esc(v.unit)}</span>` : ""}<button type="button" class="gc-bump" data-gc-bump="1" aria-label="增加${esc(v.label)}">+</button></span>${slider}</div>`;
}

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

/** 卡片里的说明文字：{=名字} 换成跟着可调值重算的数（recompute 按 data-gc-ref 改写）。 */
const textHtml = (text: string, values: ReadonlyMap<string, string>) => fillRefs(esc(text), values, (v, id) => `<span data-gc-ref="${esc(id)}">${esc(v)}</span>`, "…");

/** 一个块的 HTML；extra 是排在这个块末尾的空位（写到一半的同类组件）。 */
function blockHtml(b: Block, i: number, extra: string, values: ReadonlyMap<string, string>, sources?: AnswerSourceMap): string {
  const key = (j: number) => `b${i}.${j}`;
  const t = (text: string) => textHtml(text, values);

  switch (b.kind) {
    case "fields":
      return `<div class="gc-fields" data-gc-key="b${i}">${b.items.map((f, j) => keyed(key(j), fieldHtml(f))).join("")}${extra}</div>`;
    case "app":
      return "";
    case "inputs":
      return `<div class="gc-inputs" data-gc-key="b${i}">${b.items.map((v, j) => keyed(key(j), inputHtml(v))).join("")}</div>`;
    case "stats":
      return `<div class="gc-stats${wideStats(b.items.map((s) => tidyNumber(s.value))) ? " wide" : ""}" data-gc-key="b${i}">${b.items.map((s, j) => keyed(key(j), `<div class="gc-stat${s.tag ? " best" : ""}"${fromAttrs(s.from)}><div class="k"><span>${t(s.label)}</span>${s.tag ? `<span class="tag">${esc(s.tag)}</span>` : ""}</div><div class="v"${live(s)}${s.id && s.expr ? ` data-gc-id="${esc(s.id)}"` : ""}>${esc(tidyNumber(s.value))}</div><div class="n">${[s.note && t(s.note), s.formula && formulaHtml(s.formula, s.expr)].filter(Boolean).join(" · ")}</div></div>`)).join("")}${extra}</div>`;
    case "steps":
      return `<ol class="gc-steps" data-gc-key="b${i}">${b.items.map((s, j) => keyed(key(j), `<li class="gc-step"><span class="num">${j + 1}</span><div><div class="t">${t(s.title)}</div>${s.detail ? `<div class="d">${t(s.detail)}</div>` : ""}</div></li>`)).join("")}${extra}</ol>`;
    case "options":
      return `<div class="gc-options" data-gc-key="b${i}">${b.items.map((o, j) => keyed(key(j), `<div class="gc-option${o.pick ? " pick" : ""}"${fromAttrs(o.from)}><div class="gc-row"><span class="name">${t(o.name)}</span>${o.pick ? '<span class="badge">推荐</span>' : ""}${o.value ? cellHtml({ ...o.value, value: tidyNumber(o.value.value) }, "span", ' class="price"') : ""}${o.meta ? `<span class="meta">${t(o.meta)}</span>` : ""}</div><div class="gc-why">${t(o.why)}</div></div>`)).join("")}${extra}</div>`;
    case "table":
      return `<table class="gc-table" data-gc-key="b${i}"><thead><tr>${b.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r, j) => keyed(key(j), `<tr${r.tag ? ' class="best"' : ""}${fromAttrs(r.from)}>${r.cells.map((c) => cellHtml(c, "td")).join("")}</tr>`)).join("")}${extra}</tbody></table>`;
    case "checks":
      return `<ul class="gc-checks" data-gc-key="b${i}">${b.items.map((c, j) => keyed(key(j), `<li class="gc-check"><label><input type="checkbox"><span><span class="t">${t(c.text)}</span>${c.note ? `<span class="d">${t(c.note)}</span>` : ""}</span></label></li>`)).join("")}${extra}</ul>`;
    case "callout":
      return keyed(`b${i}`, `<div class="gc-callout ${b.tone}">${t(b.text)}</div>`);
    case "diagram": {
      const cites = Object.entries(b.cites).flatMap(([node, cite]) => { const value = resolveDiagramCite(cite, sources); return value ? [[node, value] as const] : []; });
      const missing = Object.keys(b.cites).length - cites.length;
      const list = cites.length ? `<ul class="gc-cites" hidden>${cites.map(([node, c]) => `<li data-node="${esc(node)}" data-from="${esc(c.from ?? "")}" data-source-url="${esc(c.url ?? "")}">${esc(c.text)}</li>`).join("")}</ul><div class="gc-diagram-hint">点方块看原文</div><div class="gc-quote" hidden><div class="gc-quote-from"></div><q></q>${cites.some(([, c]) => c.url) ? '<div><a class="gc-source-link" hidden target="_blank" rel="noopener noreferrer">查看原文</a></div>' : ""}</div>` : "";

      // 编码后再放进属性：DOMPurify 会删掉值里带「-->」的属性，而流程图的每条箭头都是 -->。
      return keyed(`b${i}`, `<div class="gc-diagram" data-diagram="${encodeURIComponent(b.source)}"><div class="gc-diagram-canvas"></div>${list}${missing ? `<div class="gc-diagram-hint">有 ${missing} 处来源未能核对</div>` : ""}</div>`);
    }
  }
}

/**
 * 小程序卡：写完前只放一块“正在写小程序”的空位；写完后放一个空框，mountApp 再把沙箱 iframe 放进去（实验功能开着时）。
 * 程序原文编码后放在属性上，和结构图同理：原文里什么字都可能有。
 */
function appCardHtml(card: Card, app: Extract<Block, { kind: "app" }>): string {
  const head = `<div class="gc-app-head"><span class="gc-app-title">${esc(app.title)}</span><span class="gc-app-note">助手写的小程序 · 不联网</span></div>`;

  if (!card.closed) return `<div class="gen-card gen-app-card">${keyed("app", `<div class="gc-app gc-ph" aria-hidden="true">${head}<div class="gc-app-wait">${BAR}<span>正在写小程序…</span></div></div>`)}</div>`;

  return `<div class="gen-card gen-app-card" data-gc-card="${card.key}">${keyed("app", `<div class="gc-app" data-app="${encodeURIComponent(app.html)}" data-app-title="${esc(app.title)}">${head}<div class="gc-app-frame"></div><div class="gc-app-bar" hidden></div></div>`)}</div>`;
}

function cardHtml(card: Card, sources?: AnswerSourceMap): string {
  const app = card.blocks[0]?.kind === "app" ? card.blocks[0] : undefined;

  if (app) return appCardHtml(card, app);
  const blocks = card.blocks.map((b, i) => {
    const p = card.pending;
    const joins = p && i === card.blocks.length - 1 && !STANDALONE.has(p.tag) && KIND[p.tag] === b.kind;
    const items = b.kind === "table" ? b.rows.length : b.kind === "callout" || b.kind === "diagram" || b.kind === "app" ? 0 : b.items.length;

    return blockHtml(b, i, joins ? placeholder(p, `b${i}.${items}`, b.kind === "table" ? b.cols.length : 0) : "", card.values, sources);
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
  const buttons = card.closed ? card.buttons.map((b) => `<button type="button" class="gc-btn${b.primary ? " primary" : ""}" ${b.tab ? `data-card-tab="${esc(b.tab)}"` : b.submit ? `data-card-submit="${esc(b.label)}"` : `data-card-say="${esc(b.label)}"`}>${esc(b.label)}</button>`).join("") : "";
  // 依据面和开关也等卡片写完（cardEvidence 对没写完的卡片给空）；带位置键和摘要，流式重画不碰它们，翻开的状态和高度不丢。
  const rows = cardEvidence(card);
  // 出处多半是整张卡共用一句：合成一格，不逐行重复；「指给我看」挂在那一项的名字下面。
  const shared = rows.every((r) => r.source === rows[0]?.source);
  const sourceCell = (r: (typeof rows)[number], i: number) => (shared && i > 0 ? "" : `<td class="s"${shared ? ` rowspan="${rows.length}"` : ""}>${r.source ? esc(r.source) : "—"}</td>`);
  const evidence = rows.length ? keyed("ev", `<div class="gc-evidence" hidden><table><thead><tr><th>项</th><th>结果</th><th>怎么算</th><th>出处</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${textHtml(r.label, card.values)}${r.tab ? `<button type="button" class="gc-btn gc-point" data-card-tab="${esc(r.tab)}">指给我看</button>` : ""}</td>${cellHtml(r, "td", ' class="r"')}<td class="f">${r.formula ? formulaHtml(r.formula, r.expr) : "—"}</td>${sourceCell(r, i)}</tr>`).join("")}</tbody></table></div>`) : "";
  const faces = rows.length ? keyed("faces", `<div class="gc-faces" role="group" aria-label="结论 / 依据">${FACE_BUTTONS}</div>`) : "";
  const head = card.title ? `<div class="gc-head${faces ? " has-faces" : ""}"><div class="gc-title">${textHtml(card.title, card.values)}</div>${card.sub ? `<div class="gc-sub">${textHtml(card.sub, card.values)}</div>` : ""}</div>` : faces ? '<div class="gc-head has-faces" data-gc-key="head"></div>' : "";

  // 只有写完的卡片带状态键：写到一半时原文还在变，摘要也跟着变。
  return `<div class="gen-card"${card.closed ? ` data-gc-card="${card.key}"` : ""}>${head}${body ? `<div class="gc-body" data-gc-key="body">${body}</div>` : ""}${evidence}${buttons ? `<div class="gc-actions">${buttons}</div>` : ""}${card.source && card.closed ? `<div class="gc-foot">${esc(card.source)}</div>` : ""}${faces}</div>`;
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

// 路径写成变量，esbuild 就不把 Pele 打进侧栏主包；构建产物里它们是同目录下单独的 diagram-engine.js 和 diagram-engine-more.js。
const ENGINE_URL = { flow: "./diagram-engine.js", more: "./diagram-engine-more.js" };

const engines: Partial<Record<keyof typeof ENGINE_URL, Promise<Engine>>> = {};

/** 流程图只加载小包；别的图种才加载另一包。两包各带一份 Pele 核心，导出的形状一样。 */
// SAFETY: ENGINE_URL 里就是 diagram-engine.ts、diagram-engine-more.ts 的构建产物，导出同样的 mount、render。
const loadEngine = (kind: keyof typeof ENGINE_URL) => (engines[kind] ??= import(ENGINE_URL[kind]) as Promise<Engine>);

/**
 * Pele 已转义图里的字、关掉了链接和图片；图的原文出自模型，可能被网页内容带偏，所以再按 SVG 白名单消毒一遍。
 * 主题靠 SVG 上的 style 传 CSS 变量，style 留着，但能发出请求的 url() 不留。
 */
function cleanSvg(svg: string): Node {
  const fragment = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true }, FORBID_TAGS: ["a", "image", "use", "foreignObject", "style"], RETURN_DOM_FRAGMENT: true });

  for (const el of fragment.querySelectorAll("[style]")) if (/url\(|@import|expression/i.test(el.getAttribute("style") ?? "")) el.removeAttribute("style");

  return fragment;
}

/** 图最多缩到这个比例（13px 的字不小于 11px）；还放不下就按这个比例显示、左右滑动看全。 */
const MIN_SCALE = 0.85;

/** 方块文字每行大约几个汉字宽。Pele 不给模型写的长文字自动断行，一行太长整张图就宽得放不进侧栏。 */
const LINE_UNITS = 8;

/** 引号里的方块文字按宽度断行：汉字算 1，其他字算 0.55；英文只在空格处断。 */
function wrapLabels(source: string): string {
  const wrapLine = (line: string) => {
    let out = "";
    let width = 0;

    for (const ch of line) {
      const wide = /[\u2e80-\uffef]/.test(ch);

      if (width >= LINE_UNITS && (wide || ch === " ")) {
        out += "<br/>";
        width = 0;

        if (ch === " ") continue;
      }
      out += ch;
      width += wide ? 1 : 0.55;
    }

    return out;
  };

  return source.replace(/([[{(])"([^"\n]+)"([\]})])/g, (_all, open: string, text: string, close: string) => `${open}"${text.split(/<br\s*\/?>/i).map(wrapLine).join("<br/>")}"${close}`);
}

/** 上下排和左右排各排一次，取窄的那个：分支多的图左右排常常窄一半。 */
function narrower(source: string, render: Engine["render"]): string {
  const at = diagramStart(source);
  const flipped = source.slice(0, at) + source.slice(at).replace(/^((?:flowchart|graph)\s+)(TB|TD|LR)\b/, (_all, head: string, dir: string) => head + (dir === "LR" ? "TB" : "LR"));

  try {
    return flipped !== source && render(flipped, { fontSize: 13 }).width < render(source, { fontSize: 13 }).width ? flipped : source;
  } catch {
    return source;
  }
}

/** 按图的原始宽度和现在的框宽决定缩还是滑。侧栏拖宽拖窄时 Pele 不重排流程图、也不回调，所以自己跟着框宽算。 */
function fit(canvas: HTMLElement): void {
  const natural = Number(canvas.dataset.natural);

  if (!natural) return;
  const wide = natural * MIN_SCALE > canvas.clientWidth;

  canvas.classList.toggle("gc-diagram-wide", wide);
  canvas.querySelector("svg")?.style.setProperty("width", wide ? `${Math.round(natural * MIN_SCALE)}px` : "");
}

const fitter = new ResizeObserver((entries) => {
  // SAFETY: 只 observe 过 .gc-diagram-canvas 这个 HTMLElement。
  for (const entry of entries) fit(entry.target as HTMLElement);
});

/** 画在页面上的图：Pele 每张图挂一个 ResizeObserver，图离开页面（切会话、清空）时要 destroy 掉。 */
const mounted = new Map<HTMLElement, { destroy(): void }>();

function releaseDiagrams(): void {
  for (const [figure, m] of mounted) {
    if (figure.isConnected) continue;
    m.destroy();

    for (const canvas of figure.querySelectorAll(".gc-diagram-canvas")) fitter.unobserve(canvas);
    mounted.delete(figure);
  }
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
    // 断行和换横竖排都按流程图的语法改写，别的图种原样画。
    const kind = diagramKind(source);
    const flow = kind === "flowchart" || kind === "graph";
    figure.dataset.kind = kind;
    const { mount, render } = await loadEngine(flow ? "flow" : "more");

    // 等加载的这会儿图可能已经被换掉了。
    if (!figure.isConnected) return;
    mounted.set(figure, mount(canvas, flow ? narrower(wrapLabels(source), render) : source, {
      fontSize: 13, zoom: false, links: false, images: false, sanitize: cleanSvg, onError: fail,
      onRender: (result) => {
        canvas.dataset.natural = String(result.width);
        fit(canvas);

        for (const node of canvas.querySelectorAll<SVGElement>(".pele-node[data-id], .pele-cluster[data-id]")) {
          if (!cited.has(node.dataset.id)) continue;
          node.dataset.cited = "";
          node.setAttribute("tabindex", "0");
          node.setAttribute("role", "button");
        }
      },
    }));
    fitter.observe(canvas);
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
  const link = quote.querySelector<HTMLAnchorElement>(".gc-source-link");
  if (link) {
    link.hidden = !cite.dataset.sourceUrl;
    if (cite.dataset.sourceUrl) link.href = cite.dataset.sourceUrl;
    else link.removeAttribute("href");
  }
}

/** 回答原文 → HTML。没有卡片时与原来的 Markdown 渲染一样；返回值仍需调用方消毒。 */
export function renderAnswerHtml(text: string, renderProse: (markdown: string) => string, sources?: AnswerSourceMap): string {
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  // 正文先按 Markdown 渲染、消毒，消毒会删掉属性；先用标记包住 {=名字} 换成的数，渲染后再换成带名字的加粗，改数时能找到它。
  // 标记里带每次渲染新取的随机串：模型写的字（包括 &#xE000; 这类实体）猜不到它，仿造不出这个加粗。
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const bold = (value: string, id: string) => `**\uE000${nonce}${id}\uE001${value}\uE002**`;
  const ref = new RegExp(`\uE000${nonce}([A-Za-z_][\\w-]*)\uE001([^\uE002<]*)\uE002`, "g");
  const refs = (html: string) => html.replace(ref, (_all, id: string, value: string) => `<span data-gc-ref="${esc(id)}">${value}</span>`);

  const counter = { n: 0 };

  return parts.map((p) => {
    if (!("prose" in p)) return p.card ? cardHtml(p.card, sources) : "";
    if (!p.prose.trim()) return "";
    const evidence = withEvidence(resolveProse(p.prose, cards, bold), sources, nonce, counter);
    return evidence.finish(refs(withMermaidDiagrams(evidence.prose, renderProse)));
  }).join("");
}

/** 写完的 ```mermaid 代码块。 */
const MERMAID_FENCE = /^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;
/** 侧栏画得出的图种：和 diagram-engine.ts、diagram-engine-more.ts 注册的一一对应。 */
const DRAWABLE = new Set(["flowchart", "graph", "timeline", "sequenceDiagram", "mindmap", "pie", "gantt", "stateDiagram", "stateDiagram-v2", "classDiagram", "erDiagram", "journey", "quadrantChart", "xychart", "xychart-beta"]);

/** 图的第一个关键字从哪开始：开头的 --- 配置头、%% 注释、%%{…}%% 指令（可以跨行）和空行都不算图。 */
function diagramStart(source: string): number {
  let at = 0;
  const skip = (pattern: RegExp) => {
    const match = pattern.exec(source.slice(at));
    if (match) at += match[0].length;
    return !!match;
  };

  skip(/^\s*---[^\S\n]*\r?\n[\s\S]*?\r?\n[^\S\n]*---[^\S\n]*(?=\r?\n|$)/);
  while (skip(/^\s+/) || skip(/^%%\{[\s\S]*?\}%%/) || skip(/^%%[^\n]*/));

  return at;
}

const diagramKind = (source: string) => /^[A-Za-z-]+/.exec(source.slice(diagramStart(source)))?.[0] ?? "";

/**
 * 模型把结构图写成 ```mermaid 代码块时，用户看到的是一段代码，不是图：照卡片里的结构图画出来，代码收在下面，要复制还在。
 * 代码块先换成占位段落，正文按 Markdown 渲染后再换回图和折起来的代码。
 */
function withMermaidDiagrams(prose: string, renderProse: (markdown: string) => string, sources?: AnswerSourceMap): string {
  const blocks: string[] = [];
  const marked = prose.replace(MERMAID_FENCE, (fence: string, source: string) => {
    if (!DRAWABLE.has(diagramKind(source))) return fence;
    blocks.push(`<div class="gc-diagram" data-diagram="${encodeURIComponent(source)}"><div class="gc-diagram-canvas"></div></div><details class="gc-diagram-code"><summary>Mermaid 代码</summary>${renderProse(fence)}</details>`);

    return `\n\n\uE010${blocks.length - 1}\uE011\n\n`;
  });

  if (!blocks.length) return renderProse(prose);

  return renderProse(marked).replace(/<p>\uE010(\d+)\uE011<\/p>/g, (_all, i: string) => blocks[Number(i)] ?? "");
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
  const kept = [...root.children].filter((el) => el.classList.contains("gen-card") && !el.classList.contains("send-declined-card"));
  const trailing = [...root.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.matches(".answer-actions, .answer-panel, .send-declined-card"));
  const memoryCite = root.querySelector<HTMLElement>(":scope > .memory-used-cite-row > .memory-used-toggle, :scope > * > .memory-used-toggle");
  const memoryLine = root.querySelector<HTMLElement>(":scope > .memory-used-line");
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

  // 重画会把发送按钮的字和能不能点抄回模型写的样子，按表单现在的状态再定一次。
  for (const card of kept) if (card instanceof HTMLElement && card.querySelector(".gc-field")) refreshForm(card);

  // 先删掉不再要的正文节点（保留尾部操作栏与拒绝发送卡），再按顺序插入新的：留下的卡片在文档里不移动。
  for (const node of [...root.childNodes]) {
    if (!want.includes(node) && !(node instanceof HTMLElement && trailing.includes(node))) node.remove();
  }
  const tailAnchor = trailing[0] ?? null;
  let at: ChildNode | null = root.firstChild;

  for (const node of want) {
    if (at && at instanceof HTMLElement && trailing.includes(at)) at = tailAnchor;
    if (node === at) { at = at.nextSibling; continue; }
    root.insertBefore(node, at ?? tailAnchor);
  }

  // 若重画前挂着「用了 N 条记忆 ›」引用按钮与展开条，重画正文后原地保留在首段，无需外层再手动搬回。
  if (memoryCite && memoryLine) {
    const first = [...root.children].find(el => !trailing.includes(el as HTMLElement));
    let head: HTMLElement;
    if (first instanceof HTMLElement && /^(P|H[1-6])$/.test(first.tagName)) {
      head = first;
    } else {
      head = document.createElement("p");
      head.className = "memory-used-cite-row";
      root.insertBefore(head, first ?? tailAnchor);
    }
    head.append(memoryCite);
    head.after(memoryLine);
  }
}

/** 卡片上用户还没发出的改动：调过的数、勾过的清单项（按卡片里的顺序）、表单各栏的值。at 用来丢掉最早的。 */
type CardState = { vars?: Record<string, number>; checks?: number[]; fields?: Record<string, string>; app?: string; at: number };

/**
 * 每张卡一个存储项：两个窗口同时存不同的卡片时互不覆盖。
 * 键是「会话:卡片原文摘要:这条回答前面那句用户的话的摘要」：别的会话、或同一会话里换了问题再出一模一样的卡，不沿用上一次的值。
 * 表单发没发出不存在这里，看对话记录（见 answered）：存储里的“已发送”要在两个窗口、重开、消息丢失之间对齐，对话记录本来就是对齐的。
 */
const STATE_PREFIX = "answerCard:";

/** 侧栏现在显示的会话，由 bindAnswerCards 接上。 */
let conversationOf = () => "default";

const slots = new WeakMap<HTMLElement, string>();

function slotOf(card: HTMLElement): string | undefined {
  const known = slots.get(card);
  const key = card.dataset.gcCard;

  if (known || !key) return known;
  let asked = "";

  for (let el = card.closest(".msg")?.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.matches(".msg.user")) { asked = el.textContent ?? ""; break; }
  }
  const slot = `${conversationOf()}:${key}:${digest(asked)}`;

  slots.set(card, slot);

  return slot;
}

/** 最多记这么多张卡片，超出时丢掉最早动过的。 */
const MAX_SAVED = 300;

function isCardState(v: unknown): v is CardState {
  if (!v || typeof v !== "object") return false;
  const { vars, checks, fields, app, at } = v as Record<string, unknown>;

  return typeof at === "number"
    && (app === undefined || typeof app === "string")
    && (fields === undefined || (typeof fields === "object" && fields !== null && Object.values(fields).every((t) => typeof t === "string")))
    && (vars === undefined || (typeof vars === "object" && vars !== null && Object.values(vars).every((n) => typeof n === "number" && Number.isFinite(n))))
    && (checks === undefined || (Array.isArray(checks) && checks.every((n) => Number.isInteger(n))));
}

async function readState(card: HTMLElement): Promise<CardState | undefined> {
  const slot = slotOf(card);

  if (!slot) return undefined;
  const raw = (await chrome.storage.local.get(STATE_PREFIX + slot).catch(() => ({})) as Record<string, unknown>)[STATE_PREFIX + slot];

  return isCardState(raw) ? raw : undefined;
}

async function trimStates(): Promise<void> {
  const keys = (await chrome.storage.local.getKeys().catch(() => [])).filter((k) => k.startsWith(STATE_PREFIX));

  if (keys.length <= MAX_SAVED) return;
  const all = await chrome.storage.local.get(keys).catch(() => ({})) as Record<string, unknown>;
  const at = (k: string) => { const v = all[k]; return isCardState(v) ? v.at : 0; };

  await chrome.storage.local.remove(keys.sort((a, b) => at(a) - at(b)).slice(0, keys.length - MAX_SAVED)).catch(() => undefined);
}

function stateOf(card: HTMLElement): CardState {
  const vars: Record<string, number> = {};

  for (const el of card.querySelectorAll<HTMLInputElement>(".gc-num[data-gc-var]")) vars[el.dataset.gcVar!] = Number(el.value);
  const checks = [...card.querySelectorAll<HTMLInputElement>(".gc-check input[type=checkbox]")].flatMap((el, i) => (el.checked ? [i] : []));
  const fields = Object.fromEntries([...card.querySelectorAll<HTMLElement>(".gc-field")].map((f) => [f.dataset.gcField!, fieldValue(f)]));

  return { vars, checks, fields, app: appStates.get(card), at: Date.now() };
}

/** 一栏现在的值：选项取选中的那个，文字框取去掉首尾空白的字。 */
function fieldValue(field: HTMLElement): string {
  const chip = field.querySelector<HTMLElement>('.gc-chip[aria-checked="true"]');

  return chip ? chip.dataset.gcOption ?? "" : field.querySelector<HTMLInputElement>(".gc-text")?.value.trim() ?? "";
}

function setFieldValue(field: HTMLElement, value: string): void {
  for (const chip of field.querySelectorAll<HTMLElement>(".gc-chip")) chip.setAttribute("aria-checked", String(chip.dataset.gcOption === value));
  const text = field.querySelector<HTMLInputElement>(".gc-text");

  if (text) text.value = value;
}

/**
 * 这张表单已经答过：这条回答之后用户说的第一句话是表单发出的格式（某一栏的名字加“：”）。返回那句话里各栏的值。
 * 发出后两个窗口的侧栏都会出现这句话；没送达（标了未送达）、被收回时不算，表单自然又能填。
 * 只看紧接着的第一句：用户跳过这张表单说了别的，之后再填另一张同名栏的表单，这张不跟着锁。
 */
function answered(card: HTMLElement): Map<string, string> | null {
  const labels = [...card.querySelectorAll<HTMLElement>(".gc-field")].map((f) => f.dataset.gcLabel ?? "");

  for (let el = card.closest(".msg")?.nextElementSibling; el; el = el.nextElementSibling) {
    if (!el.matches(".msg.user")) continue;

    if (el.matches(".undelivered")) return null;
    const text = (el.querySelector(".user-msg-text") ?? el).textContent?.trim() ?? "";
    const pairs = new Map(text.split("；").flatMap((part) => { const at = part.indexOf("："); return at > 0 ? [[part.slice(0, at), part.slice(at + 1)] as [string, string]] : []; }));

    return [...pairs.keys()].some((k) => labels.includes(k)) ? pairs : null;
  }

  return null;
}

/** 必填栏空着就标出来、发送按钮不能点；答过后整张表单只读，按钮写“已发送”。 */
function refreshForm(card: HTMLElement): void {
  const reply = answered(card);
  const sent = !!reply;
  let missing = false;

  // 答过的表单显示那句话里真正发出去的值：另一个窗口改了再发时，这边不留着旧值。
  if (reply) {
    clearTimeout(typing.get(card));

    for (const field of card.querySelectorAll<HTMLElement>(".gc-field")) {
      const value = reply.get(field.dataset.gcLabel ?? "") ?? "";

      if (fieldValue(field) !== value) setFieldValue(field, value);
    }
  }

  for (const field of card.querySelectorAll<HTMLElement>(".gc-field")) {
    const empty = field.dataset.gcRequired !== undefined && !fieldValue(field);

    missing ||= empty;
    field.classList.toggle("gc-missing", empty && !sent);

    for (const control of field.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".gc-text, .gc-chip")) if (control.disabled !== sent) control.disabled = sent;
  }

  for (const button of card.querySelectorAll<HTMLButtonElement>("[data-card-submit]")) {
    const text = sent ? "已发送" : button.dataset.cardSubmit ?? "";

    if (button.disabled !== (sent || missing)) button.disabled = sent || missing;

    // 只在字变了时写：写字会触发观察者，观察者又调到这里。
    if (button.textContent !== text) button.textContent = text;
  }
}

/** 各栏合成一句用户的话：“出发日期：10-25 周六；乘客：2 位成人”。没填的选填栏不写。 */
function formMessage(card: HTMLElement): string {
  return [...card.querySelectorAll<HTMLElement>(".gc-field")].flatMap((f) => { const v = fieldValue(f); return v ? [`${f.dataset.gcLabel}：${v}`] : []; }).join("；");
}

/** 用户动过的卡片：写完前动过的，写完时存下现在的样子；还原读回来之前就动过的，不拿旧记录盖掉。 */
const touched = new WeakSet<HTMLElement>();

function save(card: HTMLElement): void {
  const slot = slotOf(card);

  touched.add(card);

  if (slot) void chrome.storage.local.set({ [STATE_PREFIX + slot]: stateOf(card) }).then(trimStates).catch(() => undefined);
}

/** 文字框边打边存，停顿一下再写，不每个字写一次。 */
const typing = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

const pendingSaves = new Set<HTMLElement>();

function saveSoon(card: HTMLElement): void {
  touched.add(card);
  pendingSaves.add(card);
  clearTimeout(typing.get(card));
  typing.set(card, setTimeout(() => { pendingSaves.delete(card); save(card); }, 400));
}

// 打字停顿前就关掉侧栏：没写的那次当场写。
addEventListener("pagehide", () => {
  for (const card of pendingSaves) { clearTimeout(typing.get(card)); save(card); }
  pendingSaves.clear();
});

/** 把存下的样子放回卡片：调过的数、勾选、表单各栏。 */
function apply(card: HTMLElement, saved: CardState): void {
  for (const el of card.querySelectorAll<HTMLInputElement>("[data-gc-var]")) {
    const n = saved.vars?.[el.dataset.gcVar!];

    if (n !== undefined) el.value = String(clampTo(el, n));
  }
  [...card.querySelectorAll<HTMLInputElement>(".gc-check input[type=checkbox]")].forEach((el, i) => { el.checked = saved.checks?.includes(i) ?? false; });

  for (const field of card.querySelectorAll<HTMLElement>(".gc-field")) {
    const v = saved.fields?.[field.dataset.gcField!];

    if (v !== undefined) setFieldValue(field, v);
  }
  recompute(card);
  refreshForm(card);
}

/** 小数位数：0.05 是 2 位，1e-7 是 7 位。 */
function decimals(n: number): number {
  const [mantissa = "", exp] = String(n).split("e-");

  return (mantissa.split(".")[1] ?? "").length + Number(exp ?? 0);
}

/** 对齐到档位后再夹进范围（0.1 档不留下 0.30000000000000004，夹到的上限不再被取整推出去）。 */
function clampTo(el: HTMLInputElement, n: number): number {
  const min = Number(el.min);
  const max = Number(el.max);
  const step = Number(el.step) || 1;
  const digits = Math.min(10, Math.max(decimals(step), decimals(min), decimals(max)));
  const snapped = Number((Math.round((n - min) / step) * step + min).toFixed(digits));

  return Math.min(max, Math.max(min, snapped));
}

/** 卡片里的数按现在的可调值重算：数字格、选项、表格、依据面，和同一条回答正文里的 {=名字}。只在字变了时写，免得观察者来回触发。 */
function recompute(card: HTMLElement): void {
  const vars = new Map([...card.querySelectorAll<HTMLInputElement>(".gc-num[data-gc-var]")].map((el) => [el.dataset.gcVar!, Number(el.value)]));
  const set = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };

  // 算不出（除以 0 这类）就显示「—」，不留上一次的结果。
  for (const el of card.querySelectorAll<HTMLElement>("[data-gc-expr]")) {
    const n = evaluate(el.dataset.gcExpr!, vars);

    set(el, n === undefined ? "—" : showValue(n, el.dataset.gcUnit || undefined));
  }

  for (const el of card.querySelectorAll<HTMLElement>("[data-gc-formula]")) set(el, showFormula(el.dataset.gcFormula!, vars));

  for (const group of card.querySelectorAll(".gc-stats")) group.classList.toggle("wide", wideStats([...group.querySelectorAll(".gc-stat .v")].map((v) => v.textContent ?? "")));
  const answer = card.parentElement;
  // 正文里的名字归回答中第一张定义它的卡：两张卡同名时不轮流改写同一处正文。
  const refs = (id: string, text: string) => {
    const escaped = CSS.escape(id);
    const owner = answer?.querySelector(`[data-gc-id="${escaped}"], .gc-num[data-gc-var="${escaped}"]`)?.closest(".gen-card");

    if (owner !== card) return;

    for (const ref of answer?.querySelectorAll(`[data-gc-ref="${escaped}"]`) ?? []) set(ref, text);
  };

  for (const v of card.querySelectorAll<HTMLElement>("[data-gc-id]")) refs(v.dataset.gcId!, v.textContent ?? "");

  for (const el of card.querySelectorAll<HTMLInputElement>(".gc-num[data-gc-var]")) refs(el.dataset.gcVar!, showValue(Number(el.value), el.dataset.gcUnit || undefined));
}

/** 一个可调的数换了值：两个输入框（数字、滑块）对齐，重算，存起来。 */
function setVar(el: HTMLInputElement, n: number): void {
  const card = el.closest<HTMLElement>(".gen-card");
  const value = String(clampTo(el, n));

  for (const other of el.closest(".gc-input")?.querySelectorAll<HTMLInputElement>("[data-gc-var]") ?? []) if (other.value !== value) other.value = value;

  if (!card) return;
  recompute(card);
  save(card);
}

/** 已经还原过的卡片：patchAnswer 留着同一个节点，不重复还原。 */
const restored = new WeakSet<HTMLElement>();

/** 写完的卡片出现时（流式写完、重开侧栏、切会话），把存过的值放回去再重算。写完前用户已经动过的，改为存下现在的样子。 */
function restore(card: HTMLElement): void {
  if (!card.dataset.gcCard || restored.has(card)) return;
  restored.add(card);

  if (touched.has(card)) { save(card);

 return; }
  void readState(card).then((saved) => {
    if (saved && card.isConnected && !touched.has(card)) apply(card, saved);
  });
}

/** 已经去找过出处的行（找到的记下出处）：patchAnswer 留着同一个节点，不重复去找。 */
const rowTried = new WeakSet<HTMLElement>();

const rowSources = new WeakMap<HTMLElement, { source: PageElementSource; tabId: number }>();

const withoutHash = (url: string) => url.split("#")[0]!;

/**
 * 写了 tab 的一行：到那个标签页找这一行的数，整页恰好一处时这一行变成可点（同回答正文的“数字回原页”，sonar-citations.ts）。
 * 只去这条回答的出处清单里那几页（这一轮真读过、打开过的页面，answer-sources.ts）：tab 编号是模型写的，模型可能被网页内容带偏，
 * 写出用户别的标签页（比如登录着的邮箱）。那一页跳走了，网址就不在清单里，也不去。
 * 出处清单在回答写完后才挂上：还没有清单时先不算找过，清单出现时再来。
 */
async function linkRow(row: HTMLElement): Promise<void> {
  const allowed = [...(row.closest(".msg")?.querySelectorAll<HTMLElement>(".answer-source[title]") ?? [])].map((b) => withoutHash(b.title));

  if (!allowed.length) return;
  rowTried.add(row);
  const tabId = Number(row.dataset.gcTab);
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;

  if (!tab?.url || !allowed.includes(withoutHash(tab.url))) return;
  const context = await captureCitationContext({ tabId, url: tab.url });

  if (!context) return;
  const result = await chrome.runtime.sendMessage({ type: "PINPOINT_DOM_TARGET", action: "resolve", query: row.dataset.gcFind, ...context }).catch(() => null);

  if (!result?.ok || !isPageElementSource(result.source) || !row.isConnected) return;
  rowSources.set(row, { source: result.source, tabId });
  row.classList.add("gc-linked");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.title = `到原页看：${result.source.title || tab.title || ""}`.trim();
}

/** 点可点的一行：切到那一页、圈出那个数；那一页在别的窗口时把那个窗口提到前面。 */
async function revealRow(row: HTMLElement): Promise<void> {
  const linked = rowSources.get(row);

  if (!linked) return;
  const reply = await chrome.runtime.sendMessage({ type: "PINPOINT_DOM_TARGET", action: "reveal", source: linked.source, tabId: linked.tabId }).catch(() => null);

  if (!reply?.ok) { noteFailure(row, reply?.error ?? "原文已变化，请重新核对。");

 return; }
  clearFailure(row);
  const tab = await chrome.tabs.get(linked.tabId).catch(() => null);

  if (tab && (tab.windowId !== await targetWindowId() || isPopout)) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

/** 小程序最后一次 bys.save 的内容（字符串化的 JSON），随卡片其他状态一起存。 */
const appStates = new WeakMap<HTMLElement, string>();

/** 已经放进 iframe 的小程序框，和收尾要摘掉的监听。 */
const mountedApps = new Map<HTMLElement, () => void>();

const mountTickets = new WeakMap<HTMLElement, symbol>();

/** 小程序框的高度上下限：太矮看不全一行按钮，太高一个小程序就占满侧栏。 */
const APP_MIN_HEIGHT = 60;

const APP_MAX_HEIGHT = 720;

let miniAppsOn: Promise<boolean> | undefined;

const readMiniAppsOn = () => (miniAppsOn ??= chrome.storage.local.get(MINI_APPS_KEY).then((r) => isMiniAppsOn(r[MINI_APPS_KEY]), () => false));

function releaseApps(): void {
  for (const [box, release] of mountedApps) {
    if (box.isConnected) continue;
    release();
    mountedApps.delete(box);
  }
}

/** 小程序框下面的一行：报错、想放进输入框的话。 */
function appBar(box: HTMLElement, text: string, action?: { label: string; run: () => void }): void {
  const bar = box.querySelector<HTMLElement>(":scope > .gc-app-bar");

  if (!bar) return;
  const note = document.createElement("span");
  note.textContent = text;
  bar.replaceChildren(note);

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gc-btn";
    button.textContent = action.label;
    button.addEventListener("click", () => { action.run(); button.disabled = true; });
    bar.append(button);
  }
  bar.hidden = false;
}

/**
 * 把写完的小程序放进沙箱 iframe（mini-app.html）。实验功能关着就只写一句怎么打开。
 * 沙箱发回来的都是不可信的话：只认这个 iframe 发的、只做四件事——调高度、存状态、在下面提一句话等用户点、报错。
 * 报错时给「让助手修好」：用户点了才把错误发给助手，不自动发，免得用户没看就多花一轮。
 */
async function mountApp(box: HTMLElement, say: (text: string) => boolean | void): Promise<void> {
  // 每次挂载一张票：等开关、等存档的时候开关被关、框被换掉，旧的这次就作废，不再放进 iframe。
  const ticket = Symbol("mount");
  const current = () => box.isConnected && mountTickets.get(box) === ticket;

  mountTickets.set(box, ticket);
  mountedApps.set(box, () => {});
  const card = box.closest<HTMLElement>(".gen-card");
  const holder = box.querySelector<HTMLElement>(":scope > .gc-app-frame");
  const title = box.dataset.appTitle ?? "小程序";

  if (!card || !holder) return;

  const on = await readMiniAppsOn();

  if (!current()) return;

  if (!on) {
    const off = document.createElement("p");
    off.className = "gc-app-off";
    off.textContent = `这条回答里有一个小程序「${title}」。在「设置 → 实验功能」打开「回答里的小程序」后显示。`;
    holder.replaceChildren(off);

    return;
  }
  const saved = await readState(card);

  if (!current()) return;

  if (saved?.app) appStates.set(card, saved.app);
  const frame = document.createElement("iframe");
  frame.className = "gc-app-iframe";
  frame.title = title;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.height = `${APP_MIN_HEIGHT * 2}px`;
  let ready = false;
  let failed = false;
  let heardAt = 0;
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow) return;
    heardAt = performance.now();
    const data = event.data;

    if (!data || typeof data !== "object" || !("miniApp" in data)) return;
    const kind = data.miniApp;

    if (kind === "ready" && !ready) {
      ready = true;
      frame.contentWindow?.postMessage({ html: decodeURIComponent(box.dataset.app ?? ""), state: appStates.get(card) ?? null }, "*");
    } else if (kind === "height" && "h" in data && typeof data.h === "number") {
      frame.style.height = `${Math.min(APP_MAX_HEIGHT, Math.max(APP_MIN_HEIGHT, data.h))}px`;
    } else if (kind === "save" && "state" in data && typeof data.state === "string" && data.state.length <= 50_000) {
      // 小程序自己决定什么时候存（多半是用户点了什么），马上写：等一会儿再写，用户这时关掉侧栏就丢了。
      appStates.set(card, data.state);
      save(card);
    } else if (kind === "draft" && "text" in data && typeof data.text === "string" && data.text.trim()) {
      const text = data.text.replace(/\s+/g, " ").trim().slice(0, 500);

      appBar(box, `小程序想放进输入框：「${text}」`, { label: "放进输入框", run: () => fillInput(text) });
    } else if (kind === "error" && "message" in data && typeof data.message === "string" && !failed) {
      failed = true;
      const message = data.message.slice(0, 300);

      appBar(box, `小程序出错了：${message}`, { label: "让助手修好", run: () => { say(`小程序「${title}」出错了：${message}。请修好它。`); } });
    }
  };

  window.addEventListener("message", onMessage);
  mountedApps.set(box, () => window.removeEventListener("message", onMessage));
  // 写入程序后每次 load 桥都会报一次高度；load 之后再没有桥的消息，就是小程序把自己换成了别的网页：
  // 侧栏的 frame-src 已经拦下，框里只剩浏览器的错误页，收起来说一句。
  frame.addEventListener("load", () => {
    if (!ready) return;
    const at = performance.now();

    setTimeout(() => {
      if (heardAt >= at - 200 || !frame.isConnected) return;
      frame.remove();
      appBar(box, "小程序想跳到外面的网页，已拦下。");
    }, 800);
  });
  frame.src = chrome.runtime.getURL("mini-app.html");
  holder.replaceChildren(frame);
}

/** 放进输入框，不发送；和文件卡片「填入输入框」一样由用户再按发送。 */
function fillInput(text: string): void {
  const input = document.querySelector<HTMLTextAreaElement>("#input");

  if (!input) return;
  input.value = [input.value.trim(), text].filter(Boolean).join("\n");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

/**
 * 卡片按钮：say 把按钮上的话当作用户下一句发出；tab 切到那一页。用事件委托，流式重画后不用重新绑定。
 * 只认显示的字和要发的字一样的按钮：正文里夹带的原始 HTML 做不出“看着是 A、发出去是 B”的按钮。
 */
export function bindAnswerCards(root: HTMLElement, say: (text: string) => boolean | void, conversation: () => string = () => "default"): void {
  conversationOf = conversation;
  // 写完的图不管从流式、重开侧栏还是切会话进来，都在出现时画一次。
  const draw = () => {
    releaseDiagrams();

    for (const el of root.querySelectorAll<HTMLElement>(".gc-diagram:not(.gc-ph):not([data-drawn])")) void drawDiagram(el);

    for (const card of root.querySelectorAll<HTMLElement>(".gen-card[data-gc-card]")) restore(card);

    releaseApps();

    for (const box of root.querySelectorAll<HTMLElement>(".gc-app[data-app]")) if (!mountedApps.has(box)) void mountApp(box, say);

    for (const row of root.querySelectorAll<HTMLElement>(".gen-card[data-gc-card] [data-gc-tab]")) if (!rowTried.has(row)) void linkRow(row);

    // 写到一半时用户已经调过数：后面新写出的组件按调过的值算。
    for (const card of root.querySelectorAll<HTMLElement>(".gen-card:has(.gc-num)")) recompute(card);

    for (const card of root.querySelectorAll<HTMLElement>(".gen-card:has(.gc-field)")) refreshForm(card);
  };

  new MutationObserver(draw).observe(root, { childList: true, subtree: true });
  // 在设置里开关小程序：已显示的小程序框按新开关重放一次。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(MINI_APPS_KEY in changes)) return;
    miniAppsOn = Promise.resolve(isMiniAppsOn(changes[MINI_APPS_KEY]!.newValue));

    for (const [box, release] of mountedApps) {
      release();
      mountedApps.delete(box);
      mountTickets.delete(box);
      box.querySelector(":scope > .gc-app-frame")?.replaceChildren();
      box.querySelector<HTMLElement>(":scope > .gc-app-bar")?.setAttribute("hidden", "");
    }
    draw();
  });
  draw();
  root.addEventListener("keydown", (event) => {
    // SAFETY: keydown 事件的 target 是 Element。
    const node = (event.target as Element).closest<SVGElement>(".gc-diagram [data-cited]");

    // SAFETY: 同上。
    const row = (event.target as Element).closest<HTMLElement>(".gen-card .gc-linked");

    if (row && event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void revealRow(row);

 return; }

    if (!node || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleCite(node);
  });
  root.addEventListener("input", (event) => {
    const el = event.target;

    if (!(el instanceof HTMLInputElement) || !el.closest(".gen-card")) return;

    if (el.classList.contains("gc-text")) {
      const card = el.closest<HTMLElement>(".gen-card")!;

      refreshForm(card);
      saveSoon(card);

      return;
    }

    // 打字到一半（空、只有负号）先不动，失焦时再夹回范围。
    if (el.dataset.gcVar !== undefined && el.value.trim() !== "" && Number.isFinite(Number(el.value))) {
      if (el.type === "range") setVar(el, Number(el.value));
      else {
        for (const other of el.closest(".gc-input")?.querySelectorAll<HTMLInputElement>(".gc-range") ?? []) other.value = el.value;
        const card = el.closest<HTMLElement>(".gen-card")!;
        recompute(card);
      }
    }
  });
  root.addEventListener("change", (event) => {
    const el = event.target;

    if (!(el instanceof HTMLInputElement)) return;
    const card = el.closest<HTMLElement>(".gen-card");

    if (!card) return;

    if (el.dataset.gcVar !== undefined) setVar(el, Number.isFinite(Number(el.value)) && el.value.trim() !== "" ? Number(el.value) : Number(el.defaultValue));
    else if ((el.type === "checkbox" && el.closest(".gc-check")) || el.classList.contains("gc-text")) save(card);
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
    const step = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-bump");
    const num = step?.closest(".gc-input")?.querySelector<HTMLInputElement>(".gc-num");

    if (step && num) { setVar(num, Number(num.value) + Number(step.dataset.gcBump) * (Number(num.step) || 1));

 return; }
    // SAFETY: 同上。
    const chip = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-chip");
    const form = chip?.closest<HTMLElement>(".gen-card");

    if (chip && form && !chip.disabled) {
      setFieldValue(chip.closest<HTMLElement>(".gc-field")!, chip.dataset.gcOption ?? "");
      refreshForm(form);
      save(form);

      return;
    }
    // SAFETY: 同上。
    const button = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-btn");
    // SAFETY: 同上。
    const row = (event.target as Element).closest<HTMLElement>(".gen-card .gc-linked");

    // 行里的数字若已经是正文那套“回原页”的入口（.num-cite），交给它，不重复。
    if (!button && row && !(event.target as Element).closest(".num-cite")) { void revealRow(row);

 return; }

    if (!button) return;
    const label = button.textContent?.trim() ?? "";

    if (button.dataset.cardSubmit !== undefined) {
      const form = button.closest<HTMLElement>(".gen-card");
      const text = form ? formMessage(form) : "";

      // 发出后对话里多出这句话，观察者据此把表单变成已发送；没发出去就什么都不变，用户还能再点。
      if (!form || !text || button.disabled) return;
      save(form);
      say(text);

      return;
    }

    if (button.dataset.cardSay !== undefined) {
      if (button.dataset.cardSay === label && label) say(label);

      return;
    }
    const tabId = Number(button.dataset.cardTab);
    const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;

    if (!tab?.id) { button.disabled = true; noteFailure(button, "那一页已经关掉了");

 return; }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
    const targetWindow = await targetWindowId();

    // 在会话小窗口里点：标签页所在的浏览器窗口可能压在后面，要提到前面才看得见。
    if (tab.windowId !== targetWindow || isPopout) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  });
}
