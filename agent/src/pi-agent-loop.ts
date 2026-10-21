/**
 * 模型流式调用的时间上限、对冲请求（Dean & Barroso《The Tail at Scale》）与失控工具参数截断。
 * 供 durable-loop.ts 的持久循环统一包裹底层 ModelPort。
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { firstEventTimeout, hedgeAfter } from "../../shared/model-capabilities.js";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Model, type ModelThinkingLevel, type StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelPort, ModelQueueOptions } from "./agent-loop.js";
import type { ModelRequestObservation } from "./model-request-trace.js";
import type { PiSessionPersistence } from "./pi-session-persistence.js";

export interface PiAgentLoopOptions {
  models: ModelPort;
  model: Model<Api>;
  tools: readonly ToolDefinition[];
  systemPrompt: string;
  /** 模式附加段；每次重建系统提示词时重新求值（对应 Pi 的 appendSystemPromptOverride）。 */
  appendPrompt: () => string[];
  cwd: string;
  extensionFactories: readonly ExtensionFactory[];
  sessionId?: string;
  persistence?: PiSessionPersistence;
  messages?: AgentMessage[];
  retry?: { maxRetries: number; baseDelayMs: number };
  /** 模型多久不出第一个事件就取消这次调用、按可重试错误处理；默认取能力表登记值，再退到 MODEL_FIRST_EVENT_TIMEOUT_MS。 */
  firstEventTimeoutMs?: number;
  onHookError?: (event: string, message: string) => void;
  /** 每次模型调用前观察实际请求（诊断记录用）；只读，抛错被吞掉。 */
  onModelRequest?: (request: ModelRequestObservation) => void;
  /** 模型调用的响应头到了（服务商适配层报告时才有）；只读，抛错被吞掉。 */
  onModelResponse?: (status: number) => void;
  /** 发出对冲请求、以及有对冲的调用结束时各报一次（诊断记录用）；只读，抛错被吞掉。 */
  onModelHedge?: (record: ModelHedgeRecord) => void;
  /** 每次模型调用前取这次的思考档（见 main-effort.ts）；"off" 表示不发思考参数。不给时沿用 Agent 的设置。 */
  effort?: (model: Model<Api>) => ModelThinkingLevel;
}

/** 读页结果或页面快照短于这个字数就不删：省下的不够，还丢了信息。 */
export const ELIDE_MIN_CHARS = 1000;

/** 用户消息里页面快照的开头（session.ts 的 freshPageObservationText）；超窗口时从这里删到消息末尾。 */
export const PAGE_OBSERVATION_MARK = "[FRESH PAGE OBSERVATION";

/** 模型调用发出后多久还没有第一个事件（文字、思考、工具调用或结束）就算挂起。 */
const MODEL_FIRST_EVENT_TIMEOUT_MS = 15_000;

/** 服务端已发出原始事件（如 response.created）后，等第一个内容事件的上限。排队发生在这之前，不受这条限制。 */
const MODEL_STALL_AFTER_START_MS = 10_000;

/** 流已开始出内容后，这么久一个事件都没有就算断流：取消，按可重试错误重来。正常流里思考分段之间也只停几秒。 */
const MODEL_STALL_MID_STREAM_MS = 30_000;

/** 能力表没有登记 hedgeMs 的模型：发出后这么久还没有第一个事件（且未受理），就再发一份相同的请求。 */
const MODEL_HEDGE_MS = 8_000;

/** 工具调用参数里连续这么多空白，就算模型写跑了：取消这次请求，按可重试错误重来。 */
const RUNAWAY_TOOL_ARGS_BLANKS = 512;

export function streamThrough(models: ModelPort, observe: (context: Parameters<StreamFn>[1]) => void, observeResponse: ((status: number) => void) | undefined, effort: ((model: Model<Api>) => ModelThinkingLevel) | undefined, firstEventTimeoutMs: number | undefined, onCut: (cut: () => boolean, live: boolean) => void, onHedge: ((record: ModelHedgeRecord) => void) | undefined): StreamFn {
  // SAFETY: ModelPort.streamSimple 与 Agent 期望的 streamFn 同签名；两边是同一 pi-ai 版本的类型。
  return ((model, context, streamOptions) => {
    observe(context);
    // 档位按每次调用取：同一轮里升档信号出现后，下一次调用就用新档。
    const level = effort?.(model);
    const options = level === undefined ? streamOptions : { ...streamOptions, reasoning: level === "off" ? undefined : level };

    // 服务端原始事件先告诉超时计时「已受理」，再转给调用方原有的钩子。
    const withAccepted = (accepted: () => void): StreamOptions["onProviderStreamEvent"] => async (event, eventModel) => {
      accepted();
      await options?.onProviderStreamEvent?.(event, eventModel);
    };

    // 响应头的诊断只记原请求，sinceRequestMs 才对得上那条 model_request；对冲那份的结局记在 model_hedge_winner 里。
    const withResponse = (observed: boolean): StreamOptions["onResponse"] => async (response, responseModel) => {
      if (observed) try { observeResponse?.(response.status); } catch { /* Diagnostics only. */ }
      await options?.onResponse?.(response, responseModel);
    };

    // SAFETY: 同上，参数原样转交；对冲那份与原请求的 context 和参数完全相同。
    return withFirstEventDeadline(model, options?.signal, firstEventTimeoutMs ?? firstEventTimeout(model) ?? MODEL_FIRST_EVENT_TIMEOUT_MS, hedgeAfter(model) ?? MODEL_HEDGE_MS, (signal, accepted, hedge, onQueued) => models.streamSimple(model as never, context as never, { ...options, signal, onProviderStreamEvent: withAccepted(accepted), onResponse: withResponse(!hedge), ...(onQueued ? { onQueued } : {}) } as never), onCut, onHedge);
  }) as StreamFn;
}

/** 对冲请求的诊断记录：发出对冲时一条，这次调用结束时一条（哪份胜出、胜出时离发出原请求多久）。 */
export type ModelHedgeRecord =
  | { type: "model_hedge"; model: string; hedgeMs: number }
  | { type: "model_hedge_winner"; model: string; winner: "first" | "hedge" | "none"; firstEventMs: number | null; hedgeError?: string };

/**
 * 第一个事件（start 只表示连上，不算）迟迟不来：取消这次请求，交出一条可重试的超时错误，写明是哪个模型。
 * 服务端一旦发出原始事件（已受理），剩余等待缩短到 MODEL_STALL_AFTER_START_MS：受理后迟迟不出内容就是挂住了。
 * 到 hedgeMs 原请求既没有第一个事件、也没被受理，就再发一份相同的请求，原请求不取消（对冲请求，Dean & Barroso《The Tail at Scale》）：
 * 先出第一个事件的那份胜出，另一份立即取消、晚到的事件丢弃。整次调用在原请求的期限（上面两条）报超时错误；
 * 只有对冲那份已被受理（服务还活着）时，才放宽到它受理后再等 MODEL_STALL_AFTER_START_MS，取两者中较晚的；
 * 它随后出错被丢掉，就退回原请求的期限。原请求已受理时不对冲：受理后的短等待已经管住挂起，再发一份只会给长前缀、慢思考多付一份。
 * 供应商整段挂住时两份都不会被受理，用户等的时间和没有对冲时一样。
 * 某份在出第一个事件前就出错（并发上限、429 等），而另一份还在等：只丢掉出错的这份，不让整次调用失败。
 * 用户取消照常走原来的 aborted 结局。
 * 服务商有并发上限时原请求可能先在扩展里排队（见 ModelQueueOptions.onQueued）：两项计时都从它真正发出时算起，排队再久也不算挂起。
 */
function withFirstEventDeadline(model: Model<Api>, outer: AbortSignal | undefined, timeoutMs: number, hedgeMs: number, start: (signal: AbortSignal, onProviderStreamEvent: () => void, hedge: boolean, onQueued?: ModelQueueOptions["onQueued"]) => AssistantMessageEventStream, onCut?: (cut: () => boolean, live: boolean) => void, onHedge?: (record: ModelHedgeRecord) => void): AssistantMessageEventStream {
  /** live：还在等它出第一个事件；超时、出错、输给另一份或流结束后为 false。held：胜出前收到的 start 事件，胜出时补发。 */
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
  /** 原请求的期限；原请求被受理后缩短。 */
  let deadline = { at: sentAt + timeoutMs, message: `first response timeout: ${name} sent nothing within ${Math.round(timeoutMs / 1000)} s` };
  /** 对冲那份被受理后的期限；没被受理为 null。 */
  let hedgeDeadline: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** 已交出结局（超时错误或截断），之后两份的事件都丢弃。 */
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
      } catch { /* Diagnostics only. */ }
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

  /** 胜出那份每来一个事件（含服务端原始事件）就重新计时。 */
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

    // 服务端第一个原始事件到来时，若内容还没来：原请求改成受理后的短等待，对冲那份把期限放宽到受理后的短等待。
    const accepted = () => {
      if (winner === attempt) alive();

      if (attempt.started || winner || closed) return;
      attempt.started = true;

      if (hedge) hedgeDeadline = Date.now() + MODEL_STALL_AFTER_START_MS;
      else deadline = { at: Date.now() + Math.min(timeoutMs, MODEL_STALL_AFTER_START_MS), message: acceptedMessage };
      arm();
    };

    let source: AssistantMessageEventStream;

    try { source = start(attempt.controller.signal, accepted, hedge, onQueued); } catch (error) {
      attempt.live = false;

      // 原请求同步抛出的错误（如缺 key）照旧交给 Agent 处理；对冲那份只丢掉。
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

  // 用户改方向：正在写的正文按「写完了」收下（stopReason stop），旧请求取消、晚到的字丢弃；
  // 循环随即读排队的插话，同一轮里重写。还没写出正文和工具调用时（多半在思考），丢掉整条，收下空回复：
  // 否则要等它按旧方向写完、旧步骤被挡下才轮到插话，多等 3–5 秒。没写完的思考不留，供应商不认残缺的思考。
  // 已开始写工具调用时不截断。
  const cutText = (): boolean => {
    if (closed || partial?.content.some(part => part.type === "toolCall")) return false;
    const written = !!partial?.content.some(part => part.type === "text" && part.text.trim());
    closed = true;
    // 深拷贝：取消请求后供应商还会就地改它的流式对象，收下的这条消息不能跟着变。
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
        alive();

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
      // 已受理的对冲那份没胜出就结束了：它不再证明服务活着，放弃时间退回原请求的期限。
      if (attempt.hedge && !winner && hedgeDeadline !== null && !closed) {
        hedgeDeadline = null;
        arm();
      }

      if (winner === attempt) finish();
      else if (attempt.live) {
        attempt.live = false;

        // 流没出内容就结束、又没有别的份在等：照原来那样收尾。
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

      try { onHedge?.({ type: "model_hedge", model: name, hedgeMs }); } catch { /* Diagnostics only. */ }
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
