import { FILE_READ_MAX_BYTES } from "../../../shared/protocol.js";

export interface CapturedDownloadFile {
  dataBase64: string;
  mimeType: string;
}

interface CaptureRecord extends CapturedDownloadFile {
  tabId: number;
  token: string;
  url: string;
  bytes: number;
}

const CAPTURE_TOTAL_MAX = 50 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;

const enabledTabs = new Set<number>();
const activeTokens = new Map<number, Set<string>>();
const directLinks = new Map<string, { url: string; filename?: string }>();

export function captureDirectLink(tabId: number, token: string, url: string, filename?: string): void {
  if (!enabledTabs.has(tabId)) throw new Error("无法捕获下载响应，下载未执行。");
  directLinks.set(token, { url, filename });
}

const captures = new Map<string, CaptureRecord>();
let capturedBytes = 0;

function header(params: Record<string, unknown>, name: string): string {
  const headers = Array.isArray(params.responseHeaders) ? params.responseHeaders : [];

  for (const item of headers) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;

    if (typeof entry.name === "string" && entry.name.toLowerCase() === name && typeof entry.value === "string") return entry.value;
  }

  return "";
}

function eligible(params: Record<string, unknown>): { bytes: number; mimeType: string } | null {
  if (params.responseErrorReason !== undefined || params.responseStatusCode !== 200) return null;
  const length = header(params, "content-length");
  if (!/^\d+$/.test(length)) return null;
  const bytes = Number(length);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > FILE_READ_MAX_BYTES) return null;
  const mimeType = header(params, "content-type").split(";", 1)[0]!.trim().toLowerCase();
  const attachment = /^\s*attachment(?:\s*;|\s*$)/i.test(header(params, "content-disposition"));
  const readable = mimeType === "application/pdf" || mimeType === "application/json" || mimeType === "application/octet-stream"
    || /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(mimeType)
    || mimeType.startsWith("text/") || /(?:wordprocessingml|spreadsheetml|presentationml)/.test(mimeType);

  // The download attribute can turn an inline response into a download.
  if (!attachment && !readable) return null;

  return { bytes, mimeType };
}

function textBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return btoa(binary);
}

async function continueResponse(tabId: number, requestId: string, responseHeaders?: unknown[], responseCode?: number): Promise<void> {
  await chrome.debugger.sendCommand({ tabId }, "Fetch.continueResponse", { requestId, ...(responseHeaders ? { responseHeaders, responseCode } : {}) }).catch(async () => {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
  });
}

/** Optional capture must never make arming the real download fail. */
export async function enableDownloadBodyCapture(tabId: number, token: string): Promise<void> {
  const tokens = activeTokens.get(tabId) ?? new Set<string>();
  tokens.add(token);
  activeTokens.set(tabId, tokens);
  if (enabledTabs.has(tabId)) return;

  try {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Response" }],
    });
    enabledTabs.add(tabId);
  } catch {
    activeTokens.delete(tabId);
  }
}

/** Stop intercepting for this arm. Completed bodies remain available until wait_event consumes them. */
export async function releaseDownloadBodyCapture(tabId: number, token: string): Promise<void> {
  directLinks.delete(token);
  const tokens = activeTokens.get(tabId);
  tokens?.delete(token);
  if (tokens?.size) return;
  activeTokens.delete(tabId);
  if (!enabledTabs.delete(tabId)) return;
  await chrome.debugger.sendCommand({ tabId }, "Fetch.disable").catch(() => {});
}

export function abandonDownloadBodyCapture(token: string): void {
  const existing = captures.get(token);
  if (!existing) return;
  capturedBytes -= existing.bytes;
  captures.delete(token);
}

export function noteDownloadBodyCaptureDetached(tabId: number): void {
  enabledTabs.delete(tabId);
  for (const token of activeTokens.get(tabId) ?? []) directLinks.delete(token);
  activeTokens.delete(tabId);

  for (const [token, capture] of captures) if (capture.tabId === tabId) abandonDownloadBodyCapture(token);
}

export function takeDownloadBodyCapture(
  token: string,
  url: string,
  completed: boolean,
  danger: string | undefined,
): CapturedDownloadFile | undefined {
  const capture = captures.get(token);
  abandonDownloadBodyCapture(token);
  if (!capture || !completed || danger || capture.url !== url) return undefined;

  return { dataBase64: capture.dataBase64, mimeType: capture.mimeType };
}

/** Fetch response pauses are scoped to the current tab's armed download; every response is resumed, including capture failures. */
export async function handleDownloadBodyCapture(
  tabId: number,
  params: Record<string, unknown>,
  armedToken: () => string | undefined,
): Promise<void> {
  const requestId = typeof params.requestId === "string" ? params.requestId : "";
  if (!requestId) return;
  const token = enabledTabs.has(tabId) ? armedToken() : undefined;
  const direct = token ? directLinks.get(token) : undefined;
  const requestUrl = (params.request as Record<string, unknown> | undefined)?.url;
  const matchesDirect = direct && requestUrl === direct.url;
  const status = Number(params.responseStatusCode);
  if (matchesDirect && status >= 300 && status < 400) {
    const location = header(params, "location");
    if (location) direct.url = new URL(location, direct.url).href;
  }
  // Force only the requested response to download, so inline images and PDFs do not replace the working page.
  const responseHeaders = matchesDirect && status >= 200 && (status < 300 || status >= 400)
    ? [...(Array.isArray(params.responseHeaders) ? params.responseHeaders : []).filter(item =>
      String(item.name).toLowerCase() !== "content-disposition"),
      { name: "Content-Disposition", value: direct.filename
        ? `attachment; filename*=UTF-8''${encodeURIComponent(direct.filename)}` : header(params, "content-disposition").replace(/^inline/i, "attachment") || "attachment" }]
    : undefined;
  const resume = () => continueResponse(tabId, requestId, responseHeaders, status);
  const wanted = token && (!direct || matchesDirect) ? eligible(params) : null;
  if (!token || !wanted) {
    await resume();
    return;
  }

  let settled = false;

  try {
    const command = chrome.debugger.sendCommand({ tabId }, "Fetch.getResponseBody", { requestId });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("download body capture timed out")), BODY_READ_TIMEOUT_MS); });
    const result = await Promise.race([command, timeout]).finally(() => { if (timer) clearTimeout(timer); }) as { body?: unknown; base64Encoded?: unknown };
    if (settled || typeof result.body !== "string") return;
    const dataBase64 = result.base64Encoded === true ? result.body : textBase64(result.body);
    const actualBytes = dataBase64.length * 3 / 4 - (dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0);
    if (!Number.isSafeInteger(actualBytes) || actualBytes <= 0 || actualBytes > FILE_READ_MAX_BYTES) return;
    const previous = captures.get(token);
    const previousBytes = previous?.bytes ?? 0;
    if (capturedBytes - previousBytes + actualBytes > CAPTURE_TOTAL_MAX) return;
    if (typeof requestUrl !== "string") return;
    if (previous) abandonDownloadBodyCapture(token);
    captures.set(token, { tabId, token, url: requestUrl, bytes: actualBytes, dataBase64, mimeType: wanted.mimeType });
    capturedBytes += actualBytes;
  } catch {
    // A missing auxiliary copy does not change the browser's real download.
  } finally {
    settled = true;
    await resume();
  }
}
