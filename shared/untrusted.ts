/**
 * WHY: 页面内容进入模型上下文前的两道处理（纯函数）：
 * 1. 不可信边界：页面文本一律包进 <page-content untrusted ...>，并声明它是数据不是指令；
 * 2. 凭据隐去：高熵串（恢复码、API key、私钥）只留标记。
 *
 *取舍与同类实现（huashu-chrome）一致：
 * 误报的代价是模型少看到几行乱码，漏报的代价是凭据进了留痕的对话上下文。
 */

const PAGE_CONTENT_TAG = "page-content";

const MAX_META = 160;

function clipMeta(value: string): string {
  const clean = value.replace(/[\r\n<>"]/g, " ").replace(/\s+/g, " ").trim();

  return clean.length > MAX_META ? `${clean.slice(0, MAX_META - 1)}…` : clean;
}

/**
 * WHY: 包一层不可信边界。载荷里出现的同名标签一律打断，防止页面文本伪造闭合标签逃逸边界。
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

function isCredentialToken(token: string, allowModelNumber = true): boolean {
  if (token.length < 12 || token.length > 256) return false;

  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return false;

  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);

  if (hasUpper && hasLower) return token.length >= 16;

  if (token.length >= 24) return true;

  if (hasLower) return false;

  return !(allowModelNumber && isModelNumber(token));
}

function isModelNumber(token: string): boolean {
  if (token.length < 12 || token.length >= 24 || !/^[A-Z0-9-]+$/.test(token) || !/[0-9]/.test(token) || !/[A-Z]/.test(token)) return false;
  const segments = token.split("-");

  return segments.length >= 2 && segments.every((s) => s) && new Set(segments.map((s) => s.length)).size > 1;
}

const MASK = "[redacted]";

export function redactCredentialText(text: string): string {
  if (!text) return text;
  const kept: string[] = [];
  let maskedLines = 0;
  const assignment = /^([A-Za-z][A-Za-z0-9_ .-]{0,24}\s*[:=]\s*)(\S+)$/;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const asAssignment = assignment.exec(trimmed);

    if (asAssignment && isCredentialToken(asAssignment[2]!)) {
      kept.push(`${asAssignment[1]}[redacted]`);
      continue;
    }

    if (asAssignment && isModelNumber(asAssignment[2]!)) { kept.push(line); continue; }

    if (isCredentialToken(trimmed)) { maskedLines += 1; continue; }

    kept.push(line);
  }

  let body = kept.join("\n");
  const structured = /[\s\u4e00-\u9fff"'{}[\],:=]/.test(body);

  // WHY: 型号只在独立成词时放行：凭据被 / . : \\ = 或夹入的字符切开后，每一段单独看都像型号（ABCD12-EFGH3454/IJKL56-MNOP7890）。
  // 词按空白、HTML 标签边界、引号、括号、逗号和中文切；去掉开头的 `键名=`、`:` 和末尾标点后，整个词就是这一段才放行。
  // 全角只算标点（，：；！？（）等），全角字母数字不算边界，否则能拿它们把凭据拆开。
  if (structured) body = body.replace(/[^\s<>"'`{}[\](),\u3000-\u303f\u4e00-\u9fff\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+/g, (word) => {
    const head = word.replace(/^(?:[A-Za-z_]{1,24}|[a-z][A-Za-z0-9_.-]{0,24})[:=]|^[:=]+/, "");
    let end = head.length;

    while (end > 0 && ".,;:!?/".includes(head[end - 1]!)) end -= 1;
    const core = head.slice(0, end);

    const mask = (part: string) => part.replace(/[A-Za-z0-9+_-]{12,256}/g, (token) => (isCredentialToken(token, token === core) ? MASK : token));
    return word.split(/(?=\\)/).map((part) => {
      const url = /https?:\/\/[^/?#]*/.exec(part);

      if (!url) return mask(part);
      const pathStart = url.index + url[0].length;
      const pathEnd = pathStart + part.slice(pathStart).search(/[?#]|$/);

      return mask(part.slice(0, pathStart)) + part.slice(pathStart, pathEnd) + mask(part.slice(pathEnd));
    }).join("");
  });

  if (maskedLines > 0) body = `[${MASK}: ${maskedLines} credential-looking line(s) removed]\n${body}`;

  return body.replace(/\n{3,}/g, "\n\n");
}
