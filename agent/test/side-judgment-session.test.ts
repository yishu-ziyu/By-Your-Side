/**
 * 后台判断的统一入口（docs/evals/20261001-model-effort-and-side-judgments.md 标准 1、2、3、5）。
 * 走真实会话（扩展里的 pi-agent-core 循环 + 脚本模型，不读用户凭据）：主模型用一次工具再收尾，
 * 一轮结束时的目标核对、记忆判断、划词问答都按用户实际触发的方式发出；只看发给模型的请求、界面事件和诊断记录。
 *
 * 先列出会出错的方式：
 * J1 后台判断发了模型不接受的档位（mimo-v2.6-flash 的 minimal → 400），核对静默失败。
 * J2 服务端因档位拒绝时不换档，或换档后同一会话下次还先试被拒的档。
 * J3 回复是聊天而不是 JSON 时不修复重试；重试没有更严格的要求（系统提示词和用户消息末尾都要有）。
 * J4 两次都不是 JSON：无限重试，或失败没有原因类别。
 * J5 只有思考没有正文：不放大输出额度就重试，仍然拿不到结论。
 * J6 失败诊断里带上服务商原文（可能含凭据）。
 * J7 记忆判断失败只说「记忆判断失败」，看不出是参数被拒、格式不对还是超时。
 * J8 划词问答失败一律「这次回答没有完成」，没有原因类别。
 * J9 每次后台判断没有一行 side_call{purpose, model, effort, attempts, outcome, reason?}。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import { TaskProgress } from "../src/task-progress.js";
import { createBrowserTools } from "../src/tools.js";
import { ReadingRequests } from "../src/reading.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "./fixtures/file-document.js";
import type { AgentUiEvent } from "../../shared/protocol.js";
import type { ReadingEvent } from "../../shared/reading.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const base = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024 };

/** 目录里没有的 mimo：适配层看到的是同服务商模板复制出来、开了 reasoning 的模型。 */
const MIMO: Model<Api> = { ...base, id: "mimo-v2.6-flash", name: "mimo-v2.6-flash", api: "openai-completions", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", reasoning: true, input: ["text"] };

/** 未登记、目录标为能思考的模型：可选档是 off、minimal、low、medium、high。 */
const THINKER: Model<Api> = { ...base, id: "thinker", name: "thinker", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1", reasoning: true, input: ["text"] };

/** 未登记、不思考的模型：只有 off 一档。 */
const PLAIN: Model<Api> = { ...base, id: "plain", name: "plain", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"] };

function message(model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  const reply: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };

  if (errorMessage) reply.errorMessage = errorMessage;

  return reply;
}

/** 本测试读到的诊断记录字段（side_call、goal_check）。 */
interface TraceLine { type: string; data: { purpose?: string; model?: string; effort?: string; attempts?: number; outcome?: string; reason?: string; status?: string } }

/** 后台判断收到的一次请求：只留断言要看的部分。 */
interface SideRequest { systemPrompt: string; lastUserText: string; reasoning?: string; maxTokens?: number }

type Judge = (request: SideRequest, n: number) => AssistantMessage;

type Main = (context: Context, call: number, options: SimpleStreamOptions | undefined) => AssistantMessage;

const lastUserText = (context: Context) => {
  const content = context.messages.at(-1)?.content;

  return Array.isArray(content) ? content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("") : content ?? "";
};

const toolResultText = (context: Pick<Context, "messages">) => context.messages.flatMap(item => (item.role === "toolResult" ? item.content.flatMap(part => (part.type === "text" ? [part.text] : [])) : [])).join("\n");

/** 最后一次文字收尾之后（即本任务）的消息。 */
function sinceLastAnswer(messages: Context["messages"]): Context["messages"] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i]!;

    if (item.role === "assistant" && item.stopReason === "stop") return messages.slice(i + 1);
  }

  return messages;
}

/** 主模型：每个任务先跑一次 browser_run，拿到结果后收尾（用过工具 → 一轮结束要核对）。 */
const toolThenDone = (model: Model<Api>): Main => (context, call) => (!sinceLastAnswer(context.messages).some(item => item.role === "toolResult")
  ? message(model, [{ type: "toolCall", id: `t${call}`, name: "browser_run", arguments: { code: "return 1 + 1;" } }], "toolUse")
  : message(model, [{ type: "text", text: "已经查好了。" }], "stop"));

async function until(probe: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();

  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function session(model: Model<Api>, judge: Judge, main: Main, options: { memory?: boolean } = {}) {
  const traceDir = mkdtempSync(join(tmpdir(), "bys-side-judgment-"));
  dirs.push(traceDir);
  process.env.SIDEAGENT_TRACE_DIR = traceDir;
  const emitted: AgentUiEvent[] = [];
  const progress = new TaskProgress("default");
  const side: SideRequest[] = [];
  const mainContexts: Array<Pick<Context, "messages">> = [];
  let mainCalls = 0;

  const streamSimple: ModelPort["streamSimple"] = (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const reading = context.systemPrompt?.includes("阅读助手");

    const reply = reading ? judge({ systemPrompt: context.systemPrompt ?? "", lastUserText: lastUserText(context), reasoning: streamOptions?.reasoning }, side.length)
      : streamOptions?.signal?.aborted || mainCalls >= 8 ? message(model, [{ type: "text", text: "好的。" }], "stop") : main(context, mainCalls, streamOptions);

    if (!reading) { mainContexts.push(structuredClone({ messages: context.messages })); mainCalls += 1; }

    setTimeout(() => {
      if (reply.stopReason === "error") stream.push({ type: "error", reason: "error", error: reply });
      else stream.push({ type: "done", reason: reply.stopReason === "toolUse" ? "toolUse" : "stop", message: reply });
    }, 0);

    return stream;
  };

  const completeSimple: ModelPort["completeSimple"] = async (_model, context, completeOptions) => {
    const request = { systemPrompt: context.systemPrompt ?? "", lastUserText: lastUserText(context), reasoning: completeOptions?.reasoning, maxTokens: completeOptions?.maxTokens };
    side.push(request);

    return judge(request, side.length - 1);
  };

  const port: ModelPort = { getModel: () => model, getAvailable: async () => [model], completeSimple, streamSimple };

  const rpc = { call: vi.fn(async () => ({ text: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => null, setPageTarget: vi.fn(),
    getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

  // SAFETY: 会话建成前为空；browser_run 只在会话建成后才会被调用。
  const holder = { session: null as BrowserAgentSession | null };

  // SAFETY: 替身实现了会话与 browser_run 用到的全部 ToolRpc 方法。
  const tools = createBrowserTools(rpc as never, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, files: () => holder.session?.fileStore() })
    .filter(tool => tool.name === "browser_run");

  const memoryStore = options.memory ? new MemoryStore(new FileDocument(mkdtempSync(join(tmpdir(), "bys-side-memory-")), MEMORY_STORE_FILE)) : undefined;

  const createOptions: NonNullable<Parameters<typeof BrowserAgentSession.create>[2]> = { loop: { models: port, cwd: "/tmp" }, modelPattern: `${model.provider}/${model.id}`, conversationId: "default", customTools: tools };

  if (memoryStore) createOptions.memoryStore = memoryStore;

  // SAFETY: 同上。
  holder.session = await BrowserAgentSession.create(rpc as never, { emit: event => { emitted.push(event); progress.observe({ type: "agent_event", event }); },
    setStatus: state => progress.observe({ type: "status", state }) }, createOptions);

  const host = holder.session;
  host.bindConversationContext(() => progress.snapshot());
  host.bindDeliveryRun(() => progress.snapshot().runId ?? null);

  const start = (text: string) => {
    const page = { tabId: 1, title: "视频", url: "http://127.0.0.1/video" };
    progress.request(text, page);
    host.startTask(text, page);
  };

  // SAFETY: 每行是 TraceRecorder 写的 JSON 对象。
  const trace = () => readdirSync(traceDir).flatMap(name => readFileSync(join(traceDir, name), "utf8").split("\n").filter(Boolean)).map(line => JSON.parse(line) as TraceLine);
  const ends = () => emitted.filter(event => event.kind === "agent_end").length;

  return { host, emitted, side, mainContexts, start, trace, ends, raw: () => readdirSync(traceDir).map(name => readFileSync(join(traceDir, name), "utf8")).join("") };
}

const verdict = (model: Model<Api>, status = "done") => message(model, [{ type: "text", text: JSON.stringify({ status, remaining: status === "done" ? "" : "还差一步" }) }], "stop");

const goalChecks = (emitted: AgentUiEvent[]) => emitted.flatMap(event => (event.kind === "goal_check" ? [event] : []));

const sideCalls = (trace: TraceLine[]) => trace.flatMap(line => (line.type === "side_call" ? [line.data] : []));

describe("background judgments share one entry", () => {
  it("never sends mimo-v2.6-flash the minimal level it rejects; the goal check gets its verdict and logs one side_call (J1, J9)", async () => {
    const h = await session(MIMO, request => (request.reasoning === "minimal" ? message(MIMO, [], "error", "400 Invalid request parameters") : verdict(MIMO)), toolThenDone(MIMO));

    try {
      h.start("查一下天气");
      await until(() => h.ends() > 0, "the end of the run");

      expect(h.side.map(request => request.reasoning)).toEqual([undefined]);
      expect(goalChecks(h.emitted)).toEqual([{ kind: "goal_check", status: "done" }]);
      await until(() => sideCalls(h.trace()).length > 0, "the side_call line");
      expect(sideCalls(h.trace())).toEqual([{ purpose: "goal_check", model: "opencode-go/mimo-v2.6-flash", effort: "off", attempts: 1, outcome: "ok" }]);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("on a thinking-parameter rejection retries once at the next allowed level and remembers it for the session (J2)", async () => {
    // 服务端要求开思考：不带档位就 400。
    const h = await session(THINKER, request => (request.reasoning === undefined
      ? message(THINKER, [], "error", '400 {"error":{"message":"invalid params, model requires adaptive thinking; thinking.type=\\"disabled\\" is not allowed (2013)"}}')
      : verdict(THINKER)), toolThenDone(THINKER));

    try {
      h.start("查一下天气");
      await until(() => h.ends() > 0, "the first run");
      h.start("再查一下明天");
      await until(() => h.ends() > 1, "the second run");

      expect(h.side.map(request => request.reasoning)).toEqual([undefined, "minimal", "minimal"]);
      expect(goalChecks(h.emitted).map(event => event.status)).toEqual(["done", "done"]);
      await until(() => sideCalls(h.trace()).length > 1, "both side_call lines");
      expect(sideCalls(h.trace()).map(call => [call.effort, call.attempts, call.outcome])).toEqual([["minimal", 2, "ok"], ["minimal", 1, "ok"]]);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("repairs a chatty reply once with a stricter requirement in both the system prompt and the user message (J3)", async () => {
    const h = await session(PLAIN, (_request, n) => (n === 0 ? message(PLAIN, [{ type: "text", text: "要找前两首歌，可以先打开歌单页面看看。" }], "stop") : verdict(PLAIN, "continue")), toolThenDone(PLAIN));

    try {
      h.start("在YouTube里面找到前两首歌。");
      await until(() => goalChecks(h.emitted).length > 0, "the goal check");

      expect(h.side).toHaveLength(2);
      expect(h.side[1]!.systemPrompt.startsWith(h.side[0]!.systemPrompt)).toBe(true);
      expect(h.side[1]!.systemPrompt.length).toBeGreaterThan(h.side[0]!.systemPrompt.length);
      expect(h.side[1]!.systemPrompt).toMatch(/ONLY the JSON object/);
      expect(h.side[1]!.lastUserText.startsWith(h.side[0]!.lastUserText)).toBe(true);
      expect(h.side[1]!.lastUserText).toMatch(/ONLY the JSON object/);
      expect(goalChecks(h.emitted)[0]).toMatchObject({ kind: "goal_check", status: "continue" });
      await until(() => sideCalls(h.trace()).length > 0, "the side_call line");
      expect(sideCalls(h.trace())).toEqual([{ purpose: "goal_check", model: "probe/plain", effort: "off", attempts: 2, outcome: "ok" }]);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("gives up after one repair and records the reason category without the provider's text (J4, J6)", async () => {
    const h = await session(PLAIN, () => message(PLAIN, [{ type: "text", text: "好的，我来帮你看看！" }], "stop"), toolThenDone(PLAIN));

    try {
      h.start("查一下天气");
      await until(() => h.ends() > 0 && h.trace().some(line => line.type === "goal_check"), "the end of the run");

      expect(h.side).toHaveLength(2);
      expect(h.trace().find(line => line.type === "goal_check")?.data).toEqual({ status: "unavailable", reason: "bad_format" });
      expect(sideCalls(h.trace())).toEqual([{ purpose: "goal_check", model: "probe/plain", effort: "off", attempts: 2, outcome: "failed", reason: "bad_format" }]);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("a provider error is a category, never the provider's message (J6)", async () => {
    const h = await session(PLAIN, () => message(PLAIN, [], "error", "500 upstream failed for key sk-live-SECRET123"), toolThenDone(PLAIN));

    try {
      h.start("查一下天气");
      await until(() => h.ends() > 0 && h.trace().some(line => line.type === "goal_check"), "the end of the run");

      expect(sideCalls(h.trace())).toEqual([{ purpose: "goal_check", model: "probe/plain", effort: "off", attempts: 1, outcome: "failed", reason: "provider_error" }]);
      expect(h.raw()).not.toContain("sk-live-SECRET123");
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("a thinking-only reply is retried with a five times larger output budget (J5)", async () => {
    const h = await session(PLAIN, (_request, n) => (n === 0 ? message(PLAIN, [{ type: "thinking", thinking: "让我想想……" }], "length") : verdict(PLAIN)), toolThenDone(PLAIN));

    try {
      h.start("查一下天气");
      await until(() => goalChecks(h.emitted).length > 0, "the goal check");

      expect(h.side.map(request => request.maxTokens)).toEqual([1600, 8000]);
      expect(goalChecks(h.emitted)).toEqual([{ kind: "goal_check", status: "done" }]);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("an explicit memory request that fails tells the model why (J7)", async () => {
    const rejected = () => message(PLAIN, [], "error", "400 Invalid request parameters");

    const h = await session(PLAIN, rejected, (_context, call) => (call === 0
      ? message(PLAIN, [{ type: "toolCall", id: "m0", name: "user_memory", arguments: { action: "change" } }], "toolUse")
      : message(PLAIN, [{ type: "text", text: "没能记下。" }], "stop")), { memory: true });

    try {
      h.start("记住我的邮箱是 a@example.com");
      await until(() => h.ends() > 0, "the end of the run");

      expect(toolResultText(h.mainContexts[1]!)).toContain("记忆判断失败（模型拒绝了请求参数），尚未修改记忆");
      expect(sideCalls(h.trace()).filter(call => call.purpose === "memory").every(call => call.reason === "rejected_params")).toBe(true);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("a failed reading answer names the reason category (J8)", async () => {
    const h = await session(PLAIN, () => message(PLAIN, [], "error", "400 Invalid request parameters"), toolThenDone(PLAIN));
    const events: ReadingEvent[] = [];
    const transcript = { threadId: "r1", source: { text: "const n = 3;", surrounding: "", truncated: false, tabId: 1, title: "Article", url: "https://example.com" }, turns: [{ question: "解释", answer: "", state: "pending" as const }] };

    try {
      await new ReadingRequests().run("q1", transcript, (t, signal, onText) => h.host.answerReading(t, signal, onText), event => events.push(event));

      expect(events.at(-1)).toMatchObject({ state: "error", error: "这次回答没有完成（模型拒绝了请求参数）。已保留内容，可以重试。" });
    } finally {
      h.host.abort();
    }
  }, 30_000);
});
