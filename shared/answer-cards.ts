/**
 * 回答里的卡片：解析与取数，侧栏、语音、复制共用（docs/evals/20261014-answer-cards.md）。
 * 侧栏怎么画在 extension/src/sidepanel/answer-cards.ts；模型怎么写在 agent/src/prompt.ts 的「Answer cards」一节。
 *
 * - 只认代码块以外的 <card>…</card>；写到一半的组件不算，只记下它开了头（pending），侧栏据此放空位。
 * - 数由这里算：value 写成算式时算出结果；正文的 {=名字} 换成卡片算出的数。实验里模型心算的合计 9 次全错，卡片算式全对。
 * - 卡片里有算式时，卡片写完后，正文里不在卡片里的金额换成「见下方卡片」，不让心算错的数留在结论句里。
 */

export type Stat = { id?: string; label: string; value: string; formula?: string; note?: string; tag?: string; computed?: number };

export type Block =
  | { kind: "stats"; items: Stat[] }
  | { kind: "steps"; items: Array<{ title: string; detail?: string }> }
  | { kind: "options"; items: Array<{ name: string; meta?: string; value?: string; why: string; pick: boolean }> }
  | { kind: "table"; cols: string[]; rows: Array<{ cells: string[]; tag?: string }> }
  | { kind: "checks"; items: Array<{ text: string; note?: string }> }
  | { kind: "callout"; tone: "info" | "warn"; text: string }
  | { kind: "diagram"; source: string; cites: Record<string, { text: string; from?: string }> };

export type CardButton = { label: string; tab?: string; primary: boolean };

/** 卡片末尾已经开了头、还没写完的组件：tag 是标签名，written 是已写出的属性原文（侧栏据此放尺寸接近的空位）。 */
export type PendingComponent = { tag: "stat" | "step" | "option" | "table" | "tr" | "check" | "callout" | "diagram"; written: string };

export type Card = { title: string; sub?: string; blocks: Block[]; buttons: CardButton[]; source?: string; closed: boolean; numbers: Set<string>; values: Map<string, string>; formulas: boolean; pending?: PendingComponent };

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

/** 只认数字、+ − × ÷ 和括号的小解析器：扩展页面的 CSP 不允许动态求值。 */
export function calc(expression: string): number | undefined {
  const s = expression.replace(/[−–]/g, "-").replace(/×/g, "*").replace(/÷/g, "/").replace(/,/g, "").replace(/\s+/g, "");
  let i = 0;
  const number = (): number => {
    const m = /^\d+(?:\.\d+)?/.exec(s.slice(i));

    if (!m) throw new Error("number");
    i += m[0].length;

    return Number(m[0]);
  };
  const factor = (): number => {
    if (s[i] === "(") {
      i += 1;
      const v = sum();

      if (s[i] !== ")") throw new Error(")");
      i += 1;

      return v;
    }

    if (s[i] === "-") { i += 1;

 return -factor(); }

    return number();
  };
  const product = (): number => {
    let v = factor();

    while (s[i] === "*" || s[i] === "/") {
      const op = s[i];
      i += 1;
      const r = factor();
      v = op === "*" ? v * r : v / r;
    }

    return v;
  };
  const sum = (): number => {
    let v = product();

    while (s[i] === "+" || s[i] === "-") {
      const op = s[i];
      i += 1;
      const r = product();
      v = op === "+" ? v + r : v - r;
    }

    return v;
  };

  try {
    const v = sum();

    return i === s.length && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined;
  } catch {
    return undefined;
  }
}

const formatNumber = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

const prettyFormula = (f: string) => f.replace(/\s+/g, "").replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\+/g, " + ").replace(/(\d|\))-/g, "$1 − ");

/** 比较用的数：去掉千分位和多余的小数零。 */
const plain = (n: string) => String(Number(n.replace(/,/g, "")));

/** 货币符号放在数前面，其他单位放在后面；值里已经带了单位就不再加。 */
function withUnit(value: string, unit: string | undefined): string {
  if (!unit || !/^-?[\d,]+(?:\.\d+)?$/.test(value)) return value;

  return CURRENCY.test(unit) ? `${unit}${value}` : `${value} ${unit}`;
}

function parseCard(source: string, closed: boolean): Card | undefined {
  const head = new RegExp(String.raw`^<card${ATTRS}\s*>`).exec(source);

  if (!head) return undefined;
  const top = attrsOf(head[1]!);
  const card: Card = { title: str(top.title) ?? "", sub: str(top.sub), blocks: [], buttons: [], closed, numbers: new Set(), values: new Map(), formulas: false };

  for (const n of source.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) card.numbers.add(plain(n));
  let tagged = false;
  let picked = false;
  let primary = false;
  /**
   * 卡片里任何一处值（数字格、选项的价、表格格子）写成算式（= 开头）时都在这里算：模型会把算式也写进选项和表格，不只数字格。
   * 算不出就去掉 =，原样显示，不把「=1699-50」露给用户。
   */
  const resolve = (raw: string, unit?: string): { value: string; computed?: number; formula?: string } => {
    if (!raw.startsWith("=")) return { value: withUnit(raw, unit) };
    // 模型有时把货币符号或「元」也写进算式（=¥1699-50）：先拿掉再算，符号当单位用。
    const symbol = /[¥￥$€£]/.exec(raw)?.[0];
    const expression = raw.slice(1).replace(/[¥￥$€£]/g, "").replace(/\s*元\s*$/, "");
    const n = calc(expression);
    unit ??= symbol ?? (/元\s*$/.test(raw) ? "元" : undefined);

    if (n === undefined) return { value: withUnit(raw.slice(1).trim(), unit === symbol ? undefined : unit) };
    card.numbers.add(String(n));
    const formula = /[-+*/×÷−]/.test(expression.replace(/^\s*-/, "")) ? prettyFormula(expression) : undefined;

    if (formula) card.formulas = true;

    return { value: withUnit(formatNumber(n), unit), computed: n, formula };
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
  // 图的原文里可以有 <br/>、-->，不走下面的组件正则；没写完的图整段先拿掉，它后面也不会再有组件。
  // 图等整张卡写完才画：边写边画时每加一行整张图都会重排，图后面的出处（cite）也要写完才能点。
  let body = source.slice(head[0].length);
  const diagram = /<diagram>([\s\S]*?)<\/diagram>/.exec(body);
  const openDiagram = /<diagram>(?![\s\S]*<\/diagram>)/.exec(body);

  if (openDiagram) body = body.slice(0, openDiagram.index);

  if (diagram) {
    body = body.replace(diagram[0], "");

    if (closed && diagram[1]?.trim()) card.blocks.push({ kind: "diagram", source: diagram[1].trim(), cites: {} });
  }
  const component = new RegExp(String.raw`<(stat|step|option|table|tr|check|callout|button|source|cite)\b${ATTRS}\s*\/?>(?:([^<]*)<\/\1>)?`, "g");

  for (const m of body.matchAll(component)) {
    const [, tag, rawAttrs, inner] = m;
    const a = attrsOf(rawAttrs ?? "");
    const text = inner?.trim();

    if (tag === "stat") {
      const label = str(a.label);
      const raw = str(a.value);

      if (!label || !raw) continue;
      const v = resolve(raw, str(a.unit));

      // 数字格的算式算不出就不画这一格：它就是给人照着做决定的数。
      if (raw.startsWith("=") && v.computed === undefined) continue;
      const stat: Stat = { id: str(a.id), label, value: v.value, formula: v.formula, computed: v.computed, note: str(a.note) };

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
      group("options", () => ({ kind: "options", items: [] })).items.push({ name, meta: str(a.meta), value: a.value === undefined ? undefined : str(resolve(str(a.value) ?? "", str(a.unit)).value), why, pick });
    } else if (tag === "table") {
      const cols = (str(a.cols) ?? "").split("|").map((c) => c.trim()).slice(0, MAX_COLS);

      if (cols.length > 1) card.blocks.push({ kind: "table", cols, rows: [] });
    } else if (tag === "tr") {
      const table = last();
      const cells = (str(a.cells) ?? "").split("|").map((c) => c.trim());

      if (table?.kind !== "table" || cells.length < 2) continue;
      const rowTag = str(a.tag) && !table.rows.some((r) => r.tag) ? str(a.tag) : undefined;
      table.rows.push({ cells: Array.from({ length: table.cols.length }, (_, i) => resolve(cells[i] ?? "").value), tag: rowTag });
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
    } else if (tag === "source") {
      if (text) card.source = text;
    } else if (tag === "cite") {
      const node = str(a.node);
      const block = card.blocks.find((b) => b.kind === "diagram");

      if (node && text && block?.kind === "diagram") block.cites[node] = { text, from: str(a.from) };
    }
  }

  // 没写完的卡片：末尾开了头的组件记下来。只认真的开头（「<stat 」），不猜后面还有几个；
  // 只看最后一个开头标签，前面哪个属性少了引号也不会一路配到末尾。
  const lastOpen = closed ? undefined : [...body.matchAll(/<(?:stat|step|option|table|tr|check|callout)\s/g)].at(-1)?.index;
  const tail = lastOpen === undefined ? "" : body.slice(lastOpen);
  const open = /^<(stat|step|option|table|tr|check|callout)\s((?:[^<>"]|"[^"]*")*(?:"[^"]*)?)$/.exec(tail) ?? /^<(callout)\b([^<>]*)>[^<]*(?:<\/?[a-z]*)?$/.exec(tail);

  // 有图的卡片没写完时空位一直是图的那块，不随后面写到一半的组件换来换去。
  if ((openDiagram || diagram) && !closed) card.pending = { tag: "diagram", written: "" };
  // SAFETY: 两个正则的第一组只会是 PendingComponent 列出的标签名。
  else if (open) card.pending = { tag: open[1] as PendingComponent["tag"], written: open[2] ?? "" };

  return card.title || card.blocks.length ? card : undefined;
}

/** 依据面的一行：卡片上的一个数字格。tab 是指向这一项的「切到…看」按钮的标签页。 */
export type EvidenceRow = { label: string; value: string; formula?: string; source?: string; tab?: string };

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

  return stats.map((s, i) => ({ label: s.label, value: s.value, formula: s.formula, source: card.source, tab: named[i] && named.filter((t) => t?.name === named[i]!.name).length === 1 ? named[i]!.tab : undefined }));
}

/** 代码块和行内代码的范围：里面的 <card、{=…}、金额都按原文处理。 */
export function codeRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)]
    // 一对反引号里有 <card、后面又有真的 </card>：是正文里落单的反引号碰上了卡片属性里的反引号，不当代码。
    .filter((m) => m[0].startsWith("```") || !/<card[\s>]/.test(m[0]) || m[0].includes("</card>") || text.indexOf("</card>", m.index + m[0].length) < 0)
    .map((m) => [m.index, m.index + m[0].length]);
}

/** 回答原文切成正文与卡片。没写完的卡片 closed 为 false。 */
export function splitAnswer(text: string): AnswerPart[] {
  const code = codeRanges(text);
  const inCode = (at: number) => code.some(([a, b]) => at >= a && at < b);
  const parts: AnswerPart[] = [];
  let at = 0;

  for (const m of text.matchAll(/<card[\s>]/g)) {
    if (m.index < at || inCode(m.index)) continue;
    parts.push({ prose: text.slice(at, m.index) });
    const end = text.indexOf("</card>", m.index);
    parts.push({ card: parseCard(end < 0 ? text.slice(m.index) : text.slice(m.index, end), end >= 0) });
    at = end < 0 ? text.length : end + "</card>".length;
  }

  // 结尾写到一半的「<car」「{=to」不露出来。
  if (at < text.length) parts.push({ prose: text.slice(at).replace(/(?:<(?:c(?:a(?:r(?:d)?)?)?)?|\{=[\w-]*)$/, "") });

  return parts;
}

/** 只改代码以外、链接文字以外的正文。 */
const outsideCode = (text: string, edit: (prose: string) => string) => text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/).map((part, i) => (i % 2 ? part : edit(part))).join("");

/**
 * 正文：{=名字} 换成卡片算出的数（卡片还没写到时先显示「…」）。
 * 卡片里有算式、且卡片已写完时，正文里不在卡片里的金额换成「见下方卡片」；
 * 后面跟着 万/千/以内 这类字的、前面是“预算/低于/不超过”这类字的，是用户的条件或约数，不换。
 */
export function resolveProse(prose: string, cards: Card[], mark = (value: string) => value): string {
  const values = new Map(cards.flatMap((c) => [...c.values]));
  const done = cards.some((c) => c.closed);
  const guard = done && cards.some((c) => c.formulas);
  const numbers = new Set(cards.flatMap((c) => [...c.numbers]));

  return outsideCode(prose, (part) => {
    const out = part.replace(/\{=([A-Za-z_][\w-]*)\}/g, (_all, id: string) => {
      const v = values.get(id);

      if (v) return mark(v);

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

/** 复制为 Markdown：卡片换成等价的 Markdown（数字格、步骤、选项、表格、清单），按钮不复制。 */
export function answerMarkdown(text: string): string {
  if (!/<card[\s>]|\{=/.test(text)) return text;
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const md = (c: Card) => [c.title ? `**${c.title}**${c.sub ? `（${c.sub}）` : ""}` : "", ...c.blocks.map((b) => {
    switch (b.kind) {
      case "stats": return b.items.map((s) => `- ${s.label}：${s.value}${s.formula ? `（${s.formula}）` : ""}${s.note ? `，${s.note}` : ""}${s.tag ? ` · ${s.tag}` : ""}`).join("\n");
      case "steps": return b.items.map((s, i) => `${i + 1}. ${s.title}${s.detail ? `：${s.detail}` : ""}`).join("\n");
      case "options": return b.items.map((o) => `- ${o.name}${o.pick ? "（推荐）" : ""}${o.value ? ` ${o.value}` : ""}${o.meta ? `，${o.meta}` : ""}：${o.why}`).join("\n");
      case "table": return [`| ${b.cols.join(" | ")} |`, `|${b.cols.map(() => " --- ").join("|")}|`, ...b.rows.map((r) => `| ${r.cells.join(" | ")}${r.tag ? `（${r.tag}）` : ""} |`)].join("\n");
      case "checks": return b.items.map((c) => `- [ ] ${c.text}${c.note ? `（${c.note}）` : ""}`).join("\n");
      case "callout": return `> ${b.text}`;
      case "diagram": return `\`\`\`mermaid\n${b.source}\n\`\`\``;
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
      case "options": return b.items.map((o) => ({ label: o.name, value: o.value ?? o.meta, tag: o.pick ? "推荐" : undefined }));
      case "table": return b.rows.map((r) => ({ label: r.cells[0] ?? "", value: r.cells.slice(1).filter(Boolean).join(" · ") || undefined, tag: r.tag }));
      case "stats": return b.items.map((s) => ({ label: s.label, value: s.value, tag: s.tag }));
      case "steps": return b.items.map((s, i) => ({ label: `${i + 1}. ${s.title}` }));
      case "checks": return b.items.map((c) => ({ label: c.text }));
      case "callout": return [{ label: b.text }];
      case "diagram": return [];
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
