/**
 * 原地转圈自停走真实会话（扩展里用的 pi-agent-core 循环 + 脚本化模型，不读用户凭据）：
 * 模型先生成一个文件，再反复读同一份数据；产品自己停下这一轮，只交付一段话，说清卡在哪、已有什么。
 * 失败方式见 no-progress-policy.test.ts 顶部；这里补 F11（停下后不再调用工具）与 F12（交付走正式回答通道）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import { defineTool } from "../src/define-tool.js";
import { NO_PROGRESS_LIMIT } from "../src/no-progress-policy.js";
import type { AgentUiEvent } from "../../shared/protocol.js";

// 诊断记录写进临时目录，不进用户保留的 trace；停下时应留一条 no_progress_stop。
const traceDir = mkdtempSync(join(tmpdir(), "bys-no-progress-trace-"));

process.env.SIDEAGENT_TRACE_DIR = traceDir;

afterAll(() => rmSync(traceDir, { recursive: true, force: true }));

const model: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024,
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

const SRT = Array.from({ length: 40 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i + 1).padStart(2, "0")},000\n第 ${i} 句`).join("\n\n");

type ScriptedCall = { name: string; arguments: Record<string, string> };

const CREATE_SUBTITLES: ScriptedCall = { name: "artifacts", arguments: { command: "create", filename: "subtitles.srt", content: SRT } };

/** 先按脚本做几步（默认写一个文件），之后每一步都去读同一份字幕；模型永远不自己收手。 */
function loopingModel(prefix: ScriptedCall[] = [CREATE_SUBTITLES]): ModelPort & { calls: number } {
  const streamSimple: ModelPort["streamSimple"] = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();

    // 与真实服务商一致：本轮被中止后，下一次请求立即以 aborted 结束。
    if (options?.signal?.aborted) {
      const aborted = message([], "aborted");
      setTimeout(() => stream.push({ type: "error", reason: "aborted", error: aborted }), 0);

      return stream;
    }

    const call = port.calls++;

    // 保险：没停住时第 20 步收手，测试以断言失败结束而不是挂死。
    const scripted = prefix[call];

    const reply = call >= 30 ? message([{ type: "text", text: "完成" }], "stop") : scripted
      ? message([{ type: "toolCall", id: `t${call}`, name: scripted.name, arguments: scripted.arguments }], "toolUse")
      : message([{ type: "toolCall", id: `t${call}`, name: "snapshot", arguments: { part: call % 3 } }], "toolUse");

    setTimeout(() => stream.push({ type: "done", reason: reply.stopReason === "stop" ? "stop" : "toolUse", message: reply }), 0);

    return stream;
  };

  const port = { calls: 0, getModel: () => model, getAvailable: async () => [model], completeSimple: async () => { throw new Error("不调用"); }, streamSimple };

  return port;
}

async function until(probe: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();

  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function loopSession(prefix: ScriptedCall[], onRead: (count: number, host: BrowserAgentSession) => void = () => {}) {
  let host: BrowserAgentSession | null = null;
  let count = 0;

  const reads = vi.fn(async () => {
    count += 1;

    if (host) onRead(count, host);

    return { content: [{ type: "text" as const, text: JSON.stringify({ count: 40, text: SRT }) }], details: {} };
  });

  const snapshot = defineTool({ name: "snapshot", label: "snapshot", description: "read", parameters: Type.Object({ part: Type.Number() }), execute: reads });
  const emitted: AgentUiEvent[] = [];

  const rpc = { call: vi.fn(async () => ({ text: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => null, setPageTarget: vi.fn(),
    getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

  // SAFETY: 替身实现了会话用到的全部 ToolRpc 方法；自定义工具与生产工具同用 defineTool 生成。
  host = await BrowserAgentSession.create(rpc as never, { emit: event => emitted.push(event), setStatus: vi.fn() },
    { loop: { models: loopingModel(prefix), cwd: "/tmp" }, modelPattern: "probe/probe", conversationId: "default", customTools: [snapshot as never] });
  host.startTask("提取字幕并且保存", { tabId: 1, title: "视频", url: "http://127.0.0.1/video" });
  await until(() => emitted.some(event => event.kind === "agent_end"), "the run to end", 20_000);

  return { host, deliveries: emitted.flatMap(event => event.kind === "user_delivery" ? [event.delivery.text] : []) };
}

describe("no-progress stop: the files it reports", () => {
  it("still lists the file after a user interjection reset the counting", async () => {
    const h = await loopSession([CREATE_SUBTITLES], (count, host) => { if (count === 3) void host.steerCurrentTask("补充：存成 srt 就行").catch(() => {}); });

    try {
      expect(h.deliveries).toHaveLength(1);
      expect(h.deliveries[0]).toContain(`已有：文件「subtitles.srt」（${SRT.length} 字`);
    } finally { h.host.abort(); }
  }, 30_000);

  it("does not list a file that was deleted", async () => {
    const h = await loopSession([
      { name: "artifacts", arguments: { command: "create", filename: "a.srt", content: "第一版" } },
      { name: "artifacts", arguments: { command: "create", filename: "b.srt", content: "第二版" } },
      { name: "artifacts", arguments: { command: "delete", filename: "a.srt" } },
    ]);

    try {
      expect(h.deliveries).toHaveLength(1);
      expect(h.deliveries[0]).toContain("已有：文件「b.srt」（3 字，1 行）。");
      expect(h.deliveries[0]).not.toContain("a.srt");
    } finally { h.host.abort(); }
  }, 30_000);
});

describe("no-progress stop in a real session loop", () => {
  it("stops the run by itself and delivers one message with the step and the file it already made", async () => {
    const reads = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ count: 40, text: SRT }) }], details: {} }));
    const snapshot = defineTool({ name: "snapshot", label: "snapshot", description: "read", parameters: Type.Object({ part: Type.Number() }), execute: reads });
    const models = loopingModel();
    const emitted: AgentUiEvent[] = [];

    const rpc = { call: vi.fn(async () => ({ text: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => null, setPageTarget: vi.fn(),
      getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

    // SAFETY: 替身实现了会话用到的全部 ToolRpc 方法；自定义工具与生产工具同用 defineTool 生成。
    const session = await BrowserAgentSession.create(rpc as never, { emit: event => emitted.push(event), setStatus: vi.fn() },
      { loop: { models, cwd: "/tmp" }, modelPattern: "probe/probe", conversationId: "default", customTools: [snapshot as never] });

    try {
      session.startTask("提取字幕并且保存", { tabId: 1, title: "视频", url: "http://127.0.0.1/video" });
      await until(() => emitted.some(event => event.kind === "agent_end"), "the run to end");

      // 第 1 次读是新信息（文件内容之外多了 count 字段），之后连续 NO_PROGRESS_LIMIT 次没进展。
      expect(reads).toHaveBeenCalledTimes(NO_PROGRESS_LIMIT + 1);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(models.calls).toBe(NO_PROGRESS_LIMIT + 2);

      const deliveries = emitted.flatMap(event => event.kind === "user_delivery" ? [event.delivery] : []);
      expect(deliveries).toHaveLength(1);
      // 诊断记录异步追加写盘：等它落盘。
      const trace = () => readdirSync(traceDir).map(name => readFileSync(join(traceDir, name), "utf8")).join("");
      await until(() => trace().includes('"type":"no_progress_stop"'), "the no_progress_stop trace record");
      expect(deliveries[0]!.text).toBe(`「读取页面」这一步在原地打转：连续 ${NO_PROGRESS_LIMIT} 步都是重读已经拿到的内容或重复同样的错误，没有新进展，我先停下了。已有：文件「subtitles.srt」（${SRT.length} 字，${SRT.split("\n").length} 行）。`);
    } finally {
      session.abort();
    }
  }, 20_000);
});
