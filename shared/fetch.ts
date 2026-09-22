/**
 * `fetch` 的边界判定（纯函数，可单测）：只允许 http(s) 公网地址、GET/POST。
 * 浏览器 Agent 带着登录态取接口，最怕模型被页面内容骗去读本地服务或改数据：
 * 这里不做"问模型"，直接在扩展侧拒绝。
 * 依据 docs/evals/20260911-fetch-tool.md。
 */

export const FETCH_MAX_BYTES = 512 * 1024;

export const FETCH_READ_DEADLINE_MS = 30_000;

export const FETCH_MAX_REDIRECTS = 3;

export const FETCH_ALLOWED_METHODS = ["GET", "POST"] as const;

export type FetchMethod = (typeof FETCH_ALLOWED_METHODS)[number];

export class FetchRefused extends Error {}

/** Tests may allow one exact origin (loopback fixture). Production never calls this. */
let fetchTestOrigin: string | null = null;

export function installFetchTestOrigin(origin: string): () => void {
  fetchTestOrigin = origin;

  return () => {
    if (fetchTestOrigin === origin) fetchTestOrigin = null;
  };
}

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
  const isTestOrigin = fetchTestOrigin !== null && parsed.origin === fetchTestOrigin;

  if (!isTestOrigin && (PRIVATE_HOST.test(host) || PRIVATE_V4.some((re) => re.test(host)) || host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host))) {
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

export type CappedStopReason = "complete" | "limit" | "deadline" | "abort";

export interface CappedRead {
  text: string;
  /** Bytes kept for the caller. */
  retainedBytes: number;
  /** Bytes actually pulled from the stream (may be one chunk past the cap). */
  readBytes: number;
  /** Content-Length when the server sent it; never invented after an early stop. */
  totalBytes: number | null;
  truncated: boolean;
  stoppedReason: CappedStopReason;
  /** Back-compat: retained bytes. */
  bytes: number;
}

function headerTotalBytes(response: Response): number | null {
  const raw = response.headers.get("content-length");

  if (!raw) return null;
  const n = Number(raw);

  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function redirectUrl(response: Response, currentUrl: string): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");

  if (!location) return null;

  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw new FetchRefused("fetch 的重定向地址无效，操作未执行。");
  }
}

export function assertRedirectAllowed(fromUrl: string, toUrl: string): void {
  const from = new URL(fromUrl);
  const to = new URL(toUrl);

  if (from.origin !== to.origin) {
    throw new FetchRefused(`fetch 拒绝跨源重定向（${from.origin} → ${to.origin}）。操作未执行。`);
  }

  normalizeFetchRequest({ url: toUrl });
}

/** Stream the body; stop at the byte cap, deadline, or abort. Never arrayBuffer() the whole response. */
export async function readCappedText(
  response: Response,
  maxBytes: number = FETCH_MAX_BYTES,
  opts: { signal?: AbortSignal; deadlineMs?: number; now?: () => number } = {},
): Promise<CappedRead> {
  const totalBytes = headerTotalBytes(response);
  const now = opts.now ?? Date.now;
  const deadline = opts.deadlineMs !== undefined ? now() + opts.deadlineMs : undefined;
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let readBytes = 0;
  let stoppedReason: CappedStopReason = "complete";

  const finish = (reason: CappedStopReason): CappedRead => {
    const retained = new Uint8Array(retainedBytes);
    let offset = 0;

    for (const chunk of chunks) {
      retained.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const text = decoder.decode(retained, { stream: true }) + decoder.decode();

    return {
      text,
      retainedBytes,
      readBytes,
      totalBytes,
      truncated: reason === "limit" || reason === "deadline" || reason === "abort" || (totalBytes !== null && totalBytes > retainedBytes),
      stoppedReason: reason,
      bytes: retainedBytes,
    };
  };

  if (opts.signal?.aborted) return finish("abort");
  const body = response.body;

  if (!body) {
    const fallback = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));

    if (fallback.byteLength > maxBytes) {
      chunks.push(fallback.subarray(0, maxBytes));
      retainedBytes = maxBytes;
      readBytes = fallback.byteLength;

      return finish("limit");
    }

    chunks.push(fallback);
    retainedBytes = fallback.byteLength;
    readBytes = fallback.byteLength;

    return finish("complete");
  }

  const reader = body.getReader();

  try {
    for (;;) {
      if (opts.signal?.aborted) {
        await reader.cancel().catch(() => {});

        return finish("abort");
      }

      if (deadline !== undefined && now() >= deadline) {
        await reader.cancel().catch(() => {});

        return finish("deadline");
      }

      const { done, value } = await reader.read();

      if (done) return finish(stoppedReason);

      if (!value || value.byteLength === 0) continue;
      readBytes += value.byteLength;

      if (retainedBytes >= maxBytes) {
        stoppedReason = "limit";
        await reader.cancel().catch(() => {});

        return finish("limit");
      }

      const room = maxBytes - retainedBytes;

      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        retainedBytes += room;
        stoppedReason = "limit";
        await reader.cancel().catch(() => {});

        return finish("limit");
      }

      chunks.push(value);
      retainedBytes += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already cancelled */
    }
  }

  return finish(stoppedReason);
}
