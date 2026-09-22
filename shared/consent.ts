/** 侧栏展示的授权请求；真正的参数与一次性票据由伴随进程保管。 */
export interface FetchConsentRequest {
  kind?: 'fetch';
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

/**
 * 有边界的页面状态重设确认：只绑定本任务、本要求版本、本页面与这一组参数的一次操作。
 * 侧栏只看到展示副本；真正的绑定与页面/任务复核在伴随进程里完成。
 */
export interface WriteConsentRequest {
  kind: 'write';
  id: string;
  conversationId: string;
  runId: string;
  controlVersion: number;
  expiresAt: number;
  goal: string;
  description: string;
  tool: string;
  target: string;
  value: string;
}

export type ConsentRequest = FetchConsentRequest | WriteConsentRequest;

export type ConsentStatus = "allowed" | "rejected" | "expired" | "cancelled";

export function isFetchConsentRequest(value: unknown): value is FetchConsentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as FetchConsentRequest;

  if (r.kind !== undefined && r.kind !== 'fetch') return false;
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

/** 只接受宿主生成的展示字段；绑定校验不在这里，也不读模型／网页文字。 */
export function isWriteConsentRequest(value: unknown): value is WriteConsentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as WriteConsentRequest;
  const identity = (s: unknown, max = 96) => typeof s === "string" && s.length > 0 && s.length <= max;

  return r.kind === 'write' && identity(r.id) && identity(r.conversationId) && identity(r.runId)
    && Number.isSafeInteger(r.controlVersion) && r.controlVersion >= 0
    && Number.isFinite(r.expiresAt) && r.expiresAt > 0
    && identity(r.goal, 600) && identity(r.description, 600)
    && identity(r.tool, 100) && identity(r.target, 500) && identity(r.value, 500);
}

export function isConsentRequest(value: unknown): value is ConsentRequest {
  return isFetchConsentRequest(value) || isWriteConsentRequest(value);
}
