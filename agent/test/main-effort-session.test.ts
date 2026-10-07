/**
 * 主任务的思考档位（docs/evals/20261001-model-effort-and-side-judgments.md 标准 1、4）。
 * 走真实会话（扩展里的 pi-agent-core 循环 + 脚本模型，不读用户凭据）；只看每次主模型请求带的档位和诊断记录 effort_change。
 *
 * 先列出会出错的方式：
 * M1 主循环从不设档位：MiniMax-M3.1-Flash-Preview 这类不能关闭思考的模型第一句就 400。
 * M2 起始档不是中档；模型没有中档时取到了更高的档，或低于模型最低档。
 * M3 同一操作连续失败后，下一次调用不升档（或要等整轮结束才升）。
 * M4 目标核对判「没做完」、宿主催它接着做时不升档。
 * M5 用户中途纠正后不升档。
 * M6 原地打转被停后不记升档。
 * M7 升过模型最高档，或到顶后还写 effort_change。
 * M8 新任务不回到起始档。
 * M9 未登记、不思考的模型被发了思考参数。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import { defineTool } from "../src/define-tool.js";
import { TaskProgress } from "../src/task-progress.js";
import type { AgentUiEvent } from "../../shared/protocol.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const base = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024, input: ["text" as const] };

/** 目录里没有、实测不能关闭思考的模型（扩展解析时从 MiniMax-M3 复制连接参数，reasoning 为真）。 */
const M31: Model<Api> = { ...base, id: "MiniMax-M3.1-Flash-Preview", name: "MiniMax-M3.1-Flash-Preview", api: "anthropic-messages", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic", reasoning: true };

/** 未登记、能思考：off、minimal、low、medium、high。 */
const THINKER: Model<Api> = { ...base, id: "thinker", name: "thinker", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1", reasoning: true };

/** 没有中档：low、high、max（同智谱目录的写法）。 */
const NO_MEDIUM: Model<Api> = { ...THINKER, id: "no-medium", thinkingLevelMap: { off: null, minimal: null, medium: null, xhigh: null, max: "max" } };

/** 最低档就在中档之上：high、max。 */
const HIGH_ONLY: Model<Api> = { ...THINKER, id: "high-only", thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, xhigh: null, max: "max" } };

/** 未登记、不思考。 */
const PLAIN: Model<Api> = { ...THINKER, id: "plain", reasoning: false };

function message(model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

type Step = (context: Context, call: number) => { tool: string; args?: { part?: number } } | { text: string };

/** 本测试读到的诊断记录字段（effort_change、no_progress_stop）。 */
interface TraceLine { type: string; data: { from?: string; to?: string; signal?: string } }

async function until(probe: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();

  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** 最后一次文字收尾之后（即本任务）的消息。 */
function sinceLastAnswer(messages: Context["messages"]): Context["messages"] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i]!;

    if (item.role === "assistant" && item.stopReason === "stop") return messages.slice(i + 1);
  }

  return messages;
}

/** 本任务已经有过多少个工具结果。 */
const toolsSinceLastAnswer = (context: Context) => sinceLastAnswer(context.messages).flatMap(item => (item.role === "toolResult" ? [item] : [])).length;

async function session(model: Model<Api>, step: Step, options: { verdicts?: string[]; onRead?: () => Promise<void> } = {}) {
  const traceDir = mkdtempSync(join(tmpdir(), "bys-main-effort-"));
  dirs.push(traceDir);
  process.env.SIDEAGENT_TRACE_DIR = traceDir;
  const efforts: Array<string | undefined> = [];
  const emitted: AgentUiEvent[] = [];
  const progress = new TaskProgress("default");
  let judged = 0;

  const streamSimple: ModelPort["streamSimple"] = (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const call = efforts.length;
    efforts.push(streamOptions?.reasoning);
    const next = streamOptions?.signal?.aborted || call >= 40 ? { text: "好的。" } : step(context, call);

    const reply = "text" in next ? message(model, [{ type: "text", text: next.text }], "stop")
      : message(model, [{ type: "toolCall", id: `t${call}`, name: next.tool, arguments: next.args ?? {} }], "toolUse");

    setTimeout(() => stream.push({ type: "done", reason: reply.stopReason === "toolUse" ? "toolUse" : "stop", message: reply }), 0);

    return stream;
  };

  const completeSimple: ModelPort["completeSimple"] = async () => {
    const status = options.verdicts?.[judged++] ?? "done";

    return message(model, [{ type: "text", text: JSON.stringify({ status, remaining: status === "done" ? "" : "还差保存" }) }], "stop");
  };

  const port: ModelPort = { getModel: () => model, getAvailable: async () => [model], completeSimple, streamSimple };

  const read = defineTool({ name: "read_page", label: "read", description: "read", parameters: Type.Object({ part: Type.Optional(Type.Number()) }), execute: async (_id, params) => {
    await options.onRead?.();

    return { content: [{ type: "text" as const, text: `第 ${params.part ?? 0} 段内容` }], details: {} };
  } });

  const flaky = defineTool({ name: "click_save", label: "click", description: "click", parameters: Type.Object({}), execute: async () => { throw new Error("按钮不可点击"); } });

  const rpc = { call: vi.fn(async () => ({ text: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => null, setPageTarget: vi.fn(),
    getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

  // SAFETY: 替身实现了会话用到的全部 ToolRpc 方法；自定义工具与生产工具同用 defineTool 生成。
  const host = await BrowserAgentSession.create(rpc as never, { emit: event => { emitted.push(event); progress.observe({ type: "agent_event", event }); },
    setStatus: state => progress.observe({ type: "status", state }) },
    { loop: { models: port, cwd: "/tmp" }, modelPattern: `${model.provider}/${model.id}`, conversationId: "default", customTools: [read as never, flaky as never] });

  host.bindConversationContext(() => progress.snapshot());
  host.bindDeliveryRun(() => progress.snapshot().runId ?? null);

  const start = (text: string) => {
    const page = { tabId: 1, title: "视频", url: "http://127.0.0.1/video" };
    progress.request(text, page);
    host.startTask(text, page);
  };

  // SAFETY: 每行是 TraceRecorder 写的 JSON 对象。
  const trace = () => readdirSync(traceDir).flatMap(name => readFileSync(join(traceDir, name), "utf8").split("\n").filter(Boolean)).map(line => JSON.parse(line) as TraceLine);
  const changes = () => trace().flatMap(line => (line.type === "effort_change" ? [line.data] : []));
  const ends = () => emitted.filter(event => event.kind === "agent_end").length;

  return { host, efforts, start, trace, changes, ends, emitted };
}

/** 每个任务读一次页面再收尾。 */
const readThenAnswer: Step = context => (toolsSinceLastAnswer(context) ? { text: "看完了。" } : { tool: "read_page" });

describe("main task thinking level", () => {
  it("starts M3.1 at medium instead of sending no level (M1, M2)", async () => {
    const h = await session(M31, readThenAnswer);

    try {
      h.start("看看这页写了什么");
      await until(() => h.ends() > 0, "the run");

      expect(h.efforts).toEqual(["medium", "medium"]);
      expect(h.changes()).toEqual([]);
    } finally { h.host.abort(); }
  }, 30_000);

  it("without a medium level starts at the highest level below it, and never below the model's lowest (M2)", async () => {
    for (const [model, expected] of [[NO_MEDIUM, "low"], [HIGH_ONLY, "high"]] as const) {
      const h = await session(model, readThenAnswer);

      try {
        h.start("看看这页写了什么");
        await until(() => h.ends() > 0, "the run");

        expect(h.efforts[0]).toBe(expected);
      } finally { h.host.abort(); }
    }
  }, 30_000);

  it("starts a model registered with a measured start level there, gpt-6-luna at high (2026-10-06)", async () => {
    const h = await session({ ...THINKER, id: "gpt-6-luna", name: "gpt-6-luna", provider: "openai-codex" }, readThenAnswer);

    try {
      h.start("看看这页写了什么");
      await until(() => h.ends() > 0, "the run");

      expect(h.efforts[0]).toBe("high");
    } finally { h.host.abort(); }
  }, 30_000);

  it("sends no thinking parameter to an unregistered model that does not think (M9)", async () => {
    const h = await session(PLAIN, readThenAnswer);

    try {
      h.start("看看这页写了什么");
      await until(() => h.ends() > 0, "the run");

      expect(h.efforts).toEqual([undefined, undefined]);
    } finally { h.host.abort(); }
  }, 30_000);

  it("raises one level right after the same operation fails twice in a row (M3)", async () => {
    // 前两步点同一个按钮都失败，第三步换成读页，第四步收尾。
    const h = await session(THINKER, (_context, call) => (call < 2 ? { tool: "click_save" } : call === 2 ? { tool: "read_page" } : { text: "按钮点不了，已读完页面。" }));

    try {
      h.start("点保存");
      await until(() => h.ends() > 0, "the run");
      await until(() => h.changes().length > 0, "the effort_change line");

      expect(h.efforts.slice(0, 4)).toEqual(["medium", "medium", "high", "high"]);
      expect(h.changes()).toEqual([{ from: "medium", to: "high", signal: "tool_failures" }]);
    } finally { h.host.abort(); }
  }, 30_000);

  it("raises the level for the run the goal check pushes to continue (M4)", async () => {
    const h = await session(THINKER, readThenAnswer, { verdicts: ["continue", "done"] });

    try {
      h.start("把字幕存成文件");
      await until(() => h.emitted.filter(event => event.kind === "goal_check").length > 1, "both goal checks");
      // 诊断记录异步写入：并发跑时断言会先于这一行到达。
      await until(() => h.changes().length > 0, "the effort_change line");

      expect(h.efforts).toEqual(["medium", "medium", "high", "high"]);
      expect(h.changes()).toEqual([{ from: "medium", to: "high", signal: "goal_unfinished" }]);
    } finally { h.host.abort(); }
  }, 30_000);

  it("raises after a user correction, stops at the model's top level, and a new task starts over (M5, M7, M8)", async () => {
    let release: () => void = () => {};

    let reads = 0;
    let host: BrowserAgentSession | null = null;

    // 第一个任务读页时用户连着纠正两次；读完收尾。第二个任务照常读一次。
    const h = await session(THINKER, readThenAnswer, { onRead: async () => {
      reads += 1;

      if (reads !== 1 || !host) return;
      await host.steerCurrentTask("不对，要的是第二页");
      await host.steerCurrentTask("再补充：只要标题");
      await new Promise<void>(resolve => { release = resolve; setTimeout(resolve, 50); });
    } });

    host = h.host;

    try {
      h.start("看看这页写了什么");
      await until(() => h.ends() > 0, "the first run");
      release();
      h.start("再看看下一页");
      await until(() => h.ends() > 1, "the second run");
      await until(() => h.changes().length > 1, "the effort_change lines");

      expect(h.efforts[0]).toBe("medium");
      expect(h.efforts[1]).toBe("high");
      expect(h.efforts.at(-2)).toBe("medium");
      expect(h.changes()).toEqual([{ from: "medium", to: "high", signal: "user_correction" }, { from: "high", to: "medium", signal: "new_task" }]);
    } finally { h.host.abort(); }
  }, 30_000);

  it("records a raise when the host stops a run that goes in circles (M6)", async () => {
    const h = await session(THINKER, (_context, call) => ({ tool: "read_page", args: { part: call % 3 } }));

    try {
      h.start("提取字幕");
      await until(() => h.trace().some(line => line.type === "no_progress_stop"), "the no-progress stop", 20_000);
      await until(() => h.changes().length > 0, "the effort_change line");

      expect(h.changes()).toEqual([{ from: "medium", to: "high", signal: "no_progress" }]);
    } finally { h.host.abort(); }
  }, 30_000);
});
