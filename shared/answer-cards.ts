import { resolveDiagramCite, type AnswerSourceMap, type DiagramCite } from "./answer-source.js";

export type RowSource = { tab: string; find: string };

export type Stat = { id?: string; label: string; value: string; formula?: string; note?: string; tag?: string; computed?: number; expr?: string; unit?: string; from?: RowSource };

export type CardInput = { id: string; label: string; value: number; min: number; max: number; step: number; unit?: string };

export type CardField = { id: string; label: string; value: string; options?: string[]; from?: string; required: boolean };

export type Cell = { value: string; expr?: string; unit?: string };

export type Block =
  | { kind: "inputs"; items: CardInput[] }
  | { kind: "app"; title: string; html: string; surface?: "ui" }
  | { kind: "fields"; items: CardField[] }
  | { kind: "stats"; items: Stat[] }
  | { kind: "steps"; items: Array<{ title: string; detail?: string }> }
  | { kind: "options"; items: Array<{ name: string; meta?: string; value?: Cell; why: string; pick: boolean; from?: RowSource }> }
  | { kind: "table"; cols: string[]; rows: Array<{ cells: Cell[]; tag?: string; from?: RowSource }> }
  | { kind: "checks"; items: Array<{ text: string; note?: string }> }
  | { kind: "callout"; tone: "info" | "warn"; text: string }
  | { kind: "diagram"; source: string; cites: Record<string, DiagramCite> };

export type CardButton = { label: string; tab?: string; submit?: boolean; primary: boolean };

export type PendingComponent = { tag: "stat" | "step" | "option" | "table" | "tr" | "check" | "callout" | "diagram"; written: string };

export type Card = { key: string; title: string; sub?: string; blocks: Block[]; buttons: CardButton[]; source?: string; closed: boolean; numbers: Set<string>; values: Map<string, string>; formulas: boolean; pending?: PendingComponent };

type AnswerPart = { prose: string } | { card: Card | undefined };

type Attrs = Record<string, string | true>;

const MAX_BUTTONS = 3;

const MAX_COLS = 5;

const CURRENCY = /^[¥￥$€£]$/;

const ATTRS = String.raw`((?:\s+[\w-]+(?:="[^"]*")?)*)`;

function attrsOf(source: string): Attrs {
  const out: Attrs = {};

  for (const m of source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]!] = m[2] ?? true;

  return out;
}

const str = (v: string | true | undefined) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits,
};

function calc(expression: string): number | undefined {
  const s = expression.replace(/[−–]/g, "-").replace(/×/g, "*").replace(/÷/g, "/").replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/\s+/g, "");
  const t = /[a-z]\(/.test(s) ? s : s.replace(/,/g, "");
  let i = 0;
  const eat = (token: string) => (t.startsWith(token, i) ? ((i += token.length), true) : false);
  const expect = (token: string) => { if (!eat(token)) throw new Error(token); };
  const atom = (): number => {
    if (eat("(")) {
      const v = ternary();

      expect(")");

      return v;
    }
    const name = /^[a-z]+(?=\()/.exec(t.slice(i))?.[0];

    if (name) {
      const fn = FUNCS[name];

      if (!fn) throw new Error(name);
      i += name.length + 1;
      const args = [ternary()];

      while (eat(",")) args.push(ternary());
      expect(")");

      return fn(...args);
    }
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(t.slice(i));

    if (!m) throw new Error("number");
    i += m[0].length;

    return Number(m[0]);
  };
  const unary = (): number => (eat("-") ? -unary() : eat("+") ? unary() : power());
  const power = (): number => {
    const base = atom();

    return eat("^") ? base ** unary() : base;
  };
  const product = (): number => {
    let v = unary();

    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) v /= unary();
      else return v;
    }
  };
  const sum = (): number => {
    let v = product();

    for (;;) {
      if (eat("+")) v += product();
      else if (eat("-")) v -= product();
      else return v;
    }
  };
  const compare = (): number => {
    const a = sum();

    for (const [op, test] of [[">=", (x: number, y: number) => x >= y], ["<=", (x: number, y: number) => x <= y], ["==", (x: number, y: number) => x === y], ["!=", (x: number, y: number) => x !== y], [">", (x: number, y: number) => x > y], ["<", (x: number, y: number) => x < y]] as const) {
      if (eat(op)) return test(a, sum()) ? 1 : 0;
    }

    return a;
  };
  const ternary = (): number => {
    const c = compare();

    if (!eat("?")) return c;
    const yes = ternary();

    expect(":");
    const no = ternary();

    return c ? yes : no;
  };

  try {
    const v = ternary();

    return i === t.length && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined;
  } catch {
    return undefined;
  }
}

const NAME = /[A-Za-z_]\w*/g;

export function evaluate(expression: string, vars: ReadonlyMap<string, number>): number | undefined {
  let unknown = false;
  const s = expression.replace(NAME, (name) => {
    if (name in FUNCS) return name;
    const v = vars.get(name);

    if (v === undefined) unknown = true;

    return v !== undefined && v < 0 ? `(${v})` : String(v);
  });

  return unknown ? undefined : calc(s);
}

const usesVars = (expression: string, vars: ReadonlyMap<string, number>) => [...expression.matchAll(NAME)].some((m) => vars.has(m[0]));

export function showFormula(expression: string, vars: ReadonlyMap<string, number>): string {
  return prettyFormula(expression.replace(NAME, (name) => (name in FUNCS ? name : String(vars.get(name) ?? name))));
}

export const showValue = (n: number, unit?: string) => withUnit(formatNumber(n), unit);

const formatNumber = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

const prettyFormula = (f: string) => f.replace(/\s+/g, "").replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\+/g, " + ").replace(/(\d|\))-/g, "$1 − ").replace(/>=/g, " ≥ ").replace(/<=/g, " ≤ ").replace(/([^ ≥≤])([<>])/g, "$1 $2 ").replace(/\?/g, " ? ").replace(/:/g, " : ").replace(/,/g, ", ");

const plain = (n: string) => String(Number(n.replace(/,/g, "")));

function withUnit(value: string, unit: string | undefined): string {
  if (!unit || !/^-?[\d,]+(?:\.\d+)?$/.test(value)) return value;

  return CURRENCY.test(unit) ? `${unit}${value}` : unit === "%" ? `${value}%` : `${value} ${unit}`;
}

const MAX_INPUTS = 2;

const MAX_FIELDS = 6;

const SECRET_FIELD_ZH = /密码|口令|卡号|信用卡|银行卡|储蓄卡|有效期|验证码|校验码|安全码|动态码|身份证/;

const SECRET_FIELD_EN = /\b(?:pin|cvv\d?|cvc\d?|otp\w*|password\w*|passcode|card\s*num(?:ber)?|security\s*code|one[-\s]*time\w*)\b/i;

function cardField(a: Attrs): CardField | undefined {
  const id = str(a.id);
  const label = str(a.label);

  const visible = (t: string) => t.normalize("NFKC").replace(/[\p{Cf}\u00ad\u180e]/gu, "");

  const words = visible(`${label} ${(id ?? "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")}`);

  if (!id || !/^[A-Za-z_]\w*$/.test(id) || !label || SECRET_FIELD_ZH.test(words.replace(/\s+/g, "")) || SECRET_FIELD_EN.test(words)) return undefined;
  const options = str(a.options)?.split("|").map((o) => o.trim()).filter(Boolean).slice(0, 6);
  const value = str(a.value) ?? "";

  return { id, label: visible(label), value: options?.length && !options.includes(value) ? "" : value, options: options?.length ? options : undefined, from: str(a.from), required: a.optional === undefined };
}

function digest(s: string): string {
  let h = 5381;

  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) | 0;

  return (h >>> 0).toString(36);
}

const num = (v: string | true | undefined) => (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

function cardInput(a: Attrs): CardInput | undefined {
  const id = str(a.id);
  const label = str(a.label);
  const value = num(a.value);

  if (!id || !/^[A-Za-z_]\w*$/.test(id) || id in FUNCS || !label || value === undefined || value < 0) return undefined;
  const step = num(a.step) ?? (Number.isInteger(value) ? 1 : 0.1);
  const min = num(a.min) ?? 0;
  const max = num(a.max) ?? Math.max(value * 3, value + step * 10);

  if (step <= 0 || min > max) return undefined;

  return { id, label, value: Math.min(max, Math.max(min, value)), min, max, step, unit: str(a.unit) };
}

const cell = (v: { value: string; expr?: string; unit?: string }): Cell => ({ value: v.value, expr: v.expr, unit: v.unit });

function rowSource(tab: string | true | undefined, raws: string[]): RowSource | undefined {
  const id = typeof tab === "string" && /^\d+$/.test(tab.trim()) ? tab.trim() : undefined;

  if (!id) return undefined;

  for (const raw of raws) {
    const body = raw.startsWith("=") ? raw.slice(1).replace(/[¥￥$€£\s]/g, "") : raw;
    const n = /[−-]?\d[\d,]*(?:\.\d+)?/.exec(body)?.[0]?.replace("−", "-");

    if (n) return { tab: id, find: n };
  }

  return undefined;
}

function htmlCellText(source: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return source.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, key: string) => {
    if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? raw;
    const value = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : raw;
  }).replace(/\s+/g, " ").trim();
}

function parseCard(source: string, closed: boolean): Card | undefined {
  const head = new RegExp(String.raw`^<card${ATTRS}\s*>`).exec(source);

  if (!head) return undefined;
  const top = attrsOf(head[1]!);
  const card: Card = { key: digest(source), title: str(top.title) ?? "", sub: str(top.sub), blocks: [], buttons: [], closed, numbers: new Set(), values: new Map(), formulas: false };

  for (const n of source.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) card.numbers.add(plain(n));
  let tagged = false;
  let picked = false;
  let primary = false;
  const resolve = (raw: string, unit?: string): { value: string; computed?: number; formula?: string; expr?: string; unit?: string } => {
    if (!raw.startsWith("=")) return { value: withUnit(raw, unit) };
    const symbol = /[¥￥$€£]/.exec(raw)?.[0];
    const expression = raw.slice(1).replace(/[¥￥$€£]/g, "").replace(/\s*元\s*$/, "");
    const live = usesVars(expression, vars);
    const n = live ? evaluate(expression, vars) : calc(expression);
    unit ??= symbol ?? (/元\s*$/.test(raw) ? "元" : undefined);

    if (n === undefined) return { value: withUnit(raw.slice(1).trim(), unit === symbol ? undefined : unit) };
    card.numbers.add(String(n));
    const formula = live ? showFormula(expression, vars) : /[-+*/×÷−^?(]/.test(expression.replace(/^\s*-/, "")) ? prettyFormula(expression) : undefined;

    if (formula) card.formulas = true;

    return { value: withUnit(formatNumber(n), unit), computed: n, formula, ...(live ? { expr: expression.replace(/\s+/g, ""), unit } : {}) };
  };
  const last = () => card.blocks.at(-1);
  const group = <K extends Block["kind"]>(kind: K, make: () => Extract<Block, { kind: K }>): Extract<Block, { kind: K }> => {
    const b = last();

    if (b?.kind === kind) return b as Extract<Block, { kind: K }>;
    const fresh = make();
    card.blocks.push(fresh);

    return fresh;
  };
  let body = source.slice(head[0].length);
  const diagramAt = body.indexOf("<diagram>");
  let diagram: Extract<Block, { kind: "diagram" }> | undefined;
  const cites: Array<{ node: string; cite: DiagramCite }> = [];

  if (diagramAt >= 0 && !closed) {
    body = body.slice(0, diagramAt);
  } else if (diagramAt >= 0) {
    const end = body.indexOf("</diagram>", diagramAt);
    const text = body.slice(diagramAt + "<diagram>".length, end < 0 ? undefined : end).trim();

    body = `${body.slice(0, diagramAt)}<diagram-at />${end < 0 ? "" : body.slice(end + "</diagram>".length)}`;

    if (text) diagram = { kind: "diagram", source: text, cites: {} };
    body = body.replace(new RegExp(String.raw`<cite\b${ATTRS}\s*(?:/>|>([\s\S]*?)<\/cite>)`, "g"), (_all, rawAttrs: string, inner: string) => {
      const a = attrsOf(rawAttrs);
      const node = str(a.node);

      if (node && str(a.anchor)) cites.push({ node, cite: { source: str(a.source) ?? '', anchor: str(a.anchor)! } });
      else if (node && inner?.trim()) cites.push({ node, cite: { text: inner.trim(), from: str(a.from) } });

      return "";
    });
  }
  const htmlRows: string[][] = [];
  body = body.replace(/<tr\s*>([\s\S]*?)<\/tr\s*>/gi, (raw, inner: string) => {
    const cells = [...inner.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td\s*>/gi)].map(m => htmlCellText(m[1] ?? ""));
    if (cells.length < 2) return raw;
    const index = htmlRows.push(cells) - 1;
    return `<tr html-row="${index}" />`;
  });
  const component = new RegExp(String.raw`<(input|field|stat|step|option|table|tr|check|callout|button|source|diagram-at)\b${ATTRS}\s*\/?>(?:([^<]*)<\/\1>)?`, "g");
  const inputs = new Map<string, CardInput>();

  for (const m of body.matchAll(new RegExp(String.raw`<input\b${ATTRS}\s*\/?>`, "g"))) {
    const input = cardInput(attrsOf(m[1] ?? ""));

    if (input && !inputs.has(input.id) && inputs.size < MAX_INPUTS) inputs.set(input.id, input);
  }
  const vars = new Map([...inputs].map(([id, input]) => [id, input.value]));
  const fieldIds = new Set<string>();

  for (const input of inputs.values()) card.values.set(input.id, withUnit(formatNumber(input.value), input.unit));

  for (const m of body.matchAll(component)) {
    const [, tag, rawAttrs, inner] = m;
    const a = attrsOf(rawAttrs ?? "");
    const text = inner?.trim();

    if (tag === "field") {
      const field = cardField(a);
      const block = group("fields", () => ({ kind: "fields", items: [] }));

      if (field && !fieldIds.has(field.id) && fieldIds.size < MAX_FIELDS) { fieldIds.add(field.id); block.items.push(field); }
    } else if (tag === "input") {
      const id = str(a.id);
      const input = id ? inputs.get(id) : undefined;
      const block = group("inputs", () => ({ kind: "inputs", items: [] }));

      if (input && !block.items.includes(input)) block.items.push(input);
    } else if (tag === "stat") {
      const label = str(a.label);
      const raw = str(a.value);

      if (!label || !raw) continue;
      const v = resolve(raw, str(a.unit));

      if (raw.startsWith("=") && v.computed === undefined) continue;
      const stat: Stat = { id: inputs.has(str(a.id) ?? "") ? undefined : str(a.id), label, value: v.value, formula: v.formula, computed: v.computed, note: str(a.note), expr: v.expr, unit: v.unit, from: rowSource(a.tab, [raw]) };

      if (str(a.tag) && !tagged) { stat.tag = str(a.tag); tagged = true; }

      if (stat.id) card.values.set(stat.id, stat.value);
      group("stats", () => ({ kind: "stats", items: [] })).items.push(stat);
    } else if (tag === "step") {
      const title = str(a.title);

      if (title) group("steps", () => ({ kind: "steps", items: [] })).items.push({ title, detail: str(a.detail) });
    } else if (tag === "option") {
      const name = str(a.name);
      const why = str(a.why);

      if (!name || !why) continue;
      const pick: boolean = a.pick !== undefined && !picked;
      picked ||= pick;
      group("options", () => ({ kind: "options", items: [] })).items.push({ name, meta: str(a.meta), value: a.value === undefined ? undefined : cell(resolve(str(a.value) ?? "", str(a.unit))), why, pick, from: rowSource(a.tab, [str(a.value) ?? ""]) });
    } else if (tag === "table") {
      const cols = (str(a.cols) ?? "").split("|").map((c) => c.trim()).slice(0, MAX_COLS);

      if (cols.length > 1) card.blocks.push({ kind: "table", cols, rows: [] });
    } else if (tag === "tr") {
      const table = last();
      const rowIndex = str(a["html-row"]);
      const cells = rowIndex !== undefined && /^\d+$/.test(rowIndex) ? htmlRows[Number(rowIndex)] ?? [] : (str(a.cells) ?? "").split("|").map((c) => c.trim());

      if (table?.kind !== "table" || cells.length < 2) continue;
      const rowTag = str(a.tag) && !table.rows.some((r) => r.tag) ? str(a.tag) : undefined;
      table.rows.push({ cells: Array.from({ length: table.cols.length }, (_, i) => cell(resolve(cells[i] ?? ""))), tag: rowTag, from: rowSource(a.tab, cells.slice(1)) });
    } else if (tag === "check") {
      const t = str(a.text);

      if (t) group("checks", () => ({ kind: "checks", items: [] })).items.push({ text: t, note: str(a.note) });
    } else if (tag === "callout") {
      if (text && !card.blocks.some((b) => b.kind === "callout")) card.blocks.push({ kind: "callout", tone: a.tone === "warn" ? "warn" : "info", text });
    } else if (tag === "button") {
      if (!text || card.buttons.length >= MAX_BUTTONS) continue;
      const isPrimary: boolean = a.primary !== undefined && !primary;
      primary ||= isPrimary;

      if (a.action === "tab" && /^\d+$/.test(str(a.target) ?? "")) card.buttons.push({ label: text, tab: str(a.target), primary: isPrimary });
      else if (a.action === "say") card.buttons.push({ label: text, primary: isPrimary });
      else if (a.action === "submit" && !card.buttons.some((b) => b.submit)) card.buttons.push({ label: text, submit: true, primary: isPrimary });
    } else if (tag === "source") {
      if (text) card.source = text;
    } else if (tag === "diagram-at" && diagram) {
      for (const c of cites) diagram.cites[c.node] = c.cite;
      card.blocks.push(diagram);
    }
  }

  const lastOpen = closed ? undefined : [...body.matchAll(/<(?:stat|step|option|table|tr|check|callout)\s/g)].at(-1)?.index;
  const tail = lastOpen === undefined ? "" : body.slice(lastOpen);
  const open = /^<(stat|step|option|table|tr|check|callout)\s((?:[^<>"]|"[^"]*")*(?:"[^"]*)?)$/.exec(tail) ?? /^<(callout)\b([^<>]*)>[^<]*(?:<\/?[a-z]*)?$/.exec(tail);

  if (diagramAt >= 0 && !closed) card.pending = { tag: "diagram", written: "" };
  else if (open) card.pending = { tag: open[1] as PendingComponent["tag"], written: open[2] ?? "" };

  return card.title || card.blocks.length ? card : undefined;
}

type EvidenceRow = { label: string; value: string; formula?: string; source?: string; tab?: string; expr?: string; unit?: string };

export function cardEvidence(card: Card): EvidenceRow[] {
  const stats = card.blocks.flatMap((b) => (b.kind === "stats" ? b.items : []));

  if (!card.closed || !stats.some((s) => s.formula) && !card.source) return [];
  const tabs = card.buttons.flatMap((b) => {
    const name = b.label.replace(/^(?:切到|切换到|去|打开|回到)/, "").replace(/(?:页面|那页|这页|页)?(?:看看|看)?$/, "").trim();

    return b.tab && name.length >= 2 ? [{ name, tab: b.tab }] : [];
  });

  const named = stats.map((s) => {
    const hits = tabs.filter((t) => s.label.includes(t.name));
    const own = hits.filter((t) => !hits.some((o) => o !== t && o.name.includes(t.name)));

    return own.length === 1 ? own[0] : undefined;
  });

  return stats.map((s, i) => ({ label: s.label, value: s.value, formula: s.formula, expr: s.expr, unit: s.unit, source: card.source, tab: named[i] && named.filter((t) => t?.name === named[i]!.name).length === 1 ? named[i]!.tab : undefined }));
}

const MAY_HAVE_CARD = /<card[\s>]|(?:^|\n)<diagram>/;

function codeRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g)]
    .filter((m) => m[0].startsWith("```") || m[0].startsWith("~~~") || !/<card[\s>]/.test(m[0]) || m[0].includes("</card>") || text.indexOf("</card>", m.index + m[0].length) < 0)
    .map((m) => [m.index, m.index + m[0].length]);
}

export function cardSpans(text: string): CardSpan[] {
  let masked = text;
  const plainCode = codeRanges(text);

  for (const m of text.matchAll(/<(app|ui)[\s>]/g)) {
    const open = `<${m[1]}`;

    if (plainCode.some(([a, b]) => m.index >= a && m.index < b) || masked.slice(m.index, m.index + open.length) !== open) continue;
    const close = text.indexOf(`</${m[1]}>`, m.index);
    const end = close < 0 ? text.length : close;

    masked = masked.slice(0, m.index + open.length) + " ".repeat(Math.max(0, end - m.index - open.length)) + masked.slice(end);
  }
  const code = codeRanges(masked);
  const spans: CardSpan[] = [];
  let at = 0;

  for (const m of masked.matchAll(/<(card|app|ui)[\s>]|(?<=^|\n)<diagram>/g)) {
    if (m.index < at || code.some(([a, b]) => m.index >= a && m.index < b)) continue;

    if (!m[1]) {
      const span = bareDiagram(text, m.index);
      at = span.end;
      spans.push({ tag: "card", ...span });
      continue;
    }
    const tag = m[1] as CardSpan["tag"];
    const close = text.indexOf(`</${tag}>`, m.index);

    at = close < 0 ? text.length : close + tag.length + 3;
    spans.push({ tag, start: m.index, end: at, closed: close >= 0 });
  }

  return spans;
}

export type CardSpan = { tag: "card" | "app" | "ui"; start: number; end: number; closed: boolean; bare?: { bodyEnd: number } };

function bareDiagram(text: string, start: number): Omit<CardSpan, "tag"> {
  const close = text.indexOf("</diagram>", start);

  if (close < 0) return { start, end: text.length, closed: false, bare: { bodyEnd: text.length } };
  let end = close + "</diagram>".length;

  for (;;) {
    const cite = /^\s*<cite\b[^>]*?(?:\/>|>[\s\S]*?<\/cite>)/.exec(text.slice(end));

    if (cite) { end += cite[0].length; continue; }
    const rest = text.slice(end);
    const writing = /^\s*<(?:c(?:i(?:t(?:e)?)?)?)?$|^\s*<cite\b/.test(rest) && /\S/.test(rest);

    return { start, end: writing ? text.length : end, closed: true, bare: { bodyEnd: end } };
  }
}

function parseApp(source: string, closed: boolean, tag: "app" | "ui"): Card | undefined {
  const head = new RegExp(String.raw`^<${tag}${ATTRS}\s*>`).exec(source);

  if (!head) return undefined;
  const html = source.slice(head[0].length).replace(new RegExp(`</${tag}>$`), "").trim();

  return { key: digest(html), title: "", blocks: [{ kind: "app", title: str(attrsOf(head[1]!).title) ?? (tag === "ui" ? "界面" : "小程序"), html, ...(tag === "ui" ? { surface: "ui" as const } : {}) }], buttons: [], closed, numbers: new Set(), values: new Map(), formulas: false };
}

export function splitAnswer(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let at = 0;

  for (const span of cardSpans(text)) {
    parts.push({ prose: text.slice(at, span.start) });
    const body = span.bare ? `<card>\n${text.slice(span.start, span.bare.bodyEnd)}` : text.slice(span.start, span.closed ? span.end - span.tag.length - 3 : span.end);

    parts.push({ card: span.tag === "card" ? parseCard(body, span.closed) : parseApp(body, span.closed, span.tag) });
    at = span.end;
  }

  if (at < text.length) parts.push({ prose: text.slice(at).replace(/(?:<(?:c(?:a(?:r(?:d)?)?)?|a(?:p(?:p)?)?)?|(?<=^|\n)<d(?:i(?:a(?:g(?:r(?:a(?:m)?)?)?)?)?)?|\{=[\w-]*)$/, "") });

  return parts;
}

const outsideCode = (text: string, edit: (prose: string) => string) => text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/).map((part, i) => (i % 2 ? part : edit(part))).join("");

export function resolveProse(prose: string, cards: Card[], mark = (value: string, _id: string) => value): string {
  const values = new Map(cards.flatMap((c) => [...c.values]).reverse());
  const done = cards.some((c) => c.closed);
  const guard = done && cards.some((c) => c.formulas);
  const numbers = new Set(cards.flatMap((c) => [...c.numbers]));

  return outsideCode(prose, (part) => {
    const out = fillRefs(part, values, mark, done ? "见下方卡片" : "…");

    return guard ? out.replace(/((?:预算|低于|高于|不超过|不到|超过|至少|最多|以内)\s*(?:是|为)?\s*)?[¥￥$]\s?(\d[\d,]*(?:\.\d+)?)(?!\d|[.,]\d|\s*(?:万|千|亿|[kKwW]|以内|以下|以上|左右|起))/g, (all, condition: string | undefined, n: string) => (condition || numbers.has(plain(n)) ? all : "见下方卡片")) : out;
  });
}

export function fillRefs(text: string, values: ReadonlyMap<string, string>, mark: (value: string, id: string) => string, missing: string): string {
  let out = "";
  let at = 0;

  for (const m of text.matchAll(/\{=([A-Za-z_][\w-]*)\}/g)) {
    out += text.slice(at, m.index);
    at = m.index + m[0].length;
    const v = values.get(m[1]!);

    if (!v) { out += missing; continue; }
    out += mark(v, m[1]!);
    const unit = /[\d.,]\s*(\S+)$/.exec(v)?.[1];
    const repeated = unit ? /^[ \t]*/.exec(text.slice(at))![0].length : -1;

    if (unit && text.startsWith(unit, at + repeated)) at += repeated + unit.length;
  }

  return out + text.slice(at);
}

export function answerSpeech(text: string): string {
  if (!MAY_HAVE_CARD.test(text) && !text.includes("{=")) return text;
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const prose = parts.map((p) => ("prose" in p ? resolveProse(p.prose, cards) : "")).join("").replace(/\n{3,}/g, "\n\n").trim();

  return prose || cards.map((c) => c.title).filter(Boolean).join("；");
}

export function diagramLabel(source: string, node: string): string {
  const label = new RegExp(String.raw`(?:^|[\s&;>])${node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*[[({>]+\s*"([^"]*)"`, "m").exec(source)?.[1];

  return label ? label.replace(/<br\s*\/?>/gi, " ").trim() : node;
}

export function answerMarkdown(text: string, sources?: AnswerSourceMap): string {
  if (!MAY_HAVE_CARD.test(text) && !text.includes("{=")) return text;
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const values = new Map(cards.flatMap((c) => [...c.values]).reverse());
  const t = (text: string) => fillRefs(text, values, (v) => v, "…");
  const md = (c: Card) => [c.title ? `**${t(c.title)}**${c.sub ? `（${t(c.sub)}）` : ""}` : "", ...c.blocks.map((b) => {
    switch (b.kind) {
      case "stats": return b.items.map((s) => `- ${t(s.label)}：${s.value}${s.formula ? `（${s.formula}）` : ""}${s.note ? `，${t(s.note)}` : ""}${s.tag ? ` · ${s.tag}` : ""}`).join("\n");
      case "steps": return b.items.map((s, i) => `${i + 1}. ${t(s.title)}${s.detail ? `：${t(s.detail)}` : ""}`).join("\n");
      case "options": return b.items.map((o) => `- ${t(o.name)}${o.pick ? "（推荐）" : ""}${o.value ? ` ${o.value.value}` : ""}${o.meta ? `，${t(o.meta)}` : ""}：${t(o.why)}`).join("\n");
      case "table": return [`| ${b.cols.join(" | ")} |`, `|${b.cols.map(() => " --- ").join("|")}|`, ...b.rows.map((r) => `| ${r.cells.map((c) => c.value).join(" | ")}${r.tag ? `（${r.tag}）` : ""} |`)].join("\n");
      case "checks": return b.items.map((c) => `- [ ] ${t(c.text)}${c.note ? `（${t(c.note)}）` : ""}`).join("\n");
      case "callout": return `> ${t(b.text)}`;
      case "inputs": return b.items.map((v) => `- ${v.label}：${showValue(v.value, v.unit)}`).join("\n");
      case "app": return b.surface === "ui" ? `（界面：${b.title}）` : `（小程序：${b.title}）`;
      case "fields": return b.items.map((f) => `- ${f.label}：${f.value || "（待填）"}${f.options ? `（可选：${f.options.join(" / ")}）` : ""}`).join("\n");
      case "diagram": return [`\`\`\`mermaid\n${b.source}\n\`\`\``, ...Object.entries(b.cites).map(([node, cite]) => { const c = resolveDiagramCite(cite, sources); return c ? (!("text" in cite) ? `- ${diagramLabel(b.source, node)}：${c.url ? `[查看原文](${c.url})` : c.from ?? "已读取的页面"}` : `- ${diagramLabel(b.source, node)}：“${c.text}”${c.from ? `（${c.from}）` : ""}`) : `- ${diagramLabel(b.source, node)}：来源未能核对`; })].join("\n");
    }
  }), c.source ? `来源：${c.source}` : ""].filter(Boolean).join("\n\n");

  return parts.map((p) => ("prose" in p ? resolveProse(p.prose, cards) : p.card ? `\n\n${md(p.card)}\n\n` : "")).join("").replace(/\n{3,}/g, "\n\n").trim();
}

export type CardPreview = { title: string; rows: Array<{ label: string; value?: string; tag?: string }>; more: number };

export function cardPreview(text: string, maxRows = 3): CardPreview | null {
  if (!MAY_HAVE_CARD.test(text)) return null;
  const card = splitAnswer(text).flatMap((p) => ("card" in p && p.card?.closed && (p.card.title || p.card.blocks.some((b) => !["diagram", "app", "inputs"].includes(b.kind))) ? [p.card] : []))[0];

  if (!card) return null;
  type Row = CardPreview["rows"][number];
  const rowsOf = (b: Block): Row[] => {
    switch (b.kind) {
      case "options": return b.items.map((o) => ({ label: o.name, value: o.value?.value ?? o.meta, tag: o.pick ? "推荐" : undefined }));
      case "table": return b.rows.map((r) => ({ label: r.cells[0]?.value ?? "", value: r.cells.slice(1).map((c) => c.value).filter(Boolean).join(" · ") || undefined, tag: r.tag }));
      case "stats": return b.items.map((s) => ({ label: s.label, value: s.value, tag: s.tag }));
      case "steps": return b.items.map((s, i) => ({ label: `${i + 1}. ${s.title}` }));
      case "checks": return b.items.map((c) => ({ label: c.text }));
      case "callout": return [{ label: b.text }];
      case "diagram":
      case "app":
      case "inputs": return [];
      case "fields": return b.items.map((f) => ({ label: f.label, value: f.value || undefined }));
    }
  };
  const block = card.blocks.find((b) => b.kind !== "callout" && rowsOf(b).length) ?? card.blocks.find((b) => rowsOf(b).length);
  const all = block ? rowsOf(block) : [];

  if (!card.title && !all.length) return null;
  const tagged = block?.kind === "steps" ? -1 : all.findIndex((r) => r.tag);
  const ordered = tagged > 0 ? [all[tagged]!, ...all.slice(0, tagged), ...all.slice(tagged + 1)] : all;

  const f = (value: string) => fillRefs(value, card.values, (v) => v, "…");

  return { title: f(card.title), rows: ordered.slice(0, maxRows).map((r) => ({ ...r, label: f(r.label), ...(r.value ? { value: f(r.value) } : {}) })), more: Math.max(0, ordered.length - maxRows) };
}
