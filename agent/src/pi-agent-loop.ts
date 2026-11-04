import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { firstEventTimeout, hedgeAfter } from "../../shared/model-capabilities.js";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type ModelThinkingLevel, type StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelPort, ModelQueueOptions } from "./agent-loop.js";
import type { ModelRequestObservation } from "./model-request-trace.js";
import type { PiSessionPersistence } from "./pi-session-persistence.js";
import { MODEL_FIRST_EVENT_MS, MODEL_HEDGE_MS, MODEL_STALL_AFTER_START_MS, MODEL_STALL_MID_STREAM_MS } from "../../shared/timeouts.js";

export interface PiAgentLoopOptions {
  models: ModelPort;
  model: Model<Api>;
  tools: readonly ToolDefinition[];
  systemPrompt: string;
  appendPrompt: () => string[];
  cwd: string;
  extensionFactories: readonly ExtensionFactory[];
  sessionId?: string;
  persistence?: PiSessionPersistence;
  messages?: AgentMessage[];
  retry?: { maxRetries: number; baseDelayMs: number };
  firstEventTimeoutMs?: number;
  onHookError?: (event: string, message: string) => void;
  onModelRequest?: (request: ModelRequestObservation) => void;
  onModelResponse?: (status: number) => void;
  onModelHedge?: (record: ModelHedgeRecord) => void;
  effort?: (model: Model<Api>) => ModelThinkingLevel;
}

export const ELIDE_MIN_CHARS = 1000;

export const PAGE_OBSERVATION_MARK = "[FRESH PAGE OBSERVATION";

const MODEL_FIRST_EVENT_TIMEOUT_MS = MODEL_FIRST_EVENT_MS;

const RUNAWAY_TOOL_ARGS_BLANKS = 512;

export function streamThrough(models: ModelPort, observe: (context: Parameters<StreamFn>[1]) => void, observeResponse: ((status: number) => void) | undefined, effort: ((model: Model<Api>) => ModelThinkingLevel) | undefined, firstEventTimeoutMs: number | undefined, onCut: (cut: () => boolean, live: boolean) => void, onHedge: ((record: ModelHedgeRecord) => void) | undefined): StreamFn {
  // SAFETY: ModelPort.streamSimple 与 Agent 期望的 streamFn 同签名；两边是同一 pi-ai 版本的类型。
  return ((model, context, streamOptions) => {
    observe(context);
    const level = effort?.(model);
    const options = level === undefined ? streamOptions : { ...streamOptions, reasoning: level === "off" ? undefined : level };

    const withAccepted = (accepted: () => void): StreamOptions["onProviderStreamEvent"] => async (event, eventModel) => {
      accepted();
      await options?.onProviderStreamEvent?.(event, eventModel);
    };

    const withResponse = (observed: boolean): StreamOptions["onResponse"] => async (response, responseModel) => {
      if (observed) try { observeResponse?.(response.status); } catch {  }
      await options?.onResponse?.(response, responseModel);
    };

    // SAFETY: 同上，参数原样转交；对冲那份与原请求的 context 和参数完全相同。
    return withFirstEventDeadline(model, options?.signal, firstEventTimeoutMs ?? firstEventTimeout(model) ?? MODEL_FIRST_EVENT_TIMEOUT_MS, hedgeAfter(model) ?? MODEL_HEDGE_MS, (signal, accepted, hedge, onQueued) => models.streamSimple(model as never, context as never, { ...options, signal, onProviderStreamEvent: withAccepted(accepted), onResponse: withResponse(!hedge), ...(onQueued ? { onQueued } : {}) } as never), onCut, onHedge);
  }) as StreamFn;
}

export type ModelHedgeRecord =
  | { type: "model_hedge"; model: string; hedgeMs: number }
  | { type: "model_hedge_winner"; model: string; winner: "first" | "hedge" | "none"; firstEventMs: number | null; hedgeError?: string };

function withFirstEventDeadline(model: Model<Api>, outer: AbortSignal | undefined, timeoutMs: number, hedgeMs: number, start: (signal: AbortSignal, onProviderStreamEvent: () => void, hedge: boolean, onQueued?: ModelQueueOptions["onQueued"]) => AssistantMessageEventStream, onCut?: (cut: () => boolean, live: boolean) => void, onHedge?: (record: ModelHedgeRecord) => void): AssistantMessageEventStream {
  type Attempt = { controller: AbortController; started: boolean; live: boolean; hedge: boolean; held: AssistantMessageEvent[] };

  const name = `${model.provider}/${model.id}`;
  let sentAt = Date.now();
  const attempts: Attempt[] = [];
  const out = createAssistantMessageEventStream();
  let winner: Attempt | null = null;
  let wonAt: number | null = null;
  let hedgeError: string | undefined;
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const acceptedMessage = `first response timeout: ${name} accepted the request but sent nothing within ${Math.round(MODEL_STALL_AFTER_START_MS / 1000)} s`;
  let deadline = { at: sentAt + timeoutMs, message: `first response timeout: ${name} sent nothing within ${Math.round(timeoutMs / 1000)} s` };
  let hedgeDeadline: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let finished = false;
  let partial: AssistantMessage | null = null;
  const blanks = new Map<number, number>();

  const cancel = () => { for (const attempt of attempts) attempt.controller.abort(); };

  if (!outer?.aborted) outer?.addEventListener("abort", cancel, { once: true });

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(hedgeTimer);
    clearTimeout(timer);
    clearTimeout(stallTimer);
    outer?.removeEventListener("abort", cancel);
    onCut?.(cutText, false);
    out.end();

    if (attempts.length > 1) {
      try {
        onHedge?.({ type: "model_hedge_winner", model: name, winner: winner ? (winner.hedge ? "hedge" : "first") : "none", firstEventMs: wonAt === null ? null : wonAt - sentAt, ...(hedgeError === undefined ? {} : { hedgeError }) });
      } catch {  }
    }
  };

  const fail = (errorMessage: string) => {
    if (closed) return;
    closed = true;
    out.push({ type: "error", reason: "error", error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage, timestamp: Date.now(),
    } });
    cancel();
    finish();
  };

  const othersLive = (attempt: Attempt) => attempts.some(other => other !== attempt && other.live);

  const drop = (attempt: Attempt) => {
    attempt.live = false;
    attempt.controller.abort();
  };

  const arm = () => {
    const { at, message } = hedgeDeadline !== null && hedgeDeadline > deadline.at ? { at: hedgeDeadline, message: acceptedMessage } : deadline;
    clearTimeout(timer);
    timer = setTimeout(() => fail(message), Math.max(0, at - Date.now()));
  };

  /** WHY: 只按规范化后的内容进展续期；供应商的心跳或空 delta 不能证明回答还在推进。 */
  const alive = () => {
    if (closed || finished) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => fail(`stream idle timeout: ${name} sent nothing for ${MODEL_STALL_MID_STREAM_MS / 1000} s mid-response`), MODEL_STALL_MID_STREAM_MS);
  };

  const win = (attempt: Attempt) => {
    winner = attempt;
    wonAt = Date.now();
    clearTimeout(hedgeTimer);
    clearTimeout(timer);

    for (const other of attempts) if (other !== attempt) drop(other);
  };

  const launch = (hedge: boolean, onQueued?: ModelQueueOptions["onQueued"]) => {
    const attempt: Attempt = { controller: new AbortController(), started: false, live: true, hedge, held: [] };

    if (outer?.aborted) attempt.controller.abort();
    attempts.push(attempt);

    const accepted = () => {
      if (attempt.started || winner || closed) return;
      attempt.started = true;

      if (hedge) hedgeDeadline = Date.now() + MODEL_STALL_AFTER_START_MS;
      else deadline = { at: Date.now() + Math.min(timeoutMs, MODEL_STALL_AFTER_START_MS), message: acceptedMessage };
      arm();
    };

    let source: AssistantMessageEventStream;

    try { source = start(attempt.controller.signal, accepted, hedge, onQueued); } catch (error) {
      attempt.live = false;

      if (!hedge) {
        clearTimeout(timer);
        outer?.removeEventListener("abort", cancel);
        throw error;
      }

      hedgeError = errorText(error);

      return;
    }

    void consume(attempt, source);
  };

  const cutText = (): boolean => {
    if (closed || partial?.content.some(part => part.type === "toolCall")) return false;
    const written = !!partial?.content.some(part => part.type === "text" && part.text.trim());
    closed = true;
    // WHY: 深拷贝：取消请求后供应商还会就地改它的流式对象，收下的这条消息不能跟着变。
    const message: AssistantMessage = written ? { ...structuredClone(partial!), stopReason: "stop" } : {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: partial ? structuredClone(partial.usage) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    out.push({ type: "done", reason: "stop", message });
    cancel();
    finish();

    return true;
  };

  const consume = async (attempt: Attempt, source: AssistantMessageEventStream) => {
    try {
      for await (const event of source) {
        if (closed || (winner !== attempt && !attempt.live)) break;

        if (winner !== attempt) {
          if (event.type === "start") {
            attempt.held.push(event);
            continue;
          }

          if (event.type === "error" && othersLive(attempt)) {
            if (attempt.hedge) hedgeError = event.error.errorMessage;
            drop(attempt);
            break;
          }

          win(attempt);

          for (const held of attempt.held.splice(0)) out.push(held);
        }

        if ("partial" in event) partial = event.partial;
        if (!("delta" in event) || event.delta.length > 0) alive();

        if (event.type === "toolcall_delta") {
          const run = /^\s*$/.test(event.delta) ? (blanks.get(event.contentIndex) ?? 0) + event.delta.length : event.delta.length - event.delta.trimEnd().length;
          blanks.set(event.contentIndex, run);

          if (run >= RUNAWAY_TOOL_ARGS_BLANKS) {
            fail(`runaway tool call: ${name} kept writing blank tool arguments`);
            break;
          }
        }

        out.push(event);
      }
    } catch (error) {
      if (winner === attempt || (!winner && !othersLive(attempt))) fail(errorText(error));
      else if (attempt.hedge && attempt.live) hedgeError = errorText(error);
    } finally {
      if (attempt.hedge && !winner && hedgeDeadline !== null && !closed) {
        hedgeDeadline = null;
        arm();
      }

      if (winner === attempt) finish();
      else if (attempt.live) {
        attempt.live = false;

        if (!winner && !othersLive(attempt)) {
          for (const held of attempt.held.splice(0)) out.push(held);
          finish();
        }
      }
    }
  };

  const begin = () => {
    if (closed || finished) return;
    sentAt = Date.now();
    deadline = { at: sentAt + timeoutMs, message: deadline.message };
    arm();

    hedgeTimer = hedgeMs > 0 ? setTimeout(() => {
      if (winner || closed || outer?.aborted || !attempts[0]!.live || attempts[0]!.started) return;

      try { onHedge?.({ type: "model_hedge", model: name, hedgeMs }); } catch {  }
      launch(true);
    }, hedgeMs) : undefined;
  };

  const queue: { sent?: Promise<void> } = {};
  launch(false, sent => { queue.sent = sent; });
  onCut?.(cutText, true);

  if (queue.sent) void queue.sent.then(begin);
  else begin();

  return out;
}
