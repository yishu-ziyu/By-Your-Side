/**
 * `network` 的纯逻辑：CDP Network 事件 → 条目、环形缓冲、筛选、模型可见文本。
 * 被动观测，不注入页面；只记真实网络请求；展示前隐去 URL 里的凭据。
 * 依据 docs/evals/20260911-network.md。
 */

export const NETWORK_CAPACITY = 300;
export const NETWORK_DEFAULT_LIMIT = 40;
export const NETWORK_MAX_LIMIT = 200;
export const NETWORK_DEFAULT_TYPES = ["xhr", "fetch"];

export type NetworkTypes = string[] | "all";

export interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  /** CDP 的 resourceType，统一小写；未知为 "other"。 */
  resourceType: string;
  status?: number;
  mimeType?: string;
  encodedBytes?: number;
  fromCache?: boolean;
  failed?: string;
  canceled?: boolean;
  /** 发生过重定向的次数（同一 requestId 的后续跳转）。 */
  redirects?: number;
  /** CDP 单调时钟（秒）；同页面的事件才可相减。 */
  startedTs?: number;
  endedTs?: number;
  startedAt: number;
}

export interface NetworkRing {
  entries: NetworkEntry[];
  dropped: number;
}

export type NetworkEventUpdate =
  | { kind: "start"; entry: NetworkEntry }
  | { kind: "patch"; requestId: string; patch: Partial<NetworkEntry> };

export interface NetworkQuery {
  urlContains?: string;
  types?: NetworkTypes | string;
  limit?: number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeType(value: unknown): string {
  const raw = typeof value === "string" && value ? value : "other";
  return raw.toLowerCase();
}

/** 只记录真实网络请求；data:/blob: 这类伪 URL 既不是接口，也会把 base64 拖进上下文。 */
export function isRecordableUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

/** 单条 CDP Network 事件 → 缓冲更新；与条目无关的事件返回 null。 */
export function networkEventToUpdate(method: string, params: Record<string, unknown>, now: number = Date.now()): NetworkEventUpdate | null {
  const requestId = String(params.requestId ?? "");
  if (!requestId) return null;

  if (method === "Network.requestWillBeSent") {
    const request = params.request as Record<string, unknown> | undefined;
    const url = text(request?.url);
    if (!url || !isRecordableUrl(url)) return null;
    return {
      kind: "start",
      entry: {
        requestId,
        method: text(request?.method) ?? "GET",
        url,
        resourceType: normalizeType(params.type),
        startedAt: now,
        ...(numeric(params.timestamp) !== undefined ? { startedTs: numeric(params.timestamp)! } : {}),
      },
    };
  }

  if (method === "Network.responseReceived") {
    const response = params.response as Record<string, unknown> | undefined;
    if (!response) return null;
    const patch: Partial<NetworkEntry> = {};
    const status = numeric(response.status);
    if (status !== undefined) patch.status = status;
    const mime = text(response.mimeType);
    if (mime) patch.mimeType = mime.split(";")[0]!.trim();
    if (response.fromDiskCache === true || response.fromServiceWorker === true) patch.fromCache = true;
    return { kind: "patch", requestId, patch };
  }

  if (method === "Network.loadingFinished") {
    return {
      kind: "patch",
      requestId,
      patch: { encodedBytes: numeric(params.encodedDataLength) ?? 0, endedTs: numeric(params.timestamp) },
    };
  }

  if (method === "Network.loadingFailed") {
    return {
      kind: "patch",
      requestId,
      patch: {
        failed: text(params.errorText) ?? "failed",
        canceled: params.canceled === true,
        endedTs: numeric(params.timestamp),
      },
    };
  }

  return null;
}

/** 追加一条；超容量丢最旧，并累计 dropped。 */
export function appendNetworkEntry(ring: NetworkRing, entry: NetworkEntry, capacity: number = NETWORK_CAPACITY): NetworkRing {
  const entries = [...ring.entries, entry];
  let dropped = ring.dropped;
  while (entries.length > capacity) {
    entries.shift();
    dropped += 1;
  }
  return { entries, dropped };
}

/** 应用一条 patch；条目不在缓冲里则原样返回。 */
export function patchNetworkEntry(ring: NetworkRing, requestId: string, patch: Partial<NetworkEntry>): NetworkRing {
  const index = ring.entries.findIndex((entry) => entry.requestId === requestId);
  if (index < 0) return ring;
  const entries = ring.entries.slice();
  entries[index] = { ...entries[index]!, ...patch };
  return { entries, dropped: ring.dropped };
}

/** 重定向：同一 requestId 再 start 时替换旧条目并记跳数。 */
export function restartNetworkEntry(ring: NetworkRing, entry: NetworkEntry): NetworkRing {
  const previous = ring.entries.find((candidate) => candidate.requestId === entry.requestId);
  if (!previous) return appendNetworkEntry(ring, entry);
  const entries = ring.entries.slice();
  const index = entries.indexOf(previous);
  entries[index] = { ...entry, redirects: (previous.redirects ?? 0) + 1 };
  return { entries, dropped: ring.dropped };
}

function typeSet(types: NetworkQuery["types"]): Set<string> | null {
  if (types === "all") return null;
  const list = types === undefined ? NETWORK_DEFAULT_TYPES : typeof types === "string" ? [types] : types;
  return new Set(list.map((type) => String(type).toLowerCase()));
}

/** 取最近 limit 条匹配项；返回结果保持时间顺序。 */
export function selectNetworkEntries(entries: readonly NetworkEntry[], query: NetworkQuery = {}): { shown: NetworkEntry[]; matched: number } {
  const wanted = typeSet(query.types);
  const needle = query.urlContains?.trim().toLowerCase();
  const matched = entries.filter((entry) => {
    if (wanted && !wanted.has(entry.resourceType)) return false;
    if (needle && !entry.url.toLowerCase().includes(needle)) return false;
    return true;
  });
  const requested = Number.isFinite(query.limit) ? Math.trunc(query.limit!) : NETWORK_DEFAULT_LIMIT;
  const limit = Math.min(NETWORK_MAX_LIMIT, Math.max(1, requested));
  return { shown: matched.slice(Math.max(0, matched.length - limit)), matched: matched.length };
}

const SENSITIVE_PARAM =
  /^(access[_-]?token|refresh[_-]?token|token|auth|authorization|api[_-]?key|apikey|key|client[_-]?secret|secret|password|passwd|pwd|session([_-]?id)?|sid|signature|sign|nonce|ticket|credential)$/i;

/** URL 展示前的凭据隐去：user:pass@ 与敏感查询参数只留结构。 */
export function redactUrlCredentials(raw: string): string {
  let url = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1[redacted]@");
  url = url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, sep: string, key: string) => {
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      /* 保留原样匹配 */
    }
    return SENSITIVE_PARAM.test(decoded) ? `${sep}${key}=[redacted]` : whole;
  });
  return url;
}

export function entryDurationMs(entry: NetworkEntry): number | undefined {
  if (entry.startedTs === undefined || entry.endedTs === undefined) return undefined;
  const ms = Math.round((entry.endedTs - entry.startedTs) * 1000);
  return ms >= 0 ? ms : undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 展示用 URL 长度上限：跟踪类 URL 会很长，截断避免撑上下文。 */
export const NETWORK_MAX_URL_CHARS = 240;

export function clipUrl(url: string): string {
  return url.length > NETWORK_MAX_URL_CHARS ? `${url.slice(0, NETWORK_MAX_URL_CHARS)}…` : url;
}

/** 一行：`3. failed POST https://… — xhr (net::ERR_FAILED) (canceled)`。 */
export function formatNetworkEntryLine(entry: NetworkEntry, index: number): string {
  const status = entry.failed ? "failed" : entry.status !== undefined ? String(entry.status) : "pending";
  const parts = [`${index}.`, status, entry.method, clipUrl(redactUrlCredentials(entry.url)), `— ${entry.resourceType}`];
  if (entry.failed) parts.push(`(${entry.failed})`);
  if (entry.mimeType) parts.push(entry.mimeType);
  if (entry.encodedBytes !== undefined) parts.push(formatBytes(entry.encodedBytes));
  const duration = entryDurationMs(entry);
  if (duration !== undefined) parts.push(`${duration}ms`);
  if (entry.fromCache) parts.push("(cache)");
  if (entry.canceled) parts.push("(canceled)");
  if (entry.redirects) parts.push(`(${entry.redirects} redirect${entry.redirects > 1 ? "s" : ""})`);
  return parts.join(" ");
}

export interface NetworkReportInfo {
  total: number;
  matched: number;
  dropped: number;
  capacity?: number;
  types?: NetworkQuery["types"];
  urlContains?: string;
}

/**
 * 模型可见回执。空结果也给出原因与下一步；不编造状态。
 * 调用方负责再过不可信边界（agent 侧 wrapPageContent）。
 */
export function formatNetworkReport(shown: readonly NetworkEntry[], info: NetworkReportInfo): string {
  const filters: string[] = [];
  if (info.types !== "all") {
    const types = typeof info.types === "string" ? [info.types] : info.types ?? NETWORK_DEFAULT_TYPES;
    filters.push(`type ${types.join("/")}`);
  }
  if (info.urlContains) filters.push(`url~"${info.urlContains}"`);

  if (info.total === 0) {
    return "No network requests recorded for this tab yet. Recording only happens while the extension holds the debugger on the tab (around navigate, snapshot, click and other observations), and the buffer is memory-only (empty after the extension restarts). Reload the page or redo the step you care about, then call network again.";
  }
  if (shown.length === 0) {
    return `Network requests recorded (${info.total}) but none match the current filter (${filters.join(", ") || "all"}). Call network again with no filter or types:"all" to see everything.`;
  }

  const dropped = info.dropped > 0 ? `, ${info.dropped} oldest dropped at capacity ${info.capacity ?? NETWORK_CAPACITY}` : "";
  const header = `Network requests observed on this tab: showing ${shown.length} of ${info.matched} matched (${info.total} recorded${dropped}${filters.length ? `, filter ${filters.join(", ")}` : ""}).`;
  const lines = shown.map((entry, index) => formatNetworkEntryLine(entry, index + 1));
  return `${header}\n${lines.join("\n")}\nUse fetch with the browser's login state to read the data behind one of these URLs.`;
}
