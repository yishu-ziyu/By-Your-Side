/**
 * docs/evals/20261004-model-failover.md 规则 F1–F3。走真实会话（扩展里的循环 + 脚本模型），时间用假时钟量。
 * 复现 2026-10-01 日常记录：主模型 step-5-preview 挂起或报错，「你好」等了 170 s 才有回答。
 *
 * 先列出会出错的方式：
 * W1 主模型连上后一直不出第一个事件，会话就一直等（日常 30 s 才报 Connection error，再重试）。
 * W2 配了备用模型，主模型挂起或报错后仍在同一个模型上重试，用尽才切换。
 * W3 429、Stream ended without finish_reason 这类错误第一次出现时不切换。
 * W4 没有备用模型时重试太多、退避太长，最坏要几分钟；或最后的错误不说是哪个模型。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import { TaskProgress } from "../src/task-progress.js";
import type { AgentUiEvent } from "../../shared/protocol.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const base = { api: "openai-completions" as const, baseUrl: "http://127.0.0.1", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024 };

const MAIN: Model<"openai-completions"> = { ...base, id: "step-5-preview", name: "step-5-preview", provider: "stepfun" };

/** 能力表给 gpt-6 系列登记了 30 秒首个事件上限（服务端偶尔排队 16–17 秒）。 */
const LUNA: Model<"openai-completions"> = { ...base, id: "gpt-6-luna", name: "gpt-6-luna", provider: "openai-codex" };

const FAST: Model<"openai-completions"> = { ...base, id: "glm-5.3-flash", name: "glm-5.3-flash", provider: "zai-coding-cn" };

function reply(model: Model<"openai-completions">, stopReason: AssistantMessage["stopReason"], text: string, errorMessage?: string): AssistantMessage {
  const message: AssistantMessage = { role: "assistant", content: text ? [{ type: "text", text }] : [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };

  if (errorMessage) message.errorMessage = errorMessage;

  return message;
}

/** 主模型怎么坏：一直不回（只在取消时结束）、429、流提前结束、Chrome 断网、连上后 20 秒才出字。 */
type MainFailure = "hang" | "429" | "early-end" | "failed-to-fetch" | "slow-20s";

async function session(failure: MainFailure, withFast: boolean, main = MAIN) {
  const traceDir = mkdtempSync(join(tmpdir(), "bys-failover-"));
  dirs.push(traceDir);
  process.env.SIDEAGENT_TRACE_DIR = traceDir;
  const emitted: AgentUiEvent[] = [];
  const calls: string[] = [];
  const progress = new TaskProgress("default");

  const streamSimple: ModelPort["streamSimple"] = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    calls.push(model.id);

    if (model.id === FAST.id) {
      const done = reply(FAST, "stop", "你好！我在。");
      setTimeout(() => stream.push({ type: "done", reason: "stop", message: done }), 500);
    } else if (failure === "slow-20s") {
      setTimeout(() => stream.push({ type: "start", partial: reply(main, "stop", "") }), 200);
      const timer = setTimeout(() => stream.push({ type: "done", reason: "stop", message: reply(main, "stop", "排队后答完。") }), 20_000);
      options?.signal?.addEventListener("abort", () => { clearTimeout(timer); stream.push({ type: "error", reason: "aborted", error: reply(main, "aborted", "", "Request was aborted") }); }, { once: true });
    } else if (failure === "hang") {
      // 连上了（start）但之后什么都不来；只有取消时结束。
      setTimeout(() => stream.push({ type: "start", partial: reply(MAIN, "stop", "") }), 200);
      options?.signal?.addEventListener("abort", () => stream.push({ type: "error", reason: "aborted", error: reply(MAIN, "aborted", "", "Request was aborted") }), { once: true });
    } else {
      const errorMessage = failure === "429" ? "429 Endpoint is unavailable" : failure === "failed-to-fetch" ? "Failed to fetch" : "Stream ended without finish_reason";
      setTimeout(() => stream.push({ type: "error", reason: "error", error: reply(MAIN, "error", "", errorMessage) }), 300);
    }

    return stream;
  };

  const port: ModelPort = {
    getModel: (provider, id) => [main, FAST].find(model => model.provider === provider && model.id === id),
    getAvailable: async () => (withFast ? [main, FAST] : [main]),
    completeSimple: async () => reply(FAST, "stop", "{}"),
    streamSimple,
  };

  if (withFast) port.fastModel = () => FAST;

  const rpc = { call: vi.fn(async () => ({ text: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => null, setPageTarget: vi.fn(),
    getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

  // SAFETY: 替身实现了会话用到的全部 ToolRpc 方法。
  const host = await BrowserAgentSession.create(rpc as never, { emit: event => { emitted.push(event); progress.observe({ type: "agent_event", event }); },
    setStatus: state => progress.observe({ type: "status", state }) },
    { loop: { models: port, cwd: "/tmp" }, modelPattern: `${main.provider}/${main.id}`, conversationId: "default" });

  host.bindConversationContext(() => progress.snapshot());
  host.bindDeliveryRun(() => progress.snapshot().runId ?? null);

  return { host, emitted, calls, progress };
}

const ended = (emitted: AgentUiEvent[]) => emitted.some(event => event.kind === "agent_end" || event.kind === "error");

/** 发「你好」，推进假时钟直到这一轮结束；返回用掉的（模拟）毫秒数。 */
async function sayHello(h: Awaited<ReturnType<typeof session>>, limitMs: number): Promise<number> {
  const started = Date.now();
  h.progress.request("你好", { tabId: 1, title: "t", url: "https://example.com/" });
  h.host.startTask("你好");

  while (!ended(h.emitted) && Date.now() - started < limitMs) await vi.advanceTimersByTimeAsync(100);

  return Date.now() - started;
}

const errors = (emitted: AgentUiEvent[]) => emitted.flatMap(event => (event.kind === "error" ? [event.message] : []));

describe("model failover: the user is not left waiting for minutes", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("F1 hung main model + fast model configured: the fast model answers within 17 s, main is asked once (W1, W2)", async () => {
    const h = await session("hang", true);
    const elapsed = await sayHello(h, 300_000);

    expect(JSON.stringify(h.emitted)).toContain("你好！我在。");
    expect(errors(h.emitted)).toEqual([]);
    expect(h.calls).toEqual([MAIN.id, FAST.id]);
    expect(elapsed).toBeLessThanOrEqual(17_000);
    // F4：侧栏能看到切换。
    expect(h.emitted.some(event => event.kind === "notice" && event.message.includes("glm-5.3-flash"))).toBe(true);
    h.host.abort();
  }, 30_000);

  it("F5 first event at 20 s: gpt-6-luna waits and answers itself; step-5-preview still switches at 15 s", async () => {
    const luna = await session("slow-20s", true, LUNA);
    await sayHello(luna, 60_000);
    expect(JSON.stringify(luna.emitted)).toContain("排队后答完。");
    expect(luna.calls).toEqual([LUNA.id]);
    luna.host.abort();

    const step = await session("slow-20s", true);
    await sayHello(step, 60_000);
    expect(JSON.stringify(step.emitted)).toContain("你好！我在。");
    expect(step.calls).toEqual([MAIN.id, FAST.id]);
    step.host.abort();
  }, 30_000);

  it.each(["429", "early-end", "failed-to-fetch"] as const)("F2 main fails with %s: switches on the first failure, answer within 3 s (W3)", async failure => {
    const h = await session(failure, true);
    const elapsed = await sayHello(h, 300_000);

    expect(JSON.stringify(h.emitted)).toContain("你好！我在。");
    expect(h.calls).toEqual([MAIN.id, FAST.id]);
    expect(elapsed).toBeLessThanOrEqual(3_000);
    h.host.abort();
  }, 30_000);

  it("F3 hung main model, no fallback: at most two retries, a plain error naming the model within 47 s (W4)", async () => {
    const h = await session("hang", false);
    const elapsed = await sayHello(h, 600_000);

    expect(h.calls).toEqual([MAIN.id, MAIN.id, MAIN.id]);
    expect(elapsed).toBeLessThanOrEqual(47_000);
    expect(errors(h.emitted)).toHaveLength(1);
    expect(errors(h.emitted)[0]).toContain("stepfun/step-5-preview");
    h.host.abort();
  }, 30_000);
});
