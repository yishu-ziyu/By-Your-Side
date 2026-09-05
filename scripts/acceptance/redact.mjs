const KEY_DENY =
  /^(cookie|cookies|token|access_token|refresh_token|id_token|authorization|set-cookie|password|secret|session|sessions|history|html|pageContent|innerHTML|documentCookie|document_cookie)$/i;

const VALUE_DENY = [
  /(?:^|;\s*)(?:cookie|set-cookie)\s*[:=]/i,
  /authorization\s*:\s*bearer\s+\S+/i,
  /access_token\s*[:=]\s*\S+/i,
  /refresh_token\s*[:=]\s*\S+/i,
  /(?:^|[\s&])token=\S+/i,
];

const MAX_STRING = 400;

function redactString(value) {
  let out = value;
  for (const re of VALUE_DENY) {
    if (re.test(out)) return "[redacted]";
  }
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…`;
  return out;
}

/**
 * 去掉 cookie / token / 浏览历史 / 整页内容。递归处理对象和数组。
 * 断言用的短字段（unique text 是否出现、计数器、填写值）会保留。
 */
export function redactEvidence(value, key = "") {
  if (value == null) return value;
  if (KEY_DENY.test(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (KEY_DENY.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactEvidence(v, k);
    }
    return out;
  }
  return String(value);
}

export function assertNoSecrets(value, path = "$") {
  if (value == null) return;
  if (typeof value === "string") {
    for (const re of VALUE_DENY) {
      if (re.test(value)) throw new Error(`evidence leaked secret at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (KEY_DENY.test(k) && v !== "[redacted]") {
        throw new Error(`evidence leaked ${k} at ${path}.${k}`);
      }
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}
