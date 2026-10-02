/**
 * 本任务存下的文件作为证据交给目标核对（10-02 自检修复起带受预算限制的文本内容）。
 * 走真实会话（扩展里的循环 + 脚本模型，不读用户凭据）：程序取到数据后用 browser.saveFile 存文件，
 * 一轮结束时目标核对要看到这个文件并判做完。失败方式：
 * H1 只存了文件、没动页面的任务根本不核对（核对只看页面改动）；
 * H2 核对看不到文件，只能按页面判「还差保存」；
 * H3 核对只看到文件存在，无法核对内容；文件正文仍不回到主模型取数结果；
 * H4 别的任务存的文件被当成这次的证据。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import { TaskProgress } from "../src/task-progress.js";
import { createBrowserTools } from "../src/tools.js";
import type { AgentUiEvent } from "../../shared/protocol.js";

const traceDir = mkdtempSync(join(tmpdir(), "bys-goal-files-trace-"));

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

// 830 行、每行「第 N 句字幕」：程序里拼好后直接存文件（代替接口取数，数据不经模型）。
const PROGRAM = 'const rows=[]; for(let i=0;i<830;i++) rows.push("第"+i+"句字幕"); return await browser.saveFile({filename:"subs.txt", content: rows.join("\\n")});';

const CHARS = Array.from({ length: 830 }, (_, i) => `第${i}句字幕`).join("\n").length;

interface JudgeInput { goal: string[]; lastReply: string; files?: Array<{ filename: string; chars: number; lines: number; savedAt: string }> }

/** 主模型：第一步跑程序存文件，第二步回一句话收尾。核对模型：看到这个文件（名字、字数、行数都对）才判做完。 */
function models(program: string | null) {
  const judged: string[] = [];
  let calls = 0;

  const streamSimple: ModelPort["streamSimple"] = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const call = calls++;

    const reply = options?.signal?.aborted || call >= 4 || (call === 0 && !program) ? message([{ type: "text", text: "已经存好了。" }], "stop")
      : call === 0 ? message([{ type: "toolCall", id: "t0", name: "browser_run", arguments: { code: program! } }], "toolUse")
        : message([{ type: "text", text: "字幕共 830 条，已存成文件 subs.txt。" }], "stop");

    setTimeout(() => stream.push({ type: "done", reason: reply.stopReason === "toolUse" ? "toolUse" : "stop", message: reply }), 0);

    return stream;
  };

  const completeSimple: ModelPort["completeSimple"] = async (_model, context) => {
    // 宿主把核对输入作为一条纯文本用户消息发出。
    const text = String(context.messages[0]?.content ?? "");
    judged.push(text);
    // SAFETY: 核对输入是宿主 JSON.stringify 的对象；字段缺失时下面按「没看到文件」处理。
    const input = JSON.parse(text) as JudgeInput;
    const file = input.files?.find(item => item.filename === "subs.txt");
    const verdict = file && file.chars === CHARS && file.lines === 830 ? { status: "done" } : { status: "continue", remaining: "保存字幕为文件" };

    return message([{ type: "text", text: JSON.stringify(verdict) }], "stop");
  };

  const port: ModelPort = { getModel: () => model, getAvailable: async () => [model], completeSimple, streamSimple };

  return { port, judged };
}

async function until(probe: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();

  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** 与生产一样把会话事件喂给任务进度，并让会话从进度读任务身份与快照。 */
async function session(program: string | null) {
  const emitted: AgentUiEvent[] = [];
  const progress = new TaskProgress("default");
  const scripted = models(program);

  const rpc = { call: vi.fn(async () => ({ text: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => null, setPageTarget: vi.fn(),
    getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

  // SAFETY: 会话建成前为空；browser_run 只在会话建成后才会被调用。
  const holder = { session: null as BrowserAgentSession | null };

  // SAFETY: 替身实现了会话与 browser_run 用到的全部 ToolRpc 方法。
  const tools = createBrowserTools(rpc as never, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, files: () => holder.session?.fileStore() })
    .filter(tool => tool.name === "browser_run");

  // SAFETY: 同上。
  holder.session = await BrowserAgentSession.create(rpc as never, { emit: event => { emitted.push(event); progress.observe({ type: "agent_event", event }); },
    setStatus: state => progress.observe({ type: "status", state }) },
    { loop: { models: scripted.port, cwd: "/tmp" }, modelPattern: "probe/probe", conversationId: "default", customTools: tools });

  const host = holder.session;
  host.bindConversationContext(() => progress.snapshot());
  host.bindDeliveryRun(() => progress.snapshot().runId ?? null);

  const start = (text: string) => {
    const page = { tabId: 1, title: "视频", url: "http://127.0.0.1/video" };
    progress.request(text, page);
    host.startTask(text, page);
  };

  return { host, emitted, judged: scripted.judged, start };
}

const goalChecks = (emitted: AgentUiEvent[]) => emitted.flatMap(event => event.kind === "goal_check" ? [event] : []);

describe("goal check sees files saved in this task", () => {
  it("a task that saves its data with browser.saveFile is checked with its bounded text content (H1–H3)", async () => {
    const h = await session(PROGRAM);

    try {
      h.start("提取字幕并且保存");
      await until(() => goalChecks(h.emitted).length > 0 && h.emitted.some(event => event.kind === "agent_end"), "the goal check and the end of the run");

      expect(goalChecks(h.emitted)).toEqual([{ kind: "goal_check", status: "done" }]);
      expect(h.judged).toHaveLength(1);
      expect(h.judged[0]).toContain('"filename":"subs.txt"');
      expect(h.judged[0]).toContain("第1句字幕");
      expect(h.judged[0]).toContain("第829句字幕");
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("a later task in the same conversation does not get the earlier file as evidence (H4)", async () => {
    const h = await session(PROGRAM);

    try {
      h.start("提取字幕并且保存");
      await until(() => h.emitted.some(event => event.kind === "agent_end"), "the first run");
      const before = h.judged.length;
      h.emitted.length = 0;
      // 第二个任务里模型只回话、不存文件，也没动页面：没有可核对的东西，不核对。
      h.start("谢谢");
      await until(() => h.emitted.some(event => event.kind === "agent_end"), "the second run");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(h.judged).toHaveLength(before);
      expect(goalChecks(h.emitted)).toEqual([]);
    } finally {
      h.host.abort();
    }
  }, 30_000);
});
