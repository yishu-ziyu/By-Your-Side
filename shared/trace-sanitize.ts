const SECRET_KEY = /^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|set-cookie)$/i;

const SENSITIVE_TARGET = /password|passwd|pwd|secret|token|api[_-]?key|密码|口令/i;

export const SENSITIVE_FIELD_NAME = /password|passwd|pwd|\b(?:otp|pin|ssn)\b|one-time|(?:verification|security|sms) ?code|验证码|校验码|动态码|密码|口令|cvv|cvc|card ?number|卡号|安全码|身份证|银行卡/i;

const MAX_TEXT = 64_000;
export const GOAL_CHECK_FORMAT_SUFFIX = "\n\nYour previous reply could not be used. Reply with ONLY the JSON object described above: no other text, no markdown fences, no questions.";
const GOAL_CHECK_PRIVATE_KEYS = new Set(["input", "replayInput", "modelReply", "verdict", "hostFacts", "remaining", "correction", "finding", "evidence", "items", "verificationTargets", "pageRead", "pageMovedTo"]);

function cleanCredentials(text: string): string {
  return text
    .replace(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/((?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|密码|口令)["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

function cleanText(text: string, full: boolean): string {
  return cleanCredentials(full ? text.replace(/(now contains:? )«(?:[\s\S]*»|[\s\S]*$)/g, "$1«[redacted]»") : text);
}

export function sanitizeTrace(value: unknown): unknown {
  return scrubTrace(value, true, true);
}

export function redactStoredTrace(value: unknown): unknown {
  return scrubTrace(value, true, false);
}

export function sanitizeTraceForStore(value: unknown): unknown {
  return scrubTrace(value, false, true);
}

function scrubTrace(value: unknown, full: boolean, limits: boolean): unknown {
  const goalCheck = !!value && typeof value === "object" && !Array.isArray(value) && "v" in value && value.v === 1
    && "checkId" in value && typeof value.checkId === "string" && "promptSha" in value && typeof value.promptSha === "string";
  const budget = limits ? { chars: goalCheck ? 768_000 : 96_000, nodes: goalCheck ? 4096 : 1024 } : { chars: Infinity, nodes: Infinity };
  const max = limits ? { text: goalCheck ? 512_000 : MAX_TEXT, depth: 12, entries: 256, key: 256 } : { text: Infinity, depth: Infinity, entries: Infinity, key: Infinity };

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
      const meta: Record<string, unknown> = {};

      for (const key of ["width", "height", "pixelWidth", "pixelHeight", "cssWidth", "cssHeight", "devicePixelRatio", "tabId", "url", "title", "source", "capturedAt"]) {
        const v = object[key];

        if (typeof v === "number" && Number.isFinite(v)) meta[key] = v;
        else if (typeof v === "string" && v) meta[key] = visit(v, depth + 1);
      }

      const base64Chars = typeof data === "string" ? data.length : typeof object.base64Chars === "number" ? object.base64Chars : undefined;

      return { type: "image", mimeType: visit(object.mimeType ?? object.mediaType, depth + 1), base64Chars, omitted: true, ...meta };
    }

    const target = object.target ?? object.selector;
    const sensitive = typeof target === "string" && SENSITIVE_TARGET.test(target.slice(0, 1024));
    const inputTool = full && /^(fill|type_text|browser_run)$/.test(String(object.toolName ?? object.name ?? ""));
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;

    for (const key in object) {
      if (!Object.hasOwn(object, key) || key === "partialArgs") continue;

      if (count++ >= max.entries || budget.nodes <= 0 || budget.chars <= 0) {
        result.traceTruncation = { truncated: true, reason: "shared budget or object entry limit" };
        break;
      }

      const safeKey = cleanText(key.slice(0, Math.min(max.key, budget.chars)), full);
      budget.chars -= safeKey.length;
      const stored = object[key];
      if (!full && goalCheck && key === "input" && typeof stored === "string") {
        try {
          const retried = stored.endsWith(GOAL_CHECK_FORMAT_SUFFIX);
          const parsed: unknown = JSON.parse(retried ? stored.slice(0, -GOAL_CHECK_FORMAT_SUFFIX.length) : stored);
          result[safeKey] = JSON.stringify(visit(parsed, depth + 1)) + (retried ? GOAL_CHECK_FORMAT_SUFFIX : "");
        } catch {
          result[safeKey] = visit(stored, depth + 1);
        }
      } else {
        result[safeKey] = (full && goalCheck && GOAL_CHECK_PRIVATE_KEYS.has(key)) || SECRET_KEY.test(key) || key === "signature" ||
          ((sensitive || redactInput) && /^(text|value|code)$/.test(key)) ||
          (full && inReadback && /^(requested|observed)$/.test(key))
          ? "[redacted]" : visit(stored, depth + 1, inputTool && /^(args|arguments|params)$/.test(key), key === "readback");
      }

      if (safeKey.length < key.length) result.traceTruncation = { truncated: true, reason: "key length limit" };
    }

    return result;
  }

  return visit(value);
}
