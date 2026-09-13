/**
 * 授权票据：只由受信任 UI / 测试宿主铸造。
 * 页面文字、模型工具返回、旧会话的「好的」都不能发票据。
 */
import { createHash } from "node:crypto";

export const CONSENT_TTL_MS = 60_000;

export interface ConsentTicket {
  id: string;
  conversationId: string;
  runId: string;
  controlVersion: number;
  origin: string;
  operation: string;
  paramHash: string;
  expiresAt: number;
  consumed: boolean;
}

export interface ConsentIssue {
  conversationId: string;
  runId: string;
  controlVersion: number;
  origin: string;
  operation: string;
  params: Record<string, unknown>;
  now?: number;
  ttlMs?: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashConsentParams(params: Record<string, unknown>): string {
  const { consent: _consent, ...rest } = params;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

export class ConsentLedger {
  private readonly tickets = new Map<string, ConsentTicket>();
  private seq = 0;

  issue(input: ConsentIssue): ConsentTicket {
    const now = input.now ?? Date.now();
    const ticket: ConsentTicket = {
      id: `consent-${++this.seq}-${now.toString(36)}`,
      conversationId: input.conversationId,
      runId: input.runId,
      controlVersion: input.controlVersion,
      origin: input.origin,
      operation: input.operation,
      paramHash: hashConsentParams(input.params),
      expiresAt: now + (input.ttlMs ?? CONSENT_TTL_MS),
      consumed: false,
    };
    this.tickets.set(ticket.id, ticket);
    return { ...ticket };
  }

  consume(opts: {
    id: string;
    conversationId: string;
    runId: string;
    controlVersion: number;
    origin: string;
    operation: string;
    params: Record<string, unknown>;
    now?: number;
  }): { ok: true; ticket: ConsentTicket } | { ok: false; reason: string } {
    const ticket = this.tickets.get(opts.id);
    if (!ticket) return { ok: false, reason: "没有有效授权，操作未执行。" };
    const now = opts.now ?? Date.now();
    if (ticket.consumed) return { ok: false, reason: "授权已使用，操作未执行。" };
    if (now > ticket.expiresAt) return { ok: false, reason: "授权已过期，请重新确认。操作未执行。" };
    if (ticket.conversationId !== opts.conversationId || ticket.runId !== opts.runId) {
      return { ok: false, reason: "授权不属于当前任务，操作未执行。" };
    }
    if (ticket.controlVersion !== opts.controlVersion) {
      return { ok: false, reason: "页面控制权已变化，旧授权失效。操作未执行。" };
    }
    if (ticket.origin !== opts.origin || ticket.operation !== opts.operation) {
      return { ok: false, reason: "授权范围不匹配，操作未执行。" };
    }
    if (ticket.paramHash !== hashConsentParams(opts.params)) {
      return { ok: false, reason: "请求参数已变化，旧授权失效。操作未执行。" };
    }
    ticket.consumed = true;
    return { ok: true, ticket: { ...ticket } };
  }
}

export const CONSENT_REQUIRED_ERROR = "这个请求会改服务端状态，需要你在侧栏确认后才能发送。操作未执行。";
