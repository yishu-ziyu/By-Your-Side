import type { Api, AssistantMessage, ImageContent, Model, ModelThinkingLevel, SimpleStreamOptions, TextContent } from "@earendil-works/pi-ai";
import { thinkingProfile } from "../../shared/model-capabilities.js";
import { GOAL_CHECK_FORMAT_SUFFIX } from "../../shared/trace-sanitize.js";
import type { ModelPort } from "./agent-loop.js";

type SideFailureReason = "rejected_params" | "bad_format" | "timeout" | "provider_error" | "cancelled";

const SIDE_FAILURE_TEXT: Readonly<Record<SideFailureReason, string>> = {
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

export type RejectedEfforts = Map<string, Set<ModelThinkingLevel>>;

export interface SideCallHost {
  models: Pick<ModelPort, "completeSimple">;
  rejected?: RejectedEfforts;
  record?: (type: "side_call", data: SideCallRecord) => void;
}

export type SideCallRecord = {
  purpose: string;
  detail?: string;
  model: string;
  effort: ModelThinkingLevel;
  attempts: number;
  outcome: "ok" | "failed";
  reason?: SideFailureReason;
};

export type AttemptOutcome = "accepted" | "bad_format" | "rejected_params" | "provider_error" | "request_failed" | "timeout" | "cancelled";

interface SideCallSpec<T> {
  purpose: string;
  systemPrompt: string;
  content: string | (TextContent | ImageContent)[];
  maxTokens: number;
  effort?: ModelThinkingLevel;
  timeoutMs: number;
  signal?: AbortSignal;
  sessionId?: string;
  headers?: Record<string, string>;
  temperature?: number;
  parse: (text: string) => T;
  retry?: "format" | "any" | "none";
  attemptTimeoutsMs?: readonly number[];
  retryPrompt?: (parseError: Error | undefined) => string;
  onAttempt?: (attempt: AttemptReport) => void;
  onRecord?: (line: SideCallRecord) => void;
  onRequest?: (request: SideCallRequest) => void;
}

interface SideCallRequest { attempt: number; systemPrompt: string; content: SideCallSpec<never>["content"]; maxTokens: number; effort: ModelThinkingLevel }

interface AttemptReport { attempt: number; elapsedMs: number; outcome: AttemptOutcome; parseError?: Error }

const STRICT_JSON = GOAL_CHECK_FORMAT_SUFFIX;

const EMPTY_REPLY_BUDGET_FACTOR = 5;

export function isParamRejection(message: string | undefined): boolean {
  if (!message) return false;

  return /invalid[ _-]?(request[ _-]?)?param/i.test(message)
    || (/\b400\b/.test(message) && /param|thinking|reasoning|effort/i.test(message))
    || /unsupported value\b.*\bnot supported with the\b.*\bmodel/is.test(message);
}

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

export function isJsonObject(value: unknown): value is object {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

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
  let effort = thinkingProfile(model).levels.find(level => level === spec.effort && !host.rejected?.get(modelKey(model))?.has(level)) ?? lowestEffort(model, host.rejected);
  let attempts = 0;
  let retried = false;
  let effortRetried = false;
  let maxTokens = spec.maxTokens;
  let suffix = "";
  let userSuffix = "";
  let lastError: string | undefined;

  const finish = (outcome: "ok" | "failed", reason?: SideFailureReason) => {
    const line: SideCallRecord = { purpose: spec.purpose, model: modelKey(model), effort, attempts, outcome };

    if (reason) line.reason = reason;

    if (outcome === "failed" && lastError) line.detail = lastError.slice(0, 160);
    spec.onRecord?.(line);
    host.record?.("side_call", line);
  };

  const fail = (reason: SideFailureReason, cause?: Error): never => {
    finish("failed", reason);
    throw new SideCallError(reason, { cause });
  };

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

    const transient = (outcome: AttemptOutcome, reason: SideFailureReason): void => {
      report(outcome);

      if (reason === "cancelled" || retry !== "any" || retried || total.aborted) fail(reason);
      retried = true;
      suffix = spec.retryPrompt ? spec.retryPrompt(undefined) : suffix;
    };

    let reply: AssistantMessage;
    const options: SimpleStreamOptions = { maxTokens, signal: attemptSignal };

    if (effort !== "off") options.reasoning = effort;

    if (spec.temperature !== undefined && model.api !== "openai-codex-responses") options.temperature = spec.temperature;

    if (spec.sessionId !== undefined) options.sessionId = spec.sessionId;

    if (spec.headers !== undefined) options.headers = spec.headers;

    try {
      const content = userSuffix ? appendText(spec.content, userSuffix) : spec.content;
      spec.onRequest?.({ attempt: attempts, systemPrompt: spec.systemPrompt + suffix, content, maxTokens, effort });
      reply = await host.models.completeSimple(model, {
        systemPrompt: spec.systemPrompt + suffix,
        messages: [{ role: "user", content, timestamp: Date.now() }],
      }, options);
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
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

      lastError = reply.errorMessage;
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

      if (!spec.retryPrompt) userSuffix = STRICT_JSON;
    }
  }
}
