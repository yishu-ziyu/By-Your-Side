/** 诊断记录的脱敏：纯函数，Node 与扩展通用（从 run-trace.ts 拆出，扩展里 RunTrace 换成空实现）。 */
const SECRET_KEY = /^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|set-cookie)$/i;

const SENSITIVE_TARGET = /password|passwd|pwd|secret|token|api[_-]?key|密码|口令/i;

const MAX_TEXT = 64_000;

function cleanText(text: string): string {
  return text
    .replace(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/((?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|密码|口令)["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

/** Best-effort diagnostic redaction; arbitrary unlabelled secrets cannot be classified reliably. */
export function sanitizeTrace(value: unknown): unknown {
  const budget = { chars: 96_000, nodes: 1024 };

  function visit(value: unknown, depth = 0, redactInput = false): unknown {
    if (--budget.nodes < 0 || budget.chars <= 0) return "[truncated: shared budget]";

    if (depth > 12) return "[truncated: depth limit]";

    if (typeof value === "string") {
      const count = Math.min(value.length, MAX_TEXT, budget.chars);
      budget.chars -= count;
      const text = cleanText(value.slice(0, count));

      return count < value.length ? { text, truncated: true, originalChars: value.length } : text;
    }

    if (value instanceof Error) return visit({ name: value.name, message: value.message }, depth + 1);

    if (Array.isArray(value)) {
      const items: unknown[] = [];
      let count = 0;

      while (count < value.length && count < 256 && budget.nodes > 0 && budget.chars > 0) {
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

      return { type: "image", mimeType: visit(object.mimeType ?? object.mediaType, depth + 1), base64Chars: typeof data === "string" ? data.length : undefined, omitted: true, ...meta };
    }

    const target = object.target ?? object.selector;
    const sensitive = typeof target === "string" && SENSITIVE_TARGET.test(target.slice(0, 1024));
    const inputTool = /^(fill|type_text|browser_run)$/.test(String(object.toolName ?? object.name ?? ""));
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;

    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;

      if (count++ >= 256 || budget.nodes <= 0 || budget.chars <= 0) {
        result.traceTruncation = { truncated: true, reason: "shared budget or object entry limit" };
        break;
      }

      const safeKey = cleanText(key.slice(0, Math.min(256, budget.chars)));
      budget.chars -= safeKey.length;
      result[safeKey] = SECRET_KEY.test(key) || key === "signature" ||
        ((sensitive || redactInput) && /^(text|value|code)$/.test(key))
        ? "[redacted]" : visit(object[key], depth + 1, inputTool && /^(args|arguments|params)$/.test(key));

      if (safeKey.length < key.length) result.traceTruncation = { truncated: true, reason: "key length limit" };
    }

    return result;
  }

  return visit(value);
}
