/**
 * `fetch` 的边界判定（纯函数，可单测）：只允许 http(s) 公网地址、GET/POST。
 * 浏览器 Agent 带着登录态取接口，最怕模型被页面内容骗去读本地服务或改数据：
 * 这里不做"问模型"，直接在扩展侧拒绝。
 * 依据 docs/evals/20260911-fetch-tool.md。
 */

export const FETCH_MAX_BYTES = 512 * 1024;
export const FETCH_ALLOWED_METHODS = ["GET", "POST"] as const;
export type FetchMethod = (typeof FETCH_ALLOWED_METHODS)[number];

export class FetchRefused extends Error {}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;
const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

export interface FetchRequest {
  url: string;
  method: FetchMethod;
  headers: Record<string, string>;
  body?: string;
}

/** 校验并规范化请求；非法即抛 FetchRefused（回执里原样给模型看）。 */
export function normalizeFetchRequest(raw: {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
}): FetchRequest {
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) throw new FetchRefused("fetch 需要 url。");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchRefused(`fetch 的 url 无效：${url.slice(0, 120)}。需要完整 http(s) 地址。`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchRefused(`fetch 只支持 http(s)，收到 ${parsed.protocol}。操作未执行。`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_HOST.test(host) || PRIVATE_V4.some((re) => re.test(host)) || host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host)) {
    throw new FetchRefused(`fetch 拒绝本地/私网地址（${host}）：带着登录态的请求不能指向本机服务。操作未执行。`);
  }
  const method = String(raw.method ?? "GET").toUpperCase();
  if (!(FETCH_ALLOWED_METHODS as readonly string[]).includes(method)) {
    throw new FetchRefused(`fetch 只允许 ${FETCH_ALLOWED_METHODS.join("/")}；${method} 会改服务端数据，未执行。`);
  }
  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof value !== "string") throw new FetchRefused(`fetch 的 header ${key} 必须是字符串。`);
      if (/^(host|cookie|content-length)$/i.test(key)) continue; // 由浏览器按目标站点决定
      headers[key] = value;
    }
  }
  const body = typeof raw.body === "string" ? raw.body : undefined;
  if (body !== undefined && method === "GET") throw new FetchRefused("GET 不带 body；要提交数据请用 POST。");
  return { url: parsed.toString(), method: method as FetchMethod, headers, body };
}

/** 读响应文本到上限；超出即截断（明确告知，不假装完整）。 */
export async function readCappedText(response: Response, maxBytes: number = FETCH_MAX_BYTES): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const buffer = await response.arrayBuffer();
  const all = new Uint8Array(buffer);
  const bytes = all.byteLength;
  const slice = bytes > maxBytes ? all.subarray(0, maxBytes) : all;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { text, bytes, truncated: bytes > maxBytes };
}
