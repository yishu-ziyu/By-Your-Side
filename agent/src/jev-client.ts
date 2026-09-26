import { createHash } from 'node:crypto';
import { utf8ByteLength } from '../../shared/bytes.js';
import { jevFetch, type JevResponse } from './jev-transport.js';
import { readTypeSafeKey } from './typesafe-auth.js';

/** Pinned model for browser questions; a model change needs its own comparison run. */
export const JEV_MODEL = 'jev-1.13.0';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Whole-request budget across both attempts; the loop's pacing assumes it. */
const REQUEST_BUDGET_MS = 3000;

export const JEV_PAYLOAD_BYTES = 64000;

export type JevAnswer = { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number };

export type JevAnswers = Record<string, JevAnswer>;

export type JevRequest = { state: Record<string, unknown>; questions: Record<string, unknown> };

export type JevTrace =
  | { phase: 'request'; body: string; bytes: number; sha256: string; questions: number }
  | { phase: 'retry'; attempt: number; error: string; elapsedMs: number }
  | { phase: 'response'; data: unknown; status: number; requestId?: string; elapsedMs: number; attempts: number }
  | { phase: 'error'; message: string; elapsedMs: number; attempts: number; connection: boolean };

export interface JevCallOptions {
  /** Diagnostics only: full traces are for non-sensitive fixture inputs. */
  onTrace?(event: JevTrace): void;
  /** Tests point the real transport at a local server. */
  endpoint?: string;
}

export type AskJev = (request: JevRequest, signal: AbortSignal, options?: JevCallOptions) => Promise<JevAnswers>;

const CONNECTION_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO']);

/**
 * Failure to open or keep the connection, before any response arrived: TCP, TLS or a reused socket the
 * other side closed. Timeouts after the request went out, HTTP statuses and bad bodies are not.
 */
export function isConnectionFailure(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;

    if (typeof code === 'string' && (CONNECTION_CODES.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_'))) return true;
  }

  return false;
}

const describe = (error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const message = error instanceof Error ? error.message : String(error);

  return cause ? `${message} (${cause.code ?? cause.message ?? 'cause'})` : message;
};

/**
 * One bounded Jev judgment. Read-only, so a connection-level failure is retried once; nothing else is.
 * The key never enters traces, and this adapter cannot act on the page.
 */
export const askJev: AskJev = async (request, signal, options) => {
  const emit = (event: JevTrace) => {
    if (!options?.onTrace) return;

    try { options.onTrace(structuredClone(event)); } catch { /* diagnostics cannot change execution */ }
  };

  const key = readTypeSafeKey();

  if (!key) throw new Error('Jev 凭据不可用');
  const body = JSON.stringify({ model: JEV_MODEL, ...request });
  const bytes = utf8ByteLength(body);

  if (bytes > JEV_PAYLOAD_BYTES) throw new Error('候选资料超过当前决策预算，交回任务模型');
  emit({ phase: 'request', body, bytes, sha256: createHash('sha256').update(body).digest('hex'), questions: Object.keys(request.questions).length });
  const started = Date.now();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_BUDGET_MS)]);

  for (let attempt = 1; ; attempt++) {
    let response: JevResponse;

    try {
      response = await jevFetch(options?.endpoint ?? JEV_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body, signal: deadline });
    } catch (error) {
      const connection = isConnectionFailure(error);

      if (connection && attempt === 1 && !deadline.aborted) {
        emit({ phase: 'retry', attempt, error: describe(error), elapsedMs: Date.now() - started });
        continue;
      }

      emit({ phase: 'error', message: describe(error), elapsedMs: Date.now() - started, attempts: attempt, connection });
      throw error;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      emit({ phase: 'error', message: `Jev HTTP ${response.status}`, elapsedMs: Date.now() - started, attempts: attempt, connection: false });
      throw new Error(`Jev HTTP ${response.status}`);
    }

    const data = await response.json() as { answers?: JevAnswers };
    emit({ phase: 'response', data, status: response.status, requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined, elapsedMs: Date.now() - started, attempts: attempt });

    return data.answers ?? {};
  }
};
