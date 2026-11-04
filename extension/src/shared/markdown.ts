import { Lexer, Marked, type Tokens, type TokenizerThis } from "marked";

const URL_RULE = Lexer.rules.inline.breaks.url;

const BACKPEDAL_RULE = Lexer.rules.inline.breaks._backpedal;

const CJK_PUNCTUATION =
  /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u30fb]/u;

const CJK_IDEOGRAPH = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;

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

function stripTrailingPunctuation(raw: string): string {
  let current = raw;

  for (;;) {
    const next = BACKPEDAL_RULE.exec(current)?.[0] ?? "";

    if (next === current) return current;

    if (!next) return "";
    current = next;
  }
}

function bareUrlTokenizer(this: TokenizerThis, src: string): Tokens.Link | undefined {
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

const CJK_PUNCT = CJK_PUNCTUATION.source.slice(1, -1);
const cjkEmphasis = (marker: string, body: string) => new RegExp(`^${marker}(?![\\s*])((?:[${CJK_PUNCT}]${body}*|${body}*[${CJK_PUNCT}]))${marker}(?!\\*)`);
const CJK_STRONG = cjkEmphasis("\\*\\*", "(?:[^\\n*]|\\*(?!\\*))");
const CJK_EM = cjkEmphasis("\\*", "[^\\n*]");

function cjkEmphasisTokenizer(this: TokenizerThis, src: string): Tokens.Strong | Tokens.Em | undefined {
  const strong = CJK_STRONG.exec(src);
  const match = strong ?? CJK_EM.exec(src);

  const [raw, text] = match ?? [];

  if (!raw || !text || /\s$/.test(text)) return undefined;

  return { type: strong ? "strong" : "em", raw, text, tokens: this.lexer.inlineTokens(text) };
}

const marked = new Marked({ breaks: true, gfm: true });

marked.use({ extensions: [
  { name: "bareUrl", level: "inline", tokenizer: bareUrlTokenizer },
  { name: "cjkEmphasis", level: "inline", tokenizer: cjkEmphasisTokenizer },
] });

export function renderMarkdownHtml(text: string): string {
  return marked.parse(text, { async: false });
}
