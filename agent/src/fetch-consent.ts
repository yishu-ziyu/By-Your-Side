/**
 * fetch 授权的等待与「一次一票」。
 * 侧栏看到的只是展示副本（敏感 header 打码、body 原文，超限直接拒绝）；
 * 真正要发的参数是归一化后的独立副本，票据按它的哈希绑定，确认之后不再读调用方的对象。
 * 只有受信任 UI 的选择（会话管理器从 consent_decision 转来）能放行；模型文字、网页内容、
 * 工具回执都进不到这里。等待期间任务/控制权一变，或用户拒绝、超时、取消、断线，一律不放行。
 */
import { normalizeFetchRequest } from "../../shared/fetch.js";
import { CONSENT_TTL_MS, ConsentLedger } from "./consent-ticket.js";
import { isFetchConsentRequest, type ConsentStatus, type FetchConsentRequest } from "../../shared/consent.js";
import type { ServerMessage } from "../../shared/protocol.js";
import { randomUUID } from "node:crypto";

/** 侧栏最多展示这么长的请求体；超限明确拒绝，不截断后偷偷发送没展示过的内容。 */
export const FETCH_CONSENT_BODY_LIMIT = 65_536;

/** 待确认列表的展示上限：条数与 UTF-8 序列化总量都有硬上限，超限拒绝新增，不发网络。 */
export const FETCH_CONSENT_LIST_LIMIT = 32;

export const FETCH_CONSENT_LIST_BYTES_LIMIT = 512 * 1024;

/** 这些 header 的值不出现在侧栏；后台票据仍按原值哈希绑定。 */
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-session-token|x-goog-api-key)$/i;

const STATUS_MESSAGE: Record<ConsentStatus, string> = {
  allowed: "已允许本次请求。",
  rejected: "已拒绝，本次请求未发送。",
  expired: "确认已过期，本次请求未发送。",
  cancelled: "请求已取消，本次请求未发送。",
};

/** 授权绑定的任务身份：由会话管理器给出，决策时再读一次做复核。 */
export interface FetchConsentContext {
  runId: string | null;
  controlVersion: number;
}

/** 确认结果；params 获准时才给出，是真正要发的那份参数副本。 */
export interface ConsentOutcome {
  allowed: boolean;
  params?: Record<string, unknown>;
  reason?: string;
  /** 用户亲手点了「拒绝」：这是用户的选择，不是执行失败（过期、取消、断线不算）。 */
  declined?: true;
}

export interface FetchConsentBrokerOptions {
  conversationId: string;
  emit: (message: ServerMessage) => void;
  ledger?: ConsentLedger;
  now?: () => number;
  ttlMs?: number;
}

interface Pending {
  request: FetchConsentRequest;
  /** 归一化后的参数副本：票据绑定它，获准后原样发给扩展。 */
  params: Record<string, unknown>;
  origin: string;
  runId: string;
  controlVersion: number;
  ticketId: string;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (outcome: ConsentOutcome) => void;
  done: boolean;
}

/** 只给侧栏看的值：敏感 header 打码，其余原样。 */
export function maskConsentHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) masked[name] = SENSITIVE_HEADER.test(name.trim()) ? "[已隐藏]" : value;

  return masked;
}

export class FetchConsentBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly ledger: ConsentLedger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly conversationId: string;
  private readonly emit: (message: ServerMessage) => void;
  private context: () => FetchConsentContext = () => ({ runId: null, controlVersion: 0 });
  private closed = false;

  constructor(options: FetchConsentBrokerOptions) {
    this.conversationId = options.conversationId;
    this.emit = options.emit;
    this.ledger = options.ledger ?? new ConsentLedger();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CONSENT_TTL_MS;
  }

  /** 任务/控制权来源（会话管理器提供）。缺省视为没有任务，一律不放行。 */
  bindContext(get: () => FetchConsentContext): void {
    this.context = get;
  }

  /** 还在等用户选择的请求。查询只是读，不延长期限。 */
  list(): FetchConsentRequest[] {
    return [...this.pending.values()].map((entry) => ({ ...entry.request, headers: { ...entry.request.headers } }));
  }

  /** 展示总量上限（条数 + UTF-8 字节数）。超限返回拒绝理由，调用方直接拒绝、不展示也不发。 */
  private displayOverflow(next: FetchConsentRequest): string | null {
    if (this.pending.size >= FETCH_CONSENT_LIST_LIMIT) {
      return `待确认请求已有 ${this.pending.size} 条，请先处理完再发起新请求。操作未执行。`;
    }

    const payload = [...this.pending.values()].map((entry) => entry.request).concat(next);
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;

    if (bytes > FETCH_CONSENT_LIST_BYTES_LIMIT) {
      return `待确认请求的展示内容超过 ${FETCH_CONSENT_LIST_BYTES_LIMIT / 1024} KiB，没有展示也不会发送。请先处理完已有请求。`;
    }

    return null;
  }

  /** 等用户点「允许一次/拒绝」。未获准不会发出任何请求，也不需要 ToolRpc 超时兜底。 */
  async request(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<ConsentOutcome> {
    if (this.closed) return { allowed: false, reason: "会话已关闭，本次请求未执行。" };

    if (opts?.signal?.aborted) return { allowed: false, reason: "本次请求已取消，操作未执行。" };
    let frozen: Record<string, unknown>;
    let origin: string;

    try {
      const normalized = normalizeFetchRequest(params);
      frozen = {
        url: normalized.url,
        method: normalized.method,
        headers: { ...normalized.headers },
      };

      if (normalized.body !== undefined) frozen.body = normalized.body;
      origin = new URL(normalized.url).origin;
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }

    const body = frozen.body;

    if (typeof body === "string" && body.length > FETCH_CONSENT_BODY_LIMIT) {
      return { allowed: false, reason: `请求内容超过 ${FETCH_CONSENT_BODY_LIMIT} 字符，没有展示也不会发送。请缩短后重试。` };
    }

    const context = this.context();

    if (!context.runId) return { allowed: false, reason: "当前没有进行中的任务可以确认这次请求，操作未执行。" };
    const now = this.now();

    const request: FetchConsentRequest = {
      // 真正随机的 UUID：会话重建、进程重启都不会和上一条请求重名，旧 id 也就命中不了新请求。
      id: randomUUID(),
      conversationId: this.conversationId,
      runId: context.runId,
      controlVersion: context.controlVersion,
      url: String(frozen.url),
      method: frozen.method as "GET" | "POST",
      headers: maskConsentHeaders(frozen.headers as Record<string, string>),
      expiresAt: now + this.ttlMs,
    };

    if (typeof body === "string") request.body = body;

    // 展示不出来的请求不进侧栏，也不能靠票据偷偷发出去。
    if (!isFetchConsentRequest(request)) return { allowed: false, reason: "这次请求的内容无法在侧栏完整展示，操作未执行。" };
    // 待确认列表有展示上限：超了明确拒绝，不截断展示再偷发原请求。
    const overflow = this.displayOverflow(request);

    if (overflow) return { allowed: false, reason: overflow };

    const ticket = this.ledger.issue({
      conversationId: this.conversationId,
      runId: context.runId,
      controlVersion: context.controlVersion,
      origin,
      operation: "fetch",
      params: frozen,
      now,
      ttlMs: this.ttlMs,
    });

    return new Promise<ConsentOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(request.id, "expired"), this.ttlMs);
      timer.unref?.();

      const entry: Pending = {
        request,
        params: frozen,
        origin,
        runId: context.runId!,
        controlVersion: context.controlVersion,
        ticketId: ticket.id,
        timer,
        resolve,
        done: false,
      };

      if (opts?.signal) {
        entry.signal = opts.signal;
        entry.onAbort = () => this.settle(request.id, "cancelled", "本次请求已取消，操作未执行。");
        opts.signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      this.pending.set(request.id, entry);
      this.emit({ type: "consent_request", conversationId: this.conversationId, request: { ...request, headers: { ...request.headers } } });
    });
  }

  /**
   * 受信任 UI 的选择。只认已知请求；不许指定参数，也不许造票据。
   * 返回是否命中一个仍在等待的请求。
   */
  decide(requestId: string, allow: boolean): boolean {
    const entry = this.pending.get(requestId);

    if (!entry) return false;

    if (!allow) {
      this.settle(requestId, "rejected");

      return true;
    }

    if (this.now() >= entry.request.expiresAt) {
      this.settle(requestId, "expired");

      return true;
    }

    const context = this.context();

    if (context.runId !== entry.runId || context.controlVersion !== entry.controlVersion) {
      this.settle(requestId, "cancelled", "任务或页面控制已变化，旧请求未执行。");

      return true;
    }

    const consumed = this.ledger.consume({
      id: entry.ticketId,
      conversationId: this.conversationId,
      runId: entry.runId,
      controlVersion: entry.controlVersion,
      origin: entry.origin,
      operation: "fetch",
      params: entry.params,
      now: this.now(),
    });

    if (!consumed.ok) {
      this.settle(requestId, "expired", consumed.reason);

      return true;
    }

    this.settle(requestId, "allowed");

    return true;
  }

  /** 使还在等待的请求失效（接管、改需求、换任务、断线…）。 */
  cancelAll(status: Exclude<ConsentStatus, "allowed"> = "cancelled", message?: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, status, message);
  }

  dispose(): void {
    this.closed = true;
    this.cancelAll("cancelled", "会话已关闭，本次请求未执行。");
  }

  private settle(id: string, status: ConsentStatus, message?: string): void {
    const entry = this.pending.get(id);

    if (!entry || entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);

    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    this.pending.delete(id);
    const text = message ?? STATUS_MESSAGE[status];
    this.emit({ type: "consent_result", conversationId: this.conversationId, requestId: id, status, message: text });
    entry.resolve(status === "allowed" ? { allowed: true, params: entry.params } : status === "rejected" ? { allowed: false, reason: text, declined: true } : { allowed: false, reason: text });
  }
}
