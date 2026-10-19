/**
 * 回答里的卡片：解析与取数，侧栏、语音、复制共用。
 * 侧栏怎么画在 extension/src/sidepanel/answer-cards.ts；模型怎么写在 agent/src/prompt.ts 的「Answer cards」一节。
 *
 * - 只认代码块以外的 <card>…</card>；写到一半的组件不算，只记下它开了头（pending），侧栏据此放空位。
 * - 数由这里算：value 写成算式时算出结果；正文的 {=名字} 换成卡片算出的数。实验里模型心算的合计 9 次全错，卡片算式全对。
 * - 卡片里有算式时，卡片写完后，正文里不在卡片里的金额换成「见下方卡片」，不让心算错的数留在结论句里。
 */

/** expr：引用了可调的数的算式原文（如 68*months+398），用户改数时侧栏按它重算；只有常数的算式没有 expr。 */
/** 这一行的数出自哪个标签页：tab 是标签页编号，find 是到那一页去找的那个数（页面上原样写的数，不是算出来的）。 */
export type RowSource = { tab: string; find: string };

export type Stat = { id?: string; label: string; value: string; formula?: string; note?: string; tag?: string; computed?: number; expr?: string; unit?: string; from?: RowSource };

/** 用户能在卡片上调的数：算式用 id 引用它。 */
export type CardInput = { id: string; label: string; value: number; min: number; max: number; step: number; unit?: string };

/** 助手问用户时的一栏：有 options 就从中挑，没有就填字；from 是预填值的出处。 */
export type CardField = { id: string; label: string; value: string; options?: string[]; from?: string; required: boolean };

/** 选项的价、表格格子：值和可重算的算式。 */
export type Cell = { value: string; expr?: string; unit?: string };

export type Block =
  | { kind: "inputs"; items: CardInput[] }
  /** 助手当场写的小程序：整段网页原文，侧栏放进不联网的沙箱里运行。 */
  | { kind: "app"; title: string; html: string }
  | { kind: "fields"; items: CardField[] }
  | { kind: "stats"; items: Stat[] }
  | { kind: "steps"; items: Array<{ title: string; detail?: string }> }
  | { kind: "options"; items: Array<{ name: string; meta?: string; value?: Cell; why: string; pick: boolean; from?: RowSource }> }
  | { kind: "table"; cols: string[]; rows: Array<{ cells: Cell[]; tag?: string; from?: RowSource }> }
  | { kind: "checks"; items: Array<{ text: string; note?: string }> }
  | { kind: "callout"; tone: "info" | "warn"; text: string }
  | { kind: "diagram"; source: string; cites: Record<string, { text: string; from?: string }> };

/** submit：把卡片里各栏的名字和值合成一句用户的话发出。 */
export type CardButton = { label: string; tab?: string; submit?: boolean; primary: boolean };

/** 卡片末尾已经开了头、还没写完的组件：tag 是标签名，written 是已写出的属性原文（侧栏据此放尺寸接近的空位）。 */
export type PendingComponent = { tag: "stat" | "step" | "option" | "table" | "tr" | "check" | "callout" | "diagram"; written: string };

/** key：整张卡原文的摘要，用户在卡片上调过、勾过的状态按它存。 */
export type Card = { key: string; title: string; sub?: string; blocks: Block[]; buttons: CardButton[]; source?: string; closed: boolean; numbers: Set<string>; values: Map<string, string>; formulas: boolean; pending?: PendingComponent };

export type AnswerPart = { prose: string } | { card: Card | undefined };

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

/** 算式里能用的函数；可调的数不能用这些名字。 */
const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits,
};

/**
 * 算式的小解析器：扩展页面的 CSP 不允许动态求值。认数字、+ − × ÷、^、括号、比较（结果 1 或 0）、条件 a ? b : c、FUNCS 里的函数。
 * 乘方和条件是给房贷月供、分档折扣这类算式用的：真模型想写，但写不出来就只能心算。
 */
export function calc(expression: string): number | undefined {
  const s = expression.replace(/[−–]/g, "-").replace(/×/g, "*").replace(/÷/g, "/").replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/\s+/g, "");
  // 逗号：有函数时是参数分隔，没有时是千分位。
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
  // 右结合：2^3^2 = 2^9；-2^2 = -(2^2)。
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

/** 可调的数的名字：字母或下划线开头。 */
const NAME = /[A-Za-z_]\w*/g;

/** 把算式里可调的数的名字换成当前值再算；有不认识的名字就算不出。 */
export function evaluate(expression: string, vars: ReadonlyMap<string, number>): number | undefined {
  let unknown = false;
  const s = expression.replace(NAME, (name) => {
    if (name in FUNCS) return name;
    const v = vars.get(name);

    if (v === undefined) unknown = true;

    // 负数加括号：x^2 在 x = −2 时是 4，不是 -2^2 = −4。
    return v !== undefined && v < 0 ? `(${v})` : String(v);
  });

  return unknown ? undefined : calc(s);
}

/** 算式里出现了哪个可调的数。 */
const usesVars = (expression: string, vars: ReadonlyMap<string, number>) => [...expression.matchAll(NAME)].some((m) => vars.has(m[0]));

/** 给人看的算式：名字换成当前值，运算符换成 × ÷。 */
export function showFormula(expression: string, vars: ReadonlyMap<string, number>): string {
  return prettyFormula(expression.replace(NAME, (name) => (name in FUNCS ? name : String(vars.get(name) ?? name))));
}

/** 算出的数加千分位和单位。 */
export const showValue = (n: number, unit?: string) => withUnit(formatNumber(n), unit);

const formatNumber = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

const prettyFormula = (f: string) => f.replace(/\s+/g, "").replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\+/g, " + ").replace(/(\d|\))-/g, "$1 − ").replace(/>=/g, " ≥ ").replace(/<=/g, " ≤ ").replace(/([^ ≥≤])([<>])/g, "$1 $2 ").replace(/\?/g, " ? ").replace(/:/g, " : ").replace(/,/g, ", ");

/** 比较用的数：去掉千分位和多余的小数零。 */
const plain = (n: string) => String(Number(n.replace(/,/g, "")));

/** 货币符号放在数前面，其他单位放在后面；值里已经带了单位就不再加。 */
function withUnit(value: string, unit: string | undefined): string {
  if (!unit || !/^-?[\d,]+(?:\.\d+)?$/.test(value)) return value;

  return CURRENCY.test(unit) ? `${unit}${value}` : unit === "%" ? `${value}%` : `${value} ${unit}`;
}

const MAX_INPUTS = 2;

const MAX_FIELDS = 6;

/**
 * 密码、卡号、验证码这类栏不画：这些值只由用户自己在网页上填（hand_to_user），不经过侧栏和模型。
 * 模型可能被网页内容带偏，写出一张“请填写银行卡号”的表单，所以按名字拦，不靠提示词。
 */
const SECRET_FIELD_ZH = /密码|口令|卡号|信用卡|银行卡|储蓄卡|有效期|验证码|校验码|安全码|动态码|身份证/;

/** 英文按整词比：shipping 里的 pin 不算。 */
const SECRET_FIELD_EN = /\b(?:pin|cvv\d?|cvc\d?|otp\w*|password\w*|passcode|card\s*num(?:ber)?|security\s*code|one[-\s]*time\w*)\b/i;

function cardField(a: Attrs): CardField | undefined {
  const id = str(a.id);
  const label = str(a.label);

  // 先去掉看不见的字和空白再比：「密\u200b码」「验 证 码」看起来就是密码、验证码。显示的名字也去掉看不见的字。
  const visible = (t: string) => t.normalize("NFKC").replace(/[\p{Cf}\u00ad\u180e]/gu, "");

  // id 拆成词再比：user_password、userPassword 里的 password 也算。
  const words = visible(`${label} ${(id ?? "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")}`);

  if (!id || !/^[A-Za-z_]\w*$/.test(id) || !label || SECRET_FIELD_ZH.test(words.replace(/\s+/g, "")) || SECRET_FIELD_EN.test(words)) return undefined;
  const options = str(a.options)?.split("|").map((o) => o.trim()).filter(Boolean).slice(0, 6);
  const value = str(a.value) ?? "";

  return { id, label: visible(label), value: options?.length && !options.includes(value) ? "" : value, options: options?.length ? options : undefined, from: str(a.from), required: a.optional === undefined };
}

/** 卡片原文的摘要：同一张卡重开、重放时不变。 */
function digest(s: string): string {
  let h = 5381;

  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) | 0;

  return (h >>> 0).toString(36);
}

const num = (v: string | true | undefined) => (typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** 不能用的可调的数不画：名字不合规、值不是数、范围反了。没写范围时按值给一个够用的范围。 */
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

/**
 * 一行的出处：写了数字 tab，并且这一行有数。算式取它的第一个数（=6199+15 取 6199）：比价时最要紧的那一行多半是“标价 + 运费”算出来的，
 * 页面上没有算出的数，但第一个数就是页面上的标价，圈它就是这一行的出处。
 */
function rowSource(tab: string | true | undefined, raws: string[]): RowSource | undefined {
  const id = typeof tab === "string" && /^\d+$/.test(tab.trim()) ? tab.trim() : undefined;

  if (!id) return undefined;

  for (const raw of raws) {
    const body = raw.startsWith("=") ? raw.slice(1).replace(/[¥￥$€£\s]/g, "") : raw;
    // 负号留着：页面上的 -50（优惠）和 50 是两个数。
    const n = /[−-]?\d[\d,]*(?:\.\d+)?/.exec(body)?.[0]?.replace("−", "-");

    if (n) return { tab: id, find: n };
  }

  return undefined;
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
  /**
   * 卡片里任何一处值（数字格、选项的价、表格格子）写成算式（= 开头）时都在这里算：模型会把算式也写进选项和表格，不只数字格。
   * 算不出就去掉 =，原样显示，不把「=1699-50」露给用户。
   */
  const resolve = (raw: string, unit?: string): { value: string; computed?: number; formula?: string; expr?: string; unit?: string } => {
    if (!raw.startsWith("=")) return { value: withUnit(raw, unit) };
    // 模型有时把货币符号或「元」也写进算式（=¥1699-50）：先拿掉再算，符号当单位用。
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

    // SAFETY: kind 相同即同一种块。
    if (b?.kind === kind) return b as Extract<Block, { kind: K }>;
    const fresh = make();
    card.blocks.push(fresh);

    return fresh;
  };
  /**
   * 图等整张卡写完才画：边写边画时每加一行整张图都会重排，图后面的原文（cite）也要写完才能点。
   * 没写完时只放图前面的组件和图的空位，空位的位置就是图的位置，收尾时原位换成图。
   * 图的原文里有 <br/>、-->，原文摘录里可能有网页上的任何字（包括像 <button> 的字），都不走下面的组件正则。
   */
  let body = source.slice(head[0].length);
  const diagramAt = body.indexOf("<diagram>");
  let diagram: Extract<Block, { kind: "diagram" }> | undefined;
  const cites: Array<{ node: string; text: string; from?: string }> = [];

  if (diagramAt >= 0 && !closed) {
    body = body.slice(0, diagramAt);
  } else if (diagramAt >= 0) {
    const end = body.indexOf("</diagram>", diagramAt);
    const text = body.slice(diagramAt + "<diagram>".length, end < 0 ? undefined : end).trim();

    body = `${body.slice(0, diagramAt)}<diagram-at />${end < 0 ? "" : body.slice(end + "</diagram>".length)}`;

    if (text) diagram = { kind: "diagram", source: text, cites: {} };
    body = body.replace(new RegExp(String.raw`<cite\b${ATTRS}\s*>([\s\S]*?)<\/cite>`, "g"), (_all, rawAttrs: string, inner: string) => {
      const a = attrsOf(rawAttrs);
      const node = str(a.node);

      if (node && inner.trim()) cites.push({ node, text: inner.trim(), from: str(a.from) });

      return "";
    });
  }
  const component = new RegExp(String.raw`<(input|field|stat|step|option|table|tr|check|callout|button|source|diagram-at)\b${ATTRS}\s*\/?>(?:([^<]*)<\/\1>)?`, "g");
  // 可调的数先全部认出来：算式可能写在它前面。
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

      // 同一个 id 在整张卡里只认第一个：存下来的值按 id 还原，两栏同名会互相盖掉。
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

      // 数字格的算式算不出就不画这一格：它就是给人照着做决定的数。
      if (raw.startsWith("=") && v.computed === undefined) continue;
      // 和可调的数同名的 id 不要：正文里的 {=名字} 只能有一个来源。
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
      const cells = (str(a.cells) ?? "").split("|").map((c) => c.trim());

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
      for (const c of cites) diagram.cites[c.node] = { text: c.text, from: c.from };
      card.blocks.push(diagram);
    }
  }

  // 没写完的卡片：末尾开了头的组件记下来。只认真的开头（「<stat 」），不猜后面还有几个；
  // 只看最后一个开头标签，前面哪个属性少了引号也不会一路配到末尾。
  const lastOpen = closed ? undefined : [...body.matchAll(/<(?:stat|step|option|table|tr|check|callout)\s/g)].at(-1)?.index;
  const tail = lastOpen === undefined ? "" : body.slice(lastOpen);
  const open = /^<(stat|step|option|table|tr|check|callout)\s((?:[^<>"]|"[^"]*")*(?:"[^"]*)?)$/.exec(tail) ?? /^<(callout)\b([^<>]*)>[^<]*(?:<\/?[a-z]*)?$/.exec(tail);

  if (diagramAt >= 0 && !closed) card.pending = { tag: "diagram", written: "" };
  // SAFETY: 两个正则的第一组只会是 PendingComponent 列出的标签名。
  else if (open) card.pending = { tag: open[1] as PendingComponent["tag"], written: open[2] ?? "" };

  return card.title || card.blocks.length ? card : undefined;
}

/** 依据面的一行：卡片上的一个数字格。tab 是指向这一项的「切到…看」按钮的标签页。 */
export type EvidenceRow = { label: string; value: string; formula?: string; source?: string; tab?: string; expr?: string; unit?: string };

/**
 * 卡片的依据面：每个数字格一行，只用卡片已有的数据（算式、source、tab 按钮），不补写。
 * tab 按钮写的是「切到拼多多看」这种话，按名字落到标签含这个名字的那一格；对不上或对上不止一格就不挂，不猜。
 * 没写完、没有数字格、既没算式也没出处的卡片没有依据面。选项和表格里的算式不列：它们只留下了结果。
 */
export function cardEvidence(card: Card): EvidenceRow[] {
  const stats = card.blocks.flatMap((b) => (b.kind === "stats" ? b.items : []));

  if (!card.closed || !stats.some((s) => s.formula) && !card.source) return [];
  const tabs = card.buttons.flatMap((b) => {
    const name = b.label.replace(/^(?:切到|切换到|去|打开|回到)/, "").replace(/(?:页面|那页|这页|页)?(?:看看|看)?$/, "").trim();

    return b.tab && name.length >= 2 ? [{ name, tab: b.tab }] : [];
  });

  // 每格取它标签里出现的名字，被更长的名字包含的不算（「京东自营」不落到「京东」）；剩下不止一个（差价这类算出来的格），
  // 或同一个名字落到不止一格，都不挂：宁可不给「指给我看」，也不指错。
  const named = stats.map((s) => {
    const hits = tabs.filter((t) => s.label.includes(t.name));
    const own = hits.filter((t) => !hits.some((o) => o !== t && o.name.includes(t.name)));

    return own.length === 1 ? own[0] : undefined;
  });

  return stats.map((s, i) => ({ label: s.label, value: s.value, formula: s.formula, expr: s.expr, unit: s.unit, source: card.source, tab: named[i] && named.filter((t) => t?.name === named[i]!.name).length === 1 ? named[i]!.tab : undefined }));
}

/** 代码块和行内代码的范围：里面的 <card、{=…}、金额都按原文处理。 */
export function codeRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)]
    // 一对反引号里有 <card、后面又有真的 </card>：是正文里落单的反引号碰上了卡片属性里的反引号，不当代码。
    .filter((m) => m[0].startsWith("```") || !/<card[\s>]/.test(m[0]) || m[0].includes("</card>") || text.indexOf("</card>", m.index + m[0].length) < 0)
    .map((m) => [m.index, m.index + m[0].length]);
}

/**
 * 回答里的卡片和小程序各在哪：start 是开头，end 是收尾标签之后（没写完时是全文结尾）。代码块里讲写法的 <card 不算。
 * 小程序里是整段网页，常有反引号（JS 模板字符串）：先把小程序的内容盖掉再找代码块，免得一个反引号把后面的卡片都算成代码。
 */
export function cardSpans(text: string): Array<{ tag: "card" | "app"; start: number; end: number; closed: boolean }> {
  let masked = text;
  const plainCode = codeRanges(text);

  // 代码里讲写法的 <app 不是小程序，不盖。
  for (const m of text.matchAll(/<app[\s>]/g)) {
    if (plainCode.some(([a, b]) => m.index >= a && m.index < b) || masked.slice(m.index, m.index + 4) !== "<app") continue;
    const close = text.indexOf("</app>", m.index);
    const end = close < 0 ? text.length : close;

    masked = masked.slice(0, m.index + 4) + " ".repeat(Math.max(0, end - m.index - 4)) + masked.slice(end);
  }
  const code = codeRanges(masked);
  const spans: Array<{ tag: "card" | "app"; start: number; end: number; closed: boolean }> = [];
  let at = 0;

  for (const m of masked.matchAll(/<(card|app)[\s>]/g)) {
    if (m.index < at || code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    // SAFETY: 正则只认 card、app 两个名字。
    const tag = m[1] as "card" | "app";
    const close = text.indexOf(`</${tag}>`, m.index);

    at = close < 0 ? text.length : close + tag.length + 3;
    spans.push({ tag, start: m.index, end: at, closed: close >= 0 });
  }

  return spans;
}

function parseApp(source: string, closed: boolean): Card | undefined {
  const head = new RegExp(String.raw`^<app${ATTRS}\s*>`).exec(source);

  if (!head) return undefined;
  const html = source.slice(head[0].length).replace(/<\/app>$/, "").trim();

  return { key: digest(html), title: "", blocks: [{ kind: "app", title: str(attrsOf(head[1]!).title) ?? "小程序", html }], buttons: [], closed, numbers: new Set(), values: new Map(), formulas: false };
}

/** 回答原文切成正文与卡片（小程序也算一种卡片）。没写完的 closed 为 false。 */
export function splitAnswer(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let at = 0;

  for (const span of cardSpans(text)) {
    parts.push({ prose: text.slice(at, span.start) });
    const body = text.slice(span.start, span.closed ? span.end - span.tag.length - 3 : span.end);

    parts.push({ card: span.tag === "app" ? parseApp(body, span.closed) : parseCard(body, span.closed) });
    at = span.end;
  }

  // 结尾写到一半的「<car」「<ap」「{=to」不露出来。
  if (at < text.length) parts.push({ prose: text.slice(at).replace(/(?:<(?:c(?:a(?:r(?:d)?)?)?|a(?:p(?:p)?)?)?|\{=[\w-]*)$/, "") });

  return parts;
}

/** 只改代码以外、链接文字以外的正文。 */
const outsideCode = (text: string, edit: (prose: string) => string) => text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/).map((part, i) => (i % 2 ? part : edit(part))).join("");

/**
 * 正文：{=名字} 换成卡片算出的数（卡片还没写到时先显示「…」）。
 * 卡片里有算式、且卡片已写完时，正文里不在卡片里的金额换成「见下方卡片」；
 * 后面跟着 万/千/以内 这类字的、前面是“预算/低于/不超过”这类字的，是用户的条件或约数，不换。
 */
export function resolveProse(prose: string, cards: Card[], mark = (value: string, _id: string) => value): string {
  // 同名的数以第一张卡为准，侧栏重算时也只让这张卡改正文。
  const values = new Map(cards.flatMap((c) => [...c.values]).reverse());
  const done = cards.some((c) => c.closed);
  const guard = done && cards.some((c) => c.formulas);
  const numbers = new Set(cards.flatMap((c) => [...c.numbers]));

  return outsideCode(prose, (part) => {
    const out = part.replace(/\{=([A-Za-z_][\w-]*)\}/g, (_all, id: string) => {
      const v = values.get(id);

      if (v) return mark(v, id);

      return done ? "见下方卡片" : "…";
    });

    return guard ? out.replace(/((?:预算|低于|高于|不超过|不到|超过|至少|最多|以内)\s*(?:是|为)?\s*)?[¥￥$]\s?(\d[\d,]*(?:\.\d+)?)(?!\d|[.,]\d|\s*(?:万|千|亿|[kKwW]|以内|以下|以上|左右|起))/g, (all, condition: string | undefined, n: string) => (condition || numbers.has(plain(n)) ? all : "见下方卡片")) : out;
  });
}

/** 念出来、写进结果摘要用的文字：只要卡片外的正文；正文为空时用卡片标题。 */
export function answerSpeech(text: string): string {
  if (!/<card[\s>]|\{=/.test(text)) return text;
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const prose = parts.map((p) => ("prose" in p ? resolveProse(p.prose, cards) : "")).join("").replace(/\n{3,}/g, "\n\n").trim();

  return prose || cards.map((c) => c.title).filter(Boolean).join("；");
}

/** 图里某个方块上写的字（复制时给原文配上方块名）；找不到就用方块的 id。 */
function diagramLabel(source: string, node: string): string {
  const label = new RegExp(String.raw`(?:^|[\s&;>])${node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*[[({>]+\s*"([^"]*)"`, "m").exec(source)?.[1];

  return label ? label.replace(/<br\s*\/?>/gi, " ").trim() : node;
}

/** 复制为 Markdown：卡片换成等价的 Markdown（数字格、步骤、选项、表格、清单），按钮不复制。 */
export function answerMarkdown(text: string): string {
  if (!/<card[\s>]|\{=/.test(text)) return text;
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const md = (c: Card) => [c.title ? `**${c.title}**${c.sub ? `（${c.sub}）` : ""}` : "", ...c.blocks.map((b) => {
    switch (b.kind) {
      case "stats": return b.items.map((s) => `- ${s.label}：${s.value}${s.formula ? `（${s.formula}）` : ""}${s.note ? `，${s.note}` : ""}${s.tag ? ` · ${s.tag}` : ""}`).join("\n");
      case "steps": return b.items.map((s, i) => `${i + 1}. ${s.title}${s.detail ? `：${s.detail}` : ""}`).join("\n");
      case "options": return b.items.map((o) => `- ${o.name}${o.pick ? "（推荐）" : ""}${o.value ? ` ${o.value.value}` : ""}${o.meta ? `，${o.meta}` : ""}：${o.why}`).join("\n");
      case "table": return [`| ${b.cols.join(" | ")} |`, `|${b.cols.map(() => " --- ").join("|")}|`, ...b.rows.map((r) => `| ${r.cells.map((c) => c.value).join(" | ")}${r.tag ? `（${r.tag}）` : ""} |`)].join("\n");
      case "checks": return b.items.map((c) => `- [ ] ${c.text}${c.note ? `（${c.note}）` : ""}`).join("\n");
      case "callout": return `> ${b.text}`;
      case "inputs": return b.items.map((v) => `- ${v.label}：${showValue(v.value, v.unit)}`).join("\n");
      case "app": return `（小程序：${b.title}）`;
      case "fields": return b.items.map((f) => `- ${f.label}：${f.value || "（待填）"}${f.options ? `（可选：${f.options.join(" / ")}）` : ""}`).join("\n");
      case "diagram": return [`\`\`\`mermaid\n${b.source}\n\`\`\``, ...Object.entries(b.cites).map(([node, c]) => `- ${diagramLabel(b.source, node)}：“${c.text}”${c.from ? `（${c.from}）` : ""}`)].join("\n");
    }
  }), c.source ? `来源：${c.source}` : ""].filter(Boolean).join("\n\n");

  return parts.map((p) => ("prose" in p ? resolveProse(p.prose, cards) : p.card ? `\n\n${md(p.card)}\n\n` : "")).join("").replace(/\n{3,}/g, "\n\n").trim();
}

/** 网页底部胶囊上方的精简卡片：标题，加上最多几行；推荐、最高这类标了的一项排第一并高亮。 */
export type CardPreview = { title: string; rows: Array<{ label: string; value?: string; tag?: string }>; more: number };

/**
 * 回答里第一张写完的卡片的精简版（语音胶囊用）；没有卡片时为 null。字和数原样取自卡片，不改写。
 * 取第一个列出来非空的块：选项、表格、数字格、步骤、清单；只有提示条时就用提示条那一句。标题和行都空时为 null，不画空框。
 */
export function cardPreview(text: string, maxRows = 3): CardPreview | null {
  if (!/<card[\s>]/.test(text)) return null;
  const card = splitAnswer(text).flatMap((p) => ("card" in p && p.card?.closed ? [p.card] : []))[0];

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
  // 步骤有先后，不挪；其他把标了的一项提到最前。
  const tagged = block?.kind === "steps" ? -1 : all.findIndex((r) => r.tag);
  const ordered = tagged > 0 ? [all[tagged]!, ...all.slice(0, tagged), ...all.slice(tagged + 1)] : all;

  return { title: card.title, rows: ordered.slice(0, maxRows), more: Math.max(0, ordered.length - maxRows) };
}
