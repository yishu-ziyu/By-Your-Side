import { resolveDiagramCite, type AnswerSourceMap } from "../../../shared/answer-source.js";
import DOMPurify from "dompurify";
import { isPopout, targetWindowId } from "./target-window.js";
import { createElement as icon, LayoutGrid, Table2 } from "lucide";
import { type Block, type Card, type CardField, type CardInput, type Cell, type RowSource, type PendingComponent, cardEvidence, evaluate, fillRefs, resolveProse, showFormula, showValue, splitAnswer } from "../../../shared/answer-cards.js";
import { keepOpenedImages } from "../shared/answer-html.js";
import { captureCitationContext, clearFailure, noteFailure } from "./sonar-citations.js";
import { isMiniAppsOn, MINI_APPS_KEY } from "../shared/mini-apps.js";
import { isPageElementSource, type PageElementSource } from "../../../shared/protocol.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function digest(s: string): string {
  let h = 5381;

  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) | 0;

  return (h >>> 0).toString(36);
}

const keyed = (key: string, html: string) => html.replace(/^<(\w+)/, `<$1 data-gc-key="${key}" data-gc-sig="${digest(html)}"`);

const BAR = '<i class="gc-bar"></i>';

const live = (c: { expr?: string; unit?: string }) => (c.expr ? ` data-gc-expr="${esc(c.expr)}" data-gc-unit="${esc(c.unit ?? "")}"` : "");

const formulaHtml = (formula: string, expr?: string) => (expr ? `<span data-gc-formula="${esc(expr)}">${esc(formula)}</span>` : esc(formula));

const fromAttrs = (from?: RowSource) => (from ? ` data-gc-tab="${esc(from.tab)}" data-gc-find="${esc(from.find)}"` : "");

const cellHtml = (c: Cell, tag: string, cls = "") => `<${tag}${cls}${live(c)}>${esc(c.value)}</${tag}>`;

const tidyNumber = (text: string) => text
  .replace(/([¥$€£]\s?)([1-9]\d{3,14})(?![\d,])/g, (_, sign: string, digits: string) => sign + Number(digits).toLocaleString("zh-CN"))
  .replace(/^([1-9]\d{4,9})(?=(?:\.\d+)?\s*(?:[元万亿人个次件份台%]|km|kg)?$)/, (digits: string) => Number(digits).toLocaleString("zh-CN"));

const WIDE_STAT = 10;
const wideStats = (values: string[]) => values.some((v) => v.length > WIDE_STAT);

const SLIDER_STEPS = 20;

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

const STANDALONE = new Set<PendingComponent["tag"]>(["table", "callout", "diagram"]);

const textHtml = (text: string, values: ReadonlyMap<string, string>) => fillRefs(esc(text), values, (v, id) => `<span data-gc-ref="${esc(id)}">${esc(v)}</span>`, "…");

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

      return keyed(`b${i}`, `<div class="gc-diagram" data-diagram="${encodeURIComponent(b.source)}"><div class="gc-diagram-canvas"></div>${list}${missing ? `<div class="gc-diagram-hint">有 ${missing} 处来源未能核对</div>` : ""}</div>`);
    }
  }
}

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

  if (p && p.tag !== "tr" && (STANDALONE.has(p.tag) || card.blocks.at(-1)?.kind !== KIND[p.tag])) {
    const wrap = { stat: "div class=\"gc-stats\"", step: "ol class=\"gc-steps\"", option: "div class=\"gc-options\"", check: "ul class=\"gc-checks\"" } as const;

    blocks.push(p.tag === "table" || p.tag === "callout" || p.tag === "diagram" ? placeholder(p, `b${n}`, 0) : `<${wrap[p.tag]} data-gc-key="b${n}">${placeholder(p, `b${n}.0`, 0)}</${wrap[p.tag].split(" ")[0]}>`);
  }

  const body = blocks.join("");
  const buttons = card.closed ? card.buttons.map((b) => `<button type="button" class="gc-btn${b.primary ? " primary" : ""}" ${b.tab ? `data-card-tab="${esc(b.tab)}"` : b.submit ? `data-card-submit="${esc(b.label)}"` : `data-card-say="${esc(b.label)}"`}>${esc(b.label)}</button>`).join("") : "";
  const rows = cardEvidence(card);
  const shared = rows.every((r) => r.source === rows[0]?.source);
  const sourceCell = (r: (typeof rows)[number], i: number) => (shared && i > 0 ? "" : `<td class="s"${shared ? ` rowspan="${rows.length}"` : ""}>${r.source ? esc(r.source) : "—"}</td>`);
  const evidence = rows.length ? keyed("ev", `<div class="gc-evidence" hidden><table><thead><tr><th>项</th><th>结果</th><th>怎么算</th><th>出处</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${textHtml(r.label, card.values)}${r.tab ? `<button type="button" class="gc-btn gc-point" data-card-tab="${esc(r.tab)}">指给我看</button>` : ""}</td>${cellHtml(r, "td", ' class="r"')}<td class="f">${r.formula ? formulaHtml(r.formula, r.expr) : "—"}</td>${sourceCell(r, i)}</tr>`).join("")}</tbody></table></div>`) : "";
  const faces = rows.length ? keyed("faces", `<div class="gc-faces" role="group" aria-label="结论 / 依据">${FACE_BUTTONS}</div>`) : "";
  const head = card.title ? `<div class="gc-head${faces ? " has-faces" : ""}"><div class="gc-title">${textHtml(card.title, card.values)}</div>${card.sub ? `<div class="gc-sub">${textHtml(card.sub, card.values)}</div>` : ""}</div>` : faces ? '<div class="gc-head has-faces" data-gc-key="head"></div>' : "";

  return `<div class="gen-card"${card.closed ? ` data-gc-card="${card.key}"` : ""}>${head}${body ? `<div class="gc-body" data-gc-key="body">${body}</div>` : ""}${evidence}${buttons ? `<div class="gc-actions">${buttons}</div>` : ""}${card.source && card.closed ? `<div class="gc-foot">${esc(card.source)}</div>` : ""}${faces}</div>`;
}

const svg = (node: Parameters<typeof icon>[0]) => {
  const el = icon(node);
  el.setAttribute("width", "14");
  el.setAttribute("height", "14");
  el.setAttribute("aria-hidden", "true");

  return el.outerHTML;
};

const FACE_BUTTONS = `<button type="button" class="gc-face" data-face="answer" aria-pressed="true" title="结论" aria-label="结论">${svg(LayoutGrid)}</button><button type="button" class="gc-face" data-face="evidence" aria-pressed="false" title="依据" aria-label="依据">${svg(Table2)}</button>`;

type Engine = typeof import("./diagram-engine.js");

const ENGINE_URL = { flow: "./diagram-engine.js", more: "./diagram-engine-more.js" };

const engines: Partial<Record<keyof typeof ENGINE_URL, Promise<Engine>>> = {};

const loadEngine = (kind: keyof typeof ENGINE_URL) => (engines[kind] ??= import(ENGINE_URL[kind]) as Promise<Engine>);

function cleanSvg(svg: string): Node {
  const fragment = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true }, FORBID_TAGS: ["a", "image", "use", "foreignObject", "style"], RETURN_DOM_FRAGMENT: true });

  for (const el of fragment.querySelectorAll("[style]")) if (/url\(|@import|expression/i.test(el.getAttribute("style") ?? "")) el.removeAttribute("style");

  return fragment;
}

const MIN_SCALE = 0.85;

const LINE_UNITS = 8;

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

function narrower(source: string, render: Engine["render"]): string {
  const at = diagramStart(source);
  const flipped = source.slice(0, at) + source.slice(at).replace(/^((?:flowchart|graph)\s+)(TB|TD|LR)\b/, (_all, head: string, dir: string) => head + (dir === "LR" ? "TB" : "LR"));

  try {
    return flipped !== source && render(flipped, { fontSize: 13 }).width < render(source, { fontSize: 13 }).width ? flipped : source;
  } catch {
    return source;
  }
}

function fit(canvas: HTMLElement): void {
  const natural = Number(canvas.dataset.natural);

  if (!natural) return;
  const wide = natural * MIN_SCALE > canvas.clientWidth;

  canvas.classList.toggle("gc-diagram-wide", wide);
  canvas.querySelector("svg")?.style.setProperty("width", wide ? `${Math.round(natural * MIN_SCALE)}px` : "");
}

const fitter = new ResizeObserver((entries) => {
  for (const entry of entries) fit(entry.target as HTMLElement);
});

const mounted = new Map<HTMLElement, { destroy(): void }>();

function releaseDiagrams(): void {
  for (const [figure, m] of mounted) {
    if (figure.isConnected) continue;
    m.destroy();

    for (const canvas of figure.querySelectorAll(".gc-diagram-canvas")) fitter.unobserve(canvas);
    mounted.delete(figure);
  }
}

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
    const kind = diagramKind(source);
    const flow = kind === "flowchart" || kind === "graph";
    figure.dataset.kind = kind;
    const { mount, render } = await loadEngine(flow ? "flow" : "more");

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

export function renderAnswerHtml(text: string, renderProse: (markdown: string) => string, sources?: AnswerSourceMap): string {
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const bold = (value: string, id: string) => `**\uE000${nonce}${id}\uE001${value}\uE002**`;
  const ref = new RegExp(`\uE000${nonce}([A-Za-z_][\\w-]*)\uE001([^\uE002<]*)\uE002`, "g");
  const refs = (html: string) => html.replace(ref, (_all, id: string, value: string) => `<span data-gc-ref="${esc(id)}">${value}</span>`);

  return parts.map((p) => ("prose" in p ? (p.prose.trim() ? refs(withMermaidDiagrams(resolveProse(p.prose, cards, bold), renderProse)) : "") : p.card ? cardHtml(p.card, sources) : "")).join("");
}

const MERMAID_FENCE = /^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;
const DRAWABLE = new Set(["flowchart", "graph", "timeline", "sequenceDiagram", "mindmap", "pie", "gantt", "stateDiagram", "stateDiagram-v2", "classDiagram", "erDiagram", "journey", "quadrantChart", "xychart", "xychart-beta"]);

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

function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;

  if (!(a instanceof Element) || !(b instanceof Element)) return true;

  return a.tagName === b.tagName && a.getAttribute("data-gc-key") === b.getAttribute("data-gc-key") && a.getAttribute("data-gc-sig") === b.getAttribute("data-gc-sig");
}

function enter(node: Node): void {
  if (node instanceof Element && !node.classList.contains("gc-ph")) node.classList.add("gc-in");
}

function syncAttributes(to: Element, from: Element): void {
  const fading = to.classList.contains("gc-in");
  const face = to.getAttribute("data-face");

  for (const { name } of [...to.attributes]) if (!from.hasAttribute(name)) to.removeAttribute(name);

  for (const { name, value } of [...from.attributes]) if (to.getAttribute(name) !== value) to.setAttribute(name, value);

  if (fading) to.classList.add("gc-in");

  if (face && to.classList.contains("gen-card")) to.setAttribute("data-face", face);
}

function showFace(card: HTMLElement, face: string): void {
  const body = card.querySelector<HTMLElement>(":scope > .gc-body");
  const evidence = card.querySelector<HTMLElement>(":scope > .gc-evidence");
  const foot = card.querySelector<HTMLElement>(":scope > .gc-foot");

  if (!evidence) return;

  if (face === "evidence" && card.dataset.face !== "evidence" && body) evidence.style.minHeight = `${body.offsetHeight + (foot?.offsetHeight ?? 0)}px`;
  card.dataset.face = face;
  evidence.hidden = face !== "evidence";

  for (const b of card.querySelectorAll<HTMLElement>(":scope > .gc-faces .gc-face")) b.setAttribute("aria-pressed", String(b.dataset.face === face));
}

function syncChildren(to: Element, from: Element): void {
  const next = [...from.childNodes];

  next.forEach((node, i) => {
    const old = to.childNodes[i];

    if (!old) { enter(node); to.append(node);

 return; }

    if (!same(old, node)) {
      enter(node);
      const oldKey = old instanceof Element ? old.getAttribute("data-gc-key") : null;

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

export function dropPlaceholders(root: HTMLElement): void {
  for (const el of root.querySelectorAll(".gen-card .gc-ph")) el.remove();

  for (const el of root.querySelectorAll(".gen-card .gc-stats, .gen-card .gc-steps, .gen-card .gc-options, .gen-card .gc-checks")) if (!el.children.length) el.remove();
}

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

  for (const el of root.querySelectorAll<HTMLElement>("[data-tail]")) delete el.dataset.tail;

  for (const node of [...next.content.childNodes]) {
    const old = node instanceof Element && node.classList.contains("gen-card") ? kept[k++] : undefined;

    if (old && node instanceof Element) {
      syncAttributes(old, node);
      syncChildren(old, node);

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

  for (const card of kept) if (card instanceof HTMLElement && card.querySelector(".gc-field")) refreshForm(card);

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

type CardState = { vars?: Record<string, number>; checks?: number[]; fields?: Record<string, string>; app?: string; at: number };

const STATE_PREFIX = "answerCard:";

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

function fieldValue(field: HTMLElement): string {
  const chip = field.querySelector<HTMLElement>('.gc-chip[aria-checked="true"]');

  return chip ? chip.dataset.gcOption ?? "" : field.querySelector<HTMLInputElement>(".gc-text")?.value.trim() ?? "";
}

function setFieldValue(field: HTMLElement, value: string): void {
  for (const chip of field.querySelectorAll<HTMLElement>(".gc-chip")) chip.setAttribute("aria-checked", String(chip.dataset.gcOption === value));
  const text = field.querySelector<HTMLInputElement>(".gc-text");

  if (text) text.value = value;
}

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

function refreshForm(card: HTMLElement): void {
  const reply = answered(card);
  const sent = !!reply;
  let missing = false;

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

    if (button.textContent !== text) button.textContent = text;
  }
}

function formMessage(card: HTMLElement): string {
  return [...card.querySelectorAll<HTMLElement>(".gc-field")].flatMap((f) => { const v = fieldValue(f); return v ? [`${f.dataset.gcLabel}：${v}`] : []; }).join("；");
}

const touched = new WeakSet<HTMLElement>();

function save(card: HTMLElement): void {
  const slot = slotOf(card);

  touched.add(card);

  if (slot) void chrome.storage.local.set({ [STATE_PREFIX + slot]: stateOf(card) }).then(trimStates).catch(() => undefined);
}

const typing = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

const pendingSaves = new Set<HTMLElement>();

function saveSoon(card: HTMLElement): void {
  touched.add(card);
  pendingSaves.add(card);
  clearTimeout(typing.get(card));
  typing.set(card, setTimeout(() => { pendingSaves.delete(card); save(card); }, 400));
}

addEventListener("pagehide", () => {
  for (const card of pendingSaves) { clearTimeout(typing.get(card)); save(card); }
  pendingSaves.clear();
});

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

function decimals(n: number): number {
  const [mantissa = "", exp] = String(n).split("e-");

  return (mantissa.split(".")[1] ?? "").length + Number(exp ?? 0);
}

function clampTo(el: HTMLInputElement, n: number): number {
  const min = Number(el.min);
  const max = Number(el.max);
  const step = Number(el.step) || 1;
  const digits = Math.min(10, Math.max(decimals(step), decimals(min), decimals(max)));
  const snapped = Number((Math.round((n - min) / step) * step + min).toFixed(digits));

  return Math.min(max, Math.max(min, snapped));
}

function recompute(card: HTMLElement): void {
  const vars = new Map([...card.querySelectorAll<HTMLInputElement>(".gc-num[data-gc-var]")].map((el) => [el.dataset.gcVar!, Number(el.value)]));
  const set = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };

  for (const el of card.querySelectorAll<HTMLElement>("[data-gc-expr]")) {
    const n = evaluate(el.dataset.gcExpr!, vars);

    set(el, n === undefined ? "—" : showValue(n, el.dataset.gcUnit || undefined));
  }

  for (const el of card.querySelectorAll<HTMLElement>("[data-gc-formula]")) set(el, showFormula(el.dataset.gcFormula!, vars));

  for (const group of card.querySelectorAll(".gc-stats")) group.classList.toggle("wide", wideStats([...group.querySelectorAll(".gc-stat .v")].map((v) => v.textContent ?? "")));
  const answer = card.parentElement;
  const refs = (id: string, text: string) => {
    const escaped = CSS.escape(id);
    const owner = answer?.querySelector(`[data-gc-id="${escaped}"], .gc-num[data-gc-var="${escaped}"]`)?.closest(".gen-card");

    if (owner !== card) return;

    for (const ref of answer?.querySelectorAll(`[data-gc-ref="${escaped}"]`) ?? []) set(ref, text);
  };

  for (const v of card.querySelectorAll<HTMLElement>("[data-gc-id]")) refs(v.dataset.gcId!, v.textContent ?? "");

  for (const el of card.querySelectorAll<HTMLInputElement>(".gc-num[data-gc-var]")) refs(el.dataset.gcVar!, showValue(Number(el.value), el.dataset.gcUnit || undefined));
}

function setVar(el: HTMLInputElement, n: number): void {
  const card = el.closest<HTMLElement>(".gen-card");
  const value = String(clampTo(el, n));

  for (const other of el.closest(".gc-input")?.querySelectorAll<HTMLInputElement>("[data-gc-var]") ?? []) if (other.value !== value) other.value = value;

  if (!card) return;
  recompute(card);
  save(card);
}

const restored = new WeakSet<HTMLElement>();

function restore(card: HTMLElement): void {
  if (!card.dataset.gcCard || restored.has(card)) return;
  restored.add(card);

  if (touched.has(card)) { save(card);

 return; }
  void readState(card).then((saved) => {
    if (saved && card.isConnected && !touched.has(card)) apply(card, saved);
  });
}

const rowTried = new WeakSet<HTMLElement>();

const rowSources = new WeakMap<HTMLElement, { source: PageElementSource; tabId: number }>();

const withoutHash = (url: string) => url.split("#")[0]!;

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

const appStates = new WeakMap<HTMLElement, string>();

const mountedApps = new Map<HTMLElement, () => void>();

const mountTickets = new WeakMap<HTMLElement, symbol>();

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

async function mountApp(box: HTMLElement, say: (text: string) => boolean | void): Promise<void> {
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
      appStates.set(card, data.state);
      save(card);
    } else if (kind === "draft" && "text" in data && typeof data.text === "string" && data.text.trim()) {
      const text = data.text.replace(/\s+/g, " ").trim().slice(0, 500);

      appBar(box, `小程序想放进输入框：「${text}」`, { label: "放进输入框", run: () => fillInput(text) });
    } else if (kind === "error" && "message" in data && typeof data.message === "string" && !failed) {
      failed = true;
      const message = data.message.slice(0, 300);

      appBar(box, "小程序出错了", { label: "让助手修好", run: () => { say(`小程序「${title}」出错了：${message}。请修好它。`); } });
    }
  };

  window.addEventListener("message", onMessage);
  mountedApps.set(box, () => window.removeEventListener("message", onMessage));
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

function fillInput(text: string): void {
  const input = document.querySelector<HTMLTextAreaElement>("#input");

  if (!input) return;
  input.value = [input.value.trim(), text].filter(Boolean).join("\n");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

export function bindAnswerCards(root: HTMLElement, say: (text: string) => boolean | void, conversation: () => string = () => "default"): void {
  conversationOf = conversation;
  const draw = () => {
    releaseDiagrams();

    for (const el of root.querySelectorAll<HTMLElement>(".gc-diagram:not(.gc-ph):not([data-drawn])")) void drawDiagram(el);

    for (const card of root.querySelectorAll<HTMLElement>(".gen-card[data-gc-card]")) restore(card);

    releaseApps();

    for (const box of root.querySelectorAll<HTMLElement>(".gc-app[data-app]")) if (!mountedApps.has(box)) void mountApp(box, say);

    for (const row of root.querySelectorAll<HTMLElement>(".gen-card[data-gc-card] [data-gc-tab]")) if (!rowTried.has(row)) void linkRow(row);

    for (const card of root.querySelectorAll<HTMLElement>(".gen-card:has(.gc-num)")) recompute(card);

    for (const card of root.querySelectorAll<HTMLElement>(".gen-card:has(.gc-field)")) refreshForm(card);
  };

  new MutationObserver(draw).observe(root, { childList: true, subtree: true });
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
    const node = (event.target as Element).closest<SVGElement>(".gc-diagram [data-cited]");

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
    const node = (event.target as Element).closest<SVGElement>(".gc-diagram [data-cited]");

    if (node) { toggleCite(node);

 return; }
    const face = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-face");
    const card = face?.closest<HTMLElement>(".gen-card");

    if (face && card) { showFace(card, face.dataset.face ?? "answer");

 return; }
    const step = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-bump");
    const num = step?.closest(".gc-input")?.querySelector<HTMLInputElement>(".gc-num");

    if (step && num) { setVar(num, Number(num.value) + Number(step.dataset.gcBump) * (Number(num.step) || 1));

 return; }
    const chip = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-chip");
    const form = chip?.closest<HTMLElement>(".gen-card");

    if (chip && form && !chip.disabled) {
      setFieldValue(chip.closest<HTMLElement>(".gc-field")!, chip.dataset.gcOption ?? "");
      refreshForm(form);
      save(form);

      return;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-btn");
    const row = (event.target as Element).closest<HTMLElement>(".gen-card .gc-linked");

    if (!button && row && !(event.target as Element).closest(".num-cite")) { void revealRow(row);

 return; }

    if (!button) return;
    const label = button.textContent?.trim() ?? "";

    if (button.dataset.cardSubmit !== undefined) {
      const form = button.closest<HTMLElement>(".gen-card");
      const text = form ? formMessage(form) : "";

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

    if (tab.windowId !== targetWindow || isPopout) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  });
}
