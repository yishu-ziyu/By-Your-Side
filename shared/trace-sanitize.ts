/** 诊断记录的脱敏：纯函数，本机伴随进程与扩展内 agent 共用。 */
const SECRET_KEY = /^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|set-cookie)$/i;

const SENSITIVE_TARGET = /password|passwd|pwd|secret|token|api[_-]?key|密码|口令/i;

/**
 * 字段名、标签、占位符里出现这些词，就当它是密码、验证码、卡号、身份证栏：不读回值。填写后读回（input.ts）用它。
 * 匹配前，input.ts 先拆开驼峰、把 _ - . 换成空格并转小写，所以 card_number、cardNumber 都命中；
 * pin、ssn、otp 只认整词，shipping、spinner 不会命中。
 */
export const SENSITIVE_FIELD_NAME = /password|passwd|pwd|\b(?:otp|pin|ssn)\b|one-time|(?:verification|security|sms) ?code|验证码|校验码|动态码|密码|口令|cvv|cvc|card ?number|卡号|安全码|身份证|银行卡/i;

const MAX_TEXT = 64_000;

/** 凭据：本机存储时也遮住。 */
function cleanCredentials(text: string): string {
  return text
    .replace(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/((?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|密码|口令)["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

function cleanText(text: string, full: boolean): string {
  // fill / type_text 回执里读回的网页内容（agent/src/tools.ts readbackNote）：导出时和入参一样遮住。值里可能有 »，所以取到最后一个；
  // 存储时被截断、没有 » 的，遮到字符串末尾。
  return cleanCredentials(full ? text.replace(/(now contains:? )«(?:[\s\S]*»|[\s\S]*$)/g, "$1«[redacted]»") : text);
}

/**
 * 导出用的完整脱敏：凭据之外，再遮住填写的值、读回的值和 browser_run 的代码。
 * Best-effort diagnostic redaction; arbitrary unlabelled secrets cannot be classified reliably.
 */
export function sanitizeTrace(value: unknown): unknown {
  return scrubTrace(value, true, true);
}

/**
 * 导出已存的诊断记录时用：和 sanitizeTrace 一样遮住内容，但不再套长度限额。
 * 存储时已经限过长；再限一次会为存储时留下的截断外壳多扣额度，把读回值从中间截开，遮挡规则就认不出来了。
 */
export function redactStoredTrace(value: unknown): unknown {
  return scrubTrace(value, true, false);
}

/**
 * 写进本机诊断记录时用：保留原文，只遮凭据（密码栏的值、密钥、令牌、Cookie、网址里的账号密码），并照样限长、去掉图片数据。
 * 导出时再对每行跑一遍 redactStoredTrace（extension/src/shared/trace-store.ts）。
 */
export function sanitizeTraceForStore(value: unknown): unknown {
  return scrubTrace(value, false, true);
}

function scrubTrace(value: unknown, full: boolean, limits: boolean): unknown {
  const budget = limits ? { chars: 96_000, nodes: 1024 } : { chars: Infinity, nodes: Infinity };
  const max = limits ? { text: MAX_TEXT, depth: 12, entries: 256, key: 256 } : { text: Infinity, depth: Infinity, entries: Infinity, key: Infinity };

  function visit(value: unknown, depth = 0, redactInput = false, inReadback = false): unknown {
    if (--budget.nodes < 0 || budget.chars <= 0) return "[truncated: shared budget]";

    if (depth > max.depth) return "[truncated: depth limit]";

    if (typeof value === "string") {
      const count = Math.min(value.length, max.text, budget.chars);
      budget.chars -= count;
      const text = cleanText(value.slice(0, count), full);

      return count < value.length ? { text, truncated: true, originalChars: value.length } : text;
    }

    if (value instanceof Error) return visit({ name: value.name, message: value.message }, depth + 1);

    if (Array.isArray(value)) {
      const items: unknown[] = [];
      let count = 0;

      while (count < value.length && count < max.entries && budget.nodes > 0 && budget.chars > 0) {
        items.push(visit(value[count++], depth + 1));
      }

      if (count < value.length) items.push({ truncated: true, omittedItems: value.length - count });

      return items;
    }

    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;

    if (object.type === "image" || object.dataBase64 !== undefined || object.imageBase64 !== undefined) {
      const data = object.dataBase64 ?? object.imageBase64 ?? object.data;
      // 图片只留长度；截图元数据按白名单保留（A1 模型可核对与日志证据），字符串走 visit 脱敏。
      const meta: Record<string, unknown> = {};

      for (const key of ["width", "height", "pixelWidth", "pixelHeight", "cssWidth", "cssHeight", "devicePixelRatio", "tabId", "url", "title", "source", "capturedAt"]) {
        const v = object[key];

        if (typeof v === "number" && Number.isFinite(v)) meta[key] = v;
        else if (typeof v === "string" && v) meta[key] = visit(v, depth + 1);
      }

      // 导出时再跑一遍：已收起的图片没有数据，保留存储时记下的长度。
      const base64Chars = typeof data === "string" ? data.length : typeof object.base64Chars === "number" ? object.base64Chars : undefined;

      return { type: "image", mimeType: visit(object.mimeType ?? object.mediaType, depth + 1), base64Chars, omitted: true, ...meta };
    }

    const target = object.target ?? object.selector;
    const sensitive = typeof target === "string" && SENSITIVE_TARGET.test(target.slice(0, 1024));
    const inputTool = full && /^(fill|type_text|browser_run)$/.test(String(object.toolName ?? object.name ?? ""));
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;

    for (const key in object) {
      // pi-ai 流式拼工具参数用的原文草稿，与 arguments 重复；它是一整段字符串，按字段遮挡认不出里面填的值。
      if (!Object.hasOwn(object, key) || key === "partialArgs") continue;

      if (count++ >= max.entries || budget.nodes <= 0 || budget.chars <= 0) {
        result.traceTruncation = { truncated: true, reason: "shared budget or object entry limit" };
        break;
      }

      const safeKey = cleanText(key.slice(0, Math.min(max.key, budget.chars)), full);
      budget.chars -= safeKey.length;
      result[safeKey] = SECRET_KEY.test(key) || key === "signature" ||
        ((sensitive || redactInput) && /^(text|value|code)$/.test(key)) ||
        (full && inReadback && /^(requested|observed)$/.test(key))
        ? "[redacted]" : visit(object[key], depth + 1, inputTool && /^(args|arguments|params)$/.test(key), key === "readback");

      if (safeKey.length < key.length) result.traceTruncation = { truncated: true, reason: "key length limit" };
    }

    return result;
  }

  return visit(value);
}
