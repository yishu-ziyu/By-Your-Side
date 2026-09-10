/**
 * 页面内容进入模型上下文前的两道处理（纯函数，可单测）：
 * 1. 不可信边界：页面文本一律包进 <page-content untrusted ...>，并声明它是数据不是指令；
 * 2. 凭据隐去：高熵串（恢复码、API key、私钥）只留标记。
 *
 * 依据 docs/evals/20260911-untrusted-and-snapshot.md。取舍与同类实现（huashu-chrome）一致：
 * 误报的代价是模型少看到几行乱码，漏报的代价是凭据进了留痕的对话上下文。
 */

export const PAGE_CONTENT_TAG = "page-content";

const MAX_META = 160;

function clipMeta(value: string): string {
  const clean = value.replace(/[\r\n<>"]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > MAX_META ? `${clean.slice(0, MAX_META - 1)}…` : clean;
}

/**
 * 包一层不可信边界。载荷里出现的同名标签一律打断，防止页面文本伪造闭合标签逃逸边界。
 */
export function wrapPageContent(text: string, meta: { tabId?: number; url?: string; title?: string } = {}): string {
  const attrs = [
    meta.tabId !== undefined ? `tab=${meta.tabId}` : "",
    meta.url ? `url="${clipMeta(meta.url)}"` : "",
    meta.title ? `title="${clipMeta(meta.title)}"` : "",
  ].filter(Boolean).join(" ");
  const safe = text.split(`</${PAGE_CONTENT_TAG}`).join(`<\\/${PAGE_CONTENT_TAG}`);
  const open = attrs ? `<${PAGE_CONTENT_TAG} untrusted ${attrs}>` : `<${PAGE_CONTENT_TAG} untrusted>`;
  return `${open}\n${safe}\n</${PAGE_CONTENT_TAG}>`;
}

/** 随机/凭据长相的 token 判定。 */
function isCredentialToken(token: string): boolean {
  if (token.length < 12 || token.length > 256) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return false;
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  // 结构化的业务 id 不隐去（隐掉它们会直接破坏抓数据任务）：B站 BV1xm376WEc5 这类
  // 短混合串放行，小写+连字符的订单号放行。只挡真正的凭据长相。
  if (hasUpper && hasLower) return token.length >= 16;
  if (token.length >= 24) return true;
  return !hasLower; // 全大写的恢复码/密钥
}

const MASK = "[redacted]";

/**
 * 隐去文本里的凭据长相内容（`[redacted]`）。
 * 行级：整行是一个高熵 token 时整行折叠（几十行恢复码不逐行占上下文）。
 * 词级：只处理含空白的正文（不含空白的字符串是标识符：selector、URL、ref、JS）。
 */
export function redactCredentialText(text: string): string {
  if (!text) return text;
  const kept: string[] = [];
  let maskedLines = 0;
  // key=value / key: value：只隐去值，保留键名，模型仍知道这里有东西被隐去了。
  const assignment = /^([A-Za-z][A-Za-z0-9_ .-]{0,24}\s*[:=]\s*)(\S+)$/;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const asAssignment = assignment.exec(trimmed);
    if (asAssignment && isCredentialToken(asAssignment[2]!)) {
      kept.push(`${asAssignment[1]}[redacted]`);
      continue;
    }
    if (isCredentialToken(trimmed)) { maskedLines += 1; continue; }
    kept.push(line);
  }
  let body = kept.join("\n");
  // 含空白（正文）、中文或结构化符号（JSON/HTML 的引号括号、key=value）才做词级替换；
  // 纯标识符字符串（selector、JS 片段）不动。token 按凭据字符集切，`"key":"值"` 里的值才抓得到。
  // `/` 不入字符集：它是 URL/路径分隔符，把它算进 token 会把路径段拼成长串，
  // 把 `https://api.github.com/repos/…/issues/335552` 这类正常 URL 隐成 `https://api.github.[redacted]`。
  const structured = /[\s\u4e00-\u9fff"'{}\[\],:=]/.test(body);
  if (structured) body = body.replace(/[A-Za-z0-9+_-]{12,256}/g, (token) => (isCredentialToken(token) ? MASK : token));
  if (maskedLines > 0) body = `[${MASK}: ${maskedLines} credential-looking line(s) removed]\n${body}`;
  return body.replace(/\n{3,}/g, "\n\n");
}

function hasWhitespace(text: string): boolean {
  return /\s/.test(text);
}
