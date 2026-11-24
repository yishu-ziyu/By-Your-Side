const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "if", "import", "in", "instanceof", "interface", "let", "new", "null", "of", "private", "protected",
  "public", "readonly", "return", "static", "super", "switch", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "var", "void", "while", "yield", "def", "elif", "except", "lambda", "None",
  "pass", "raise", "with", "True", "False", "func", "guard", "struct", "actor", "protocol", "where",
  "nil", "self", "Self", "mutating", "throws", "some", "any", "fn", "impl", "pub", "match", "mut",
]);

const TYPES = new Set([
  "string", "number", "boolean", "unknown", "never", "object", "bigint", "symbol", "Promise", "Map",
  "Set", "Record", "Array", "HTMLElement", "ChildNode", "Node", "Text", "Range", "Worker", "Error",
  "Int", "Double", "Float", "Bool", "String",
]);

const TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:_\d+)*(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;

const HASH_COMMENT_LANG = /^(py|python|sh|bash|shell|yaml|yml|toml|ruby|rb)$/i;

const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export function highlightCodeTokens(code: string, lang: string): string {
  const hashComment = HASH_COMMENT_LANG.test(lang);
  let out = "";
  let last = 0;

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(code)) !== null) {
    if (match.index > last) out += escHtml(code.slice(last, match.index));
    const tok = match[0];

    last = match.index + tok.length;
    if (tok.startsWith("//") || tok.startsWith("/*") || (hashComment && tok.startsWith("#"))) {
      out += `<span class="tok-com">${escHtml(tok)}</span>`;
    } else if (tok.startsWith("#")) {
      out += escHtml(tok);
    } else if (tok[0] === '"' || tok[0] === "'" || tok[0] === "`") {
      out += `<span class="tok-str">${escHtml(tok)}</span>`;
    } else if (tok[0]! >= "0" && tok[0]! <= "9") {
      out += `<span class="tok-num">${escHtml(tok)}</span>`;
    } else if (KEYWORDS.has(tok)) {
      out += `<span class="tok-kw">${escHtml(tok)}</span>`;
    } else if (TYPES.has(tok) || (/^[A-Z][A-Za-z0-9_]*$/.test(tok) && tok.length > 1)) {
      out += `<span class="tok-type">${escHtml(tok)}</span>`;
    } else if (code[last] === "(") {
      out += `<span class="tok-fn">${escHtml(tok)}</span>`;
    } else {
      out += escHtml(tok);
    }
  }

  if (last < code.length) out += escHtml(code.slice(last));

  return out;
}
