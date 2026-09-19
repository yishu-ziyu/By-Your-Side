/**
 * 有边界的页面状态重设确认。
 *
 * 只接受宿主自己算出的绑定：本任务（conversationId + runId）、当前要求版本、
 * 当前页面身份（tabId + url 指纹）、对象与那一组参数。真实执行授权不离开进程：
 * 用户的方向选择只解除这一条待确认；等待期间任务、要求、页面或连接一变，
 * 决策时复核立即作废，不放行任何旧授权。
 */
import {createHash, randomUUID} from 'node:crypto';
import {canonicalValue} from './canonical-value.js';
import {CONSENT_TTL_MS} from './consent-ticket.js';
import type {ServerMessage} from '../../shared/protocol.js';
import type {ConsentStatus, WriteConsentRequest} from '../../shared/consent.js';

export interface WriteConfirmationBinding {
  conversationId: string;
  runId: string;
  controlVersion: number;
  /** 目标、要求与页面身份在请求时的快照；决策时必须全部仍然一致。 */
  requirementsHash: string;
  pageHash: string | null;
  /** Exact page instance observed immediately before asking. Never exposed as authority to the model. */
  tabId: number;
  documentId: string;
  tool: string;
  target: string;
  value: string;
  goal: string;
  description: string;
}

export interface WriteConfirmationOutcome {
  allowed: boolean;
  reason?: string;
}

export interface PendingWriteConfirmation extends WriteConfirmationBinding {
  id: string;
  expiresAt: number;
}

interface Pending extends PendingWriteConfirmation {
  done: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: WriteConfirmationOutcome) => void;
}

const STATUS_MESSAGE: Record<ConsentStatus, string> = {
  allowed: '已允许，仅执行这一次。',
  rejected: '已拒绝，本次重新设置未执行。',
  expired: '确认已过期，本次重新设置未执行。',
  cancelled: '任务或页面已变化，本次确认已作废，未执行。',
};

export function requirementsFingerprint(goal: string | null | undefined, requirements: readonly string[] | undefined): string {
  return createHash('sha256').update(canonicalValue([goal ?? '', ...(requirements ?? [])])).digest('hex');
}

export function pageFingerprint(page: {tabId: number; urlHash: string} | null | undefined): string | null {
  return page ? `${page.tabId}:${page.urlHash}` : null;
}

export function writeParamsFingerprint(tool: string, target: string, value: string): string {
  return createHash('sha256').update(canonicalValue({tool, target, value})).digest('hex');
}

export class WriteConfirmBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly emit: (message: ServerMessage) => void, private readonly now: () => number = Date.now) {}

  /** 登记一次待确认；决策结果由 decide/reject/cancelConversation 或超时给出。 */
  request(input: WriteConfirmationBinding & {ttlMs?: number}): Promise<WriteConfirmationOutcome> {
    const id = `write-confirm-${randomUUID()}`;
    const expiresAt = this.now() + (input.ttlMs ?? CONSENT_TTL_MS);
    return new Promise<WriteConfirmationOutcome>(resolve => {
      const timer = setTimeout(() => this.settle(id, {allowed: false, reason: STATUS_MESSAGE.expired}), Math.max(0, expiresAt - this.now()));
      timer.unref?.();
      const pending: Pending = {...input, id, expiresAt, done: false, timer, resolve};
      this.pending.set(id, pending);
      this.emit({type: 'consent_request', conversationId: pending.conversationId, request: this.view(pending)});
    });
  }

  get(id: string): PendingWriteConfirmation | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    const {done: _done, timer: _timer, resolve: _resolve, ...binding} = pending;
    return binding;
  }

  list(conversationId: string): WriteConsentRequest[] {
    return [...this.pending.values()].filter(pending => pending.conversationId === conversationId).map(pending => this.view(pending));
  }

  /** 用户的方向选择；只对仍然在等的这一条生效，重复决策不改变结果。 */
  decide(conversationId: string, requestId: string, allow: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.conversationId !== conversationId) return false;
    this.settle(requestId, allow ? {allowed: true} : {allowed: false, reason: STATUS_MESSAGE.rejected});
    return true;
  }

  /** 任务/要求/页面/连接在等待期间变化：作废并明确告知，未执行。 */
  reject(requestId: string, reason: string): boolean {
    if (!this.pending.has(requestId)) return false;
    this.settle(requestId, {allowed: false, reason});
    return true;
  }

  cancelConversation(conversationId: string, reason = STATUS_MESSAGE.cancelled): void {
    for (const pending of [...this.pending.values()]) if (pending.conversationId === conversationId) this.settle(pending.id, {allowed: false, reason});
  }

  private view(pending: Pending): WriteConsentRequest {
    return {
      kind: 'write',
      id: pending.id,
      conversationId: pending.conversationId,
      runId: pending.runId,
      controlVersion: pending.controlVersion,
      expiresAt: pending.expiresAt,
      goal: pending.goal.slice(0, 300),
      description: pending.description.slice(0, 300),
      tool: pending.tool,
      target: pending.target.slice(0, 500),
      value: pending.value.slice(0, 500),
    };
  }

  private settle(id: string, outcome: WriteConfirmationOutcome): void {
    const pending = this.pending.get(id);
    if (!pending || pending.done) return;
    pending.done = true;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const status: ConsentStatus = outcome.allowed ? 'allowed'
      : outcome.reason === STATUS_MESSAGE.expired ? 'expired'
      : outcome.reason === STATUS_MESSAGE.cancelled ? 'cancelled' : 'rejected';
    this.emit({type: 'consent_result', conversationId: pending.conversationId, requestId: id, status, message: outcome.allowed ? STATUS_MESSAGE.allowed : outcome.reason ?? STATUS_MESSAGE.rejected});
    pending.resolve(outcome);
  }
}
