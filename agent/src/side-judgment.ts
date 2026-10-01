/**
 * 后台判断（目标核对、续接、记忆、找词/翻译意图、目标复核、语音判断、经验提取）的唯一入口。
 *
 * 一次判断：
 * 1. 取该模型允许的最低思考档（能力只从 shared/model-capabilities.ts 读）；本会话被服务端拒绝过的档跳过；
 * 2. 服务端因档位/思考参数拒绝（400 参数错误）时，换下一个允许的档重试一次，并在本会话记住被拒的档；
 * 3. 回复不合要求（不是要求的 JSON、只有思考没有正文）时，带更严格的要求重试一次；只有思考时放大输出额度；
 * 4. 仍失败抛 SideCallError，只带原因类别（不带服务商原文，不会带出凭据）；
 * 5. 每次判断写一行诊断 side_call{purpose, model, effort, attempts, outcome, reason?}。
 */
import type { Api, AssistantMessage, ImageContent, Model, ModelThinkingLevel, SimpleStreamOptions, TextContent } from "@earendil-works/pi-ai";
import { thinkingProfile } from "../../shared/model-capabilities.js";
import type { ModelPort } from "./agent-loop.js";

export type SideFailureReason = "rejected_params" | "bad_format" | "timeout" | "provider_error" | "cancelled";

/** 给用户看的原因类别。 */
export const SIDE_FAILURE_TEXT: Readonly<Record<SideFailureReason, string>> = {
  rejected_params: "模型拒绝了请求参数",
  bad_format: "模型回复格式不对",
  timeout: "超时",
  provider_error: "模型服务出错",
  cancelled: "已取消",
};

export class SideCallError extends Error {
  constructor(readonly reason: SideFailureReason, options?: { cause?: unknown }) {
    super(SIDE_FAILURE_TEXT[reason], options);
    this.name = "SideCallError";
  }
}

/** 本会话里服务端拒绝过的档位，按「服务商/模型」记。 */
export type RejectedEfforts = Map<string, Set<ModelThinkingLevel>>;

export interface SideCallHost {
  models: Pick<ModelPort, "completeSimple">;
  rejected?: RejectedEfforts;
  record?: (type: "side_call", data: SideCallRecord) => void;
}

/** 一行 side_call 诊断（类型字面量：可直接交给诊断记录）。 */
export type SideCallRecord = {
  purpose: string;
  model: string;
  effort: ModelThinkingLevel;
  attempts: number;
  outcome: "ok" | "failed";
  reason?: SideFailureReason;
};

export type AttemptOutcome = "accepted" | "bad_format" | "rejected_params" | "provider_error" | "request_failed" | "timeout" | "cancelled";

export interface SideCallSpec<T> {
  /** 诊断里的用途名，例如 goal_check。 */
  purpose: string;
  systemPrompt: string;
  content: string | (TextContent | ImageContent)[];
  maxTokens: number;
  /** 整次判断（含重试）的总时限。 */
  timeoutMs: number;
  /** 调用方的取消信号；它中止算「已取消」，除非它本身是超时信号。 */
  signal?: AbortSignal;
  sessionId?: string;
  headers?: Record<string, string>;
  temperature?: number;
  /** 从正文得到结果；抛错算格式不对。 */
  parse: (text: string) => T;
  /**
   * 允许的重试（换档重试不计在内）：
   * format = 格式不对时修复重试一次（默认）；any = 格式不对或请求失败/超时都可重试一次；none = 不重试。
   */
  retry?: "format" | "any" | "none";
  /** 每次尝试各自的时限（第 i 次取第 i 个，超出取最后一个）。 */
  attemptTimeoutsMs?: readonly number[];
  /** 重试时追加到系统提示词后的要求；默认要求只回 JSON。参数是上一次的解析错误（请求失败时为 undefined）。 */
  retryPrompt?: (parseError: Error | undefined) => string;
  /** 每次尝试结束时回调（语音的逐次诊断用）。 */
  onAttempt?: (attempt: AttemptReport) => void;
}

export interface AttemptReport { attempt: number; elapsedMs: number; outcome: AttemptOutcome; parseError?: Error }

const STRICT_JSON = "\n\nYour previous reply could not be used. Reply with ONLY the JSON object described above: no other text, no markdown fences, no questions.";

/** 只有思考没有正文时，下一次的输出额度放大到这个倍数。 */
const EMPTY_REPLY_BUDGET_FACTOR = 5;

/** 服务端因请求参数（思考档位等）拒绝：400 且提到参数/思考/档位。 */
export function isParamRejection(message: string | undefined): boolean {
  if (!message) return false;

  return /invalid[ _-]?(request[ _-]?)?param/i.test(message) || (/\b400\b/.test(message) && /param|thinking|reasoning|effort/i.test(message));
}

/**
 * 去掉代码块围栏后解析 JSON；前后夹了说明文字时取第一个 { 到最后一个 } 之间。
 * 结果必须通过 guard，否则抛错（算格式不对）。
 */
export function parseJsonReply<T>(text: string, guard: (value: unknown) => value is T): T {
  const raw = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");

    if (start < 0 || end <= start) throw error;
    value = JSON.parse(raw.slice(start, end + 1));
  }

  if (!guard(value)) throw new Error("reply does not have the required shape");

  return value;
}

/** 任意 JSON 对象（不含数组）。 */
export function isJsonObject(value: unknown): value is object {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

/** 该模型在本会话还允许的最低档（后台判断、划词问答这类短调用都用它）。 */
export function lowestEffort(model: Model<Api>, rejected?: RejectedEfforts): ModelThinkingLevel {
  const { levels } = thinkingProfile(model);
  const skip = rejected?.get(modelKey(model));

  return levels.find(level => !skip?.has(level)) ?? levels.at(-1)!;
}

function nextEffort(model: Model<Api>, current: ModelThinkingLevel, rejected?: RejectedEfforts): ModelThinkingLevel | undefined {
  const { levels } = thinkingProfile(model);
  const skip = rejected?.get(modelKey(model));

  return levels.slice(levels.indexOf(current) + 1).find(level => !skip?.has(level));
}

const textOf = (reply: Pick<AssistantMessage, "content">) => reply.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("").trim();

function appendText(content: SideCallSpec<never>["content"], extra: string): SideCallSpec<never>["content"] {
  return Array.isArray(content) ? [...content, { type: "text", text: extra.trim() }] : content + extra;
}

export async function sideJudgment<T>(host: SideCallHost, model: Model<Api>, spec: SideCallSpec<T>): Promise<T> {
  const budget = AbortSignal.timeout(spec.timeoutMs);
  const total = spec.signal ? AbortSignal.any([spec.signal, budget]) : budget;
  const retry = spec.retry ?? "format";
  let effort = lowestEffort(model, host.rejected);
  let attempts = 0;
  let retried = false;
  let effortRetried = false;
  let maxTokens = spec.maxTokens;
  let suffix = "";
  let userSuffix = "";

  const finish = (outcome: "ok" | "failed", reason?: SideFailureReason) => {
    const line: SideCallRecord = { purpose: spec.purpose, model: modelKey(model), effort, attempts, outcome };

    if (reason) line.reason = reason;
    host.record?.("side_call", line);
  };

  const fail = (reason: SideFailureReason, cause?: Error): never => {
    finish("failed", reason);
    throw new SideCallError(reason, { cause });
  };

  /** 调用方取消算「已取消」（它本身是超时信号时算超时）；我们自己的时限算超时。 */
  const abortReason = (attemptSignal: AbortSignal): SideFailureReason | null => {
    if (spec.signal?.aborted) return spec.signal.reason instanceof DOMException && spec.signal.reason.name === "TimeoutError" ? "timeout" : "cancelled";

    return total.aborted || attemptSignal.aborted ? "timeout" : null;
  };

  for (;;) {
    const attemptTimeout = spec.attemptTimeoutsMs?.[Math.min(attempts, spec.attemptTimeoutsMs.length - 1)];
    const attemptSignal = attemptTimeout ? AbortSignal.any([total, AbortSignal.timeout(attemptTimeout)]) : total;
    const startedAt = Date.now();
    attempts += 1;

    const report = (outcome: AttemptOutcome, parseError?: Error) => {
      const attempt: AttemptReport = { attempt: attempts, elapsedMs: Date.now() - startedAt, outcome };

      if (parseError) attempt.parseError = parseError;
      spec.onAttempt?.(attempt);
    };

    /** 请求没成功：能按 any 重试就重试，否则按原因失败。 */
    const transient = (outcome: AttemptOutcome, reason: SideFailureReason): void => {
      report(outcome);

      if (reason === "cancelled" || retry !== "any" || retried || total.aborted) fail(reason);
      retried = true;
      suffix = spec.retryPrompt ? spec.retryPrompt(undefined) : suffix;
    };

    let reply: AssistantMessage;
    const options: SimpleStreamOptions = { maxTokens, signal: attemptSignal };

    if (effort !== "off") options.reasoning = effort;

    if (spec.temperature !== undefined) options.temperature = spec.temperature;

    if (spec.sessionId !== undefined) options.sessionId = spec.sessionId;

    if (spec.headers !== undefined) options.headers = spec.headers;

    try {
      reply = await host.models.completeSimple(model, {
        systemPrompt: spec.systemPrompt + suffix,
        messages: [{ role: "user", content: userSuffix ? appendText(spec.content, userSuffix) : spec.content, timestamp: Date.now() }],
      }, options);
    } catch {
      const aborted = abortReason(attemptSignal);
      transient(aborted ?? "request_failed", aborted ?? "provider_error");
      continue;
    }

    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      const aborted = abortReason(attemptSignal);

      if (aborted) {
        transient(aborted, aborted);
        continue;
      }

      if (isParamRejection(reply.errorMessage)) {
        report("rejected_params");
        const rejectedSet = host.rejected?.get(modelKey(model)) ?? new Set<ModelThinkingLevel>();
        rejectedSet.add(effort);
        host.rejected?.set(modelKey(model), rejectedSet);
        const next = effortRetried ? undefined : nextEffort(model, effort, host.rejected);

        if (!next || total.aborted) return fail("rejected_params");
        effortRetried = true;
        effort = next;
        continue;
      }

      transient("provider_error", "provider_error");
      continue;
    }

    const text = textOf(reply);

    try {
      if (!text) throw new Error("empty reply");
      const value = spec.parse(text);
      report("accepted");
      finish("ok");

      return value;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      report("bad_format", error);

      if (retry === "none" || retried || total.aborted) fail("bad_format", error);
      retried = true;

      if (!text) maxTokens = spec.maxTokens * EMPTY_REPLY_BUDGET_FACTOR;
      suffix = spec.retryPrompt ? spec.retryPrompt(error) : STRICT_JSON;

      // 有的模型不太听系统提示词（10-01 阶跃实测），默认要求在用户消息末尾再说一次。
      if (!spec.retryPrompt) userSuffix = STRICT_JSON;
    }
  }
}
