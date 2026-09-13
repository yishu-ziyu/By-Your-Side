/** 侧栏展示的授权请求；真正的参数与一次性票据由伴随进程保管。 */
export interface FetchConsentRequest {
  id: string;
  conversationId: string;
  runId: string;
  controlVersion: number;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  expiresAt: number;
}

export type ConsentStatus = "allowed" | "rejected" | "expired" | "cancelled";

export function isFetchConsentRequest(value: unknown): value is FetchConsentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as FetchConsentRequest;
  const identity = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 96;
  return identity(r.id) && identity(r.conversationId) && identity(r.runId)
    && Number.isSafeInteger(r.controlVersion) && r.controlVersion >= 0
    && typeof r.url === "string" && r.url.length > 0 && r.url.length <= 8192
    && (r.method === "GET" || r.method === "POST")
    && Number.isFinite(r.expiresAt) && r.expiresAt > 0
    && (r.body === undefined || typeof r.body === "string" && r.body.length <= 65536)
    && !!r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)
    && Object.keys(r.headers).length <= 100
    && Object.entries(r.headers).every(([name, content]) => name.length <= 256 && typeof content === "string" && content.length <= 4096)
    && JSON.stringify(r.headers).length <= 16384;
}
