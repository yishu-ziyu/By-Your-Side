import { Lexer, Marked, type Tokens, type TokenizerThis } from "marked";

/**
 * assistant 消息 Markdown → HTML。
 *
 * 只有一处偏离 marked 默认行为：GFM 裸网址自动链接会在中文行文里吞掉后续正文。
 * 例如「已在新标签页打开 https://example.com，页面显示 …」会整段变成链接，
 * 浏览器再把 `example.com，页面显示` 当域名规范化成 `example.xn--com,-8k0i458g7d8b31b/`。
 * 真实案例证据：docs/evals/20260913-native-dogfood/07-open-page.{png,txt}。
 *
 * 这里用 inline tokenizer 扩展收紧裸网址边界，而不是改写文本（不做全局替换，
 * 代码块、行内代码、Markdown 链接、显式 <> 自动链接都走 marked 原路径）。
 *
 * 取舍：裸网址的 ASCII 域名后如果紧跟汉字/假名，判定为正文并中止链接；
 * 域名/路径/查询/片段里**已经**是中文的（中文路径、中文查询、IRI 域名）保留，
 * 不一律删除非 ASCII 字符。裸写的纯 IRI 主机（https://例え.テスト）与 marked
 * 现状一致、不自动链接，需要时可用显式 `<https://例え.テスト/路径>`。
 *
 * 返回的仍是 marked 的原始 HTML（透传的 raw HTML 不做处理）：调用方必须继续用
 * DOMPurify 等 sanitizer 消毒（main.ts 在原位置消毒）。
 */

// marked 自己暴露的 inline 规则（与下面 Marked 实例的 gfm + breaks 配置一致），
// 复用其 URL 与「尾部英文标点回退」正则，避免自己抄一份规则跑偏。
const URL_RULE = Lexer.rules.inline.breaks.url;

const BACKPEDAL_RULE = Lexer.rules.inline.breaks._backpedal;

// 中文/全角标点：在中文行文里一定结束裸链接（，。；！？：、（）“”《》…——）
const CJK_PUNCTUATION =
  /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u30fb]/u;

// 汉字/假名：跟在 ASCII 域名后面时按正文处理
const CJK_IDEOGRAPH = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;

/**
 * 截掉裸网址后面的中文正文，返回新的裸网址原文。
 *
 * - 中文标点处一律中止；
 * - 域名段（`scheme://` 之后到第一个 `/`、`?`、`#` 之前）若本身是纯 ASCII，
 *   紧跟其后的汉字/假名视为正文；
 * - 域名以非 ASCII 开头（IRI）或已进入路径/查询/片段时，中文照常保留。
 */
function cutProseTail(raw: string): string {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\//.exec(raw);
  const authorityStart = scheme ? scheme[0].length : 0;
  let inAuthority = true;
  let authorityIsAscii = true;

  for (let i = authorityStart; i < raw.length; ) {
    const ch = String.fromCodePoint(raw.codePointAt(i)!);

    if (CJK_PUNCTUATION.test(ch)) return raw.slice(0, i);

    if (CJK_IDEOGRAPH.test(ch)) {
      if (inAuthority && authorityIsAscii && i > authorityStart) return raw.slice(0, i);

      if (inAuthority) authorityIsAscii = false;
    } else if (inAuthority) {
      if (ch === "/" || ch === "?" || ch === "#") inAuthority = false;
      else if (ch.codePointAt(0)! > 0x7f) authorityIsAscii = false;
    }

    i += ch.length;
  }

  return raw;
}

/** marked 原生做法：反复剥掉结尾的英文标点（含不配对的右括号），保留 `Foo_(bar)`。 */
function stripTrailingPunctuation(raw: string): string {
  let current = raw;

  for (;;) {
    const next = BACKPEDAL_RULE.exec(current)?.[0] ?? "";

    if (next === current) return current;

    if (!next) return "";
    current = next;
  }
}

/** 覆盖 marked 的 GFM 裸网址 tokenizer：先按中文边界截断，再交给原生规则收尾。 */
function bareUrlTokenizer(this: TokenizerThis, src: string): Tokens.Link | undefined {
  // 与 marked 原生 url tokenizer 一致：链接文字里不再嵌套自动链接
  if (this.lexer.state.inLink) return undefined;
  const match = URL_RULE.exec(src);

  if (!match) return undefined;
  const isEmail = match[2] === "@";
  let raw = cutProseTail(match[0]);

  if (!isEmail) raw = stripTrailingPunctuation(raw);

  if (!raw) return undefined;
  const href = isEmail ? `mailto:${raw}` : raw.startsWith("www.") ? `http://${raw}` : raw;

  return { type: "link", raw, href, title: null, text: raw, tokens: [{ type: "text", raw, text: raw }] };
}

const marked = new Marked({ breaks: true, gfm: true });

marked.use({ extensions: [{ name: "bareUrl", level: "inline", tokenizer: bareUrlTokenizer }] });

/** 渲染 assistant 的 Markdown 为 HTML；调用方仍需用 DOMPurify 等 sanitizer 消毒。 */
export function renderMarkdownHtml(text: string): string {
  return marked.parse(text, { async: false });
}
