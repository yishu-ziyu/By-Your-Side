/**
 * 侧栏改方向：模型正在写正文时收到侧栏插话，当场截断这段正文，同一轮里按新要求重写。
 *
 * 先列可能的失败（docs/evals/20261005-ghost-hud-and-steering.md R3/R4）：
 * F1 不截断：下一次模型调用要等长文写完才发生。
 * F2 截断变成中止或出错：这一轮带错误结束，界面出红色错误。
 * F3 下一次模型输入缺原半截正文或缺插话。
 * F4 截断后旧请求晚到的字混进上下文。
 * F5 分裂：截断后另起一轮（两次 agent_start / agent_end）。
 * F6 模型在调工具时也被截断（工具参数半截）。
 * F7 不是侧栏文字插话（语音等）也被截断。
 *
 * 真实 Pi 会话 + 脚本化本地模型流（不读用户凭据）。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model, type TextContent } from "@earendil-works/pi-ai";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import type { AgentUiEvent, PageContext } from "../../shared/protocol.js";

async function until<T>(probe: () => T | undefined | false, timeoutMs = 5000, what = "condition"): Promise<T> {
  const started = Date.now();

  for (;;) {
    const value = probe();

    if (value) return value;

    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const page: PageContext = { tabId: 1, title: "Gateway API", url: "http://127.0.0.1/gateway" };

const model: Model<"openai-completions"> = {
  id: "probe", name: "Reshape probe", api: "openai-completions", provider: "reshape-probe",
  baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function textOf(message: Message): string {
  const { content } = message;

  return Array.isArray(content) ? content.map(part => part.type === "text" ? part.text : "").join("\n") : content;
}

const LONG_HEAD = "正在逐段梳理两者差异：1. Ingress 集中定义。";

const LONG_TAIL = "2. 注解滥用导致迁移困难。";

const TABLE = "| 维度 | Ingress | Gateway API |\n|---|---|---|\n| 角色 | 集中 | 分权 |";

/** 一次被挂住的模型调用：测试决定要不要再推事件，并能看到它有没有被取消。 */
interface HeldCall { stream: ReturnType<typeof createAssistantMessageEventStream>; aborted: boolean }

/** first: 第一次调用写到一半挂住（正文或工具调用）；之后的调用直接给新回答。 */
async function harness(first: "text" | "tool") {
  const dir = mkdtempSync(join(tmpdir(), "sideagent-reshape-"));
  vi.stubEnv("SIDEAGENT_TRACE_DIR", join(dir, "traces"));
  const calls: Array<Array<{ role: string; text: string }>> = [];
  const held: HeldCall[] = [];

  const streamSimple: ModelPort["streamSimple"] = (_model, context, options) => {
    calls.push(context.messages.map(message => ({ role: message.role, text: textOf(message) })));
    const pipe = createAssistantMessageEventStream();

    if (calls.length === 1) {
      const call: HeldCall = { stream: pipe, aborted: false };
      options?.signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });

      if (first === "text") {
        const text: TextContent = { type: "text", text: "" };
        const partial = assistant([text], "stop");
        pipe.push({ type: "start", partial });
        pipe.push({ type: "text_start", contentIndex: 0, partial });
        text.text = LONG_HEAD;
        pipe.push({ type: "text_delta", contentIndex: 0, delta: LONG_HEAD, partial: assistant([{ type: "text", text: LONG_HEAD }], "stop") });
      } else {
        // 先写了一句正文，再开始写工具调用：有正文也不能截断。
        const partial = assistant([{ type: "text", text: LONG_HEAD }, { type: "toolCall", id: "call-1", name: "snapshot", arguments: {} }], "stop");
        pipe.push({ type: "start", partial });
        pipe.push({ type: "text_delta", contentIndex: 0, delta: LONG_HEAD, partial: assistant([{ type: "text", text: LONG_HEAD }], "stop") });
        pipe.push({ type: "toolcall_start", contentIndex: 1, partial });
      }

      held.push(call);
    } else {
      const done = assistant([{ type: "text", text: TABLE }], "stop");
      pipe.push({ type: "start", partial: done });
      pipe.push({ type: "done", reason: "stop", message: done });
    }

    return pipe;
  };

  const models: ModelPort = {
    getModel: () => model, getAvailable: async () => [model], streamSimple,
    completeSimple: async () => assistant([{ type: "text", text: "{}" }], "stop"),
  };

  const rpc = {
    call: vi.fn(async () => ({ text: "页面内容" })),
    resolvePageParams: <T>(_name: string, params: T) => params,
    getPageTarget: () => null,
    setPageTarget: vi.fn(),
  };

  const emitted: AgentUiEvent[] = [];

  // SAFETY: 替身只实现这条路径用到的 ToolRpc 方法（call、resolvePageParams、getPageTarget、setPageTarget）。
  const session = await BrowserAgentSession.create(rpc as never, {
    emit: event => emitted.push(event),
    setStatus: vi.fn(),
  }, { loop: { models, cwd: dir }, modelPattern: "reshape-probe/probe" });

  return { session, calls, held, emitted, cleanup: () => { session.abort(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); } };
}

const STEER = "把正在写的回答改成对比表格。";

describe("侧栏改方向：截断正在写的正文，同一轮重写", () => {
  it("正文写到一半收到侧栏插话：不等写完，下一次调用带原半截与插话，不报错不分裂", async () => {
    const h = await harness("text");

    try {
      h.session.startTask("对比 Ingress 和 Gateway API。", page);
      await until(() => h.calls.length === 1 && h.emitted.some(e => e.kind === "text_delta"), 10_000, "第一次调用开始写正文");
      await h.session.steerCurrentTask(STEER, page, undefined, { rewrite: true });

      // F1：held 流从未被测试放行，下一次调用只能来自截断。
      await until(() => h.calls.length >= 2, 3_000, "截断后的下一次模型调用");
      expect(h.held[0]!.aborted).toBe(true);

      // F4：截断后旧请求再来的字不进上下文。
      h.held[0]!.stream.push({ type: "text_delta", contentIndex: 0, delta: LONG_TAIL, partial: assistant([{ type: "text", text: LONG_HEAD + LONG_TAIL }], "stop") });

      // F3：原半截正文在前，插话在后。
      const second = h.calls[1]!;
      const head = second.findIndex(m => m.role === "assistant" && m.text === LONG_HEAD);
      const steer = second.findIndex(m => m.role === "user" && m.text.includes(STEER));
      expect(head).toBeGreaterThan(-1);
      expect(steer).toBeGreaterThan(head);

      await until(() => h.emitted.some(e => e.kind === "agent_end"), 5_000, "这一轮结束");
      // F2 / F5
      expect(h.emitted.filter(e => e.kind === "error")).toEqual([]);
      expect(h.emitted.filter(e => e.kind === "agent_start")).toHaveLength(1);
      expect(h.emitted.filter(e => e.kind === "agent_end")).toHaveLength(1);
      expect(h.calls).toHaveLength(2);

      // F4：截断后晚到的字不进会话；下一轮模型输入里只有原半截。
      h.session.startTask("继续。", page);
      await until(() => h.calls.length >= 3, 5_000, "下一轮模型调用");
      expect(h.calls[2]!.some(m => m.role === "assistant" && m.text === LONG_HEAD)).toBe(true);
      expect(h.calls[2]!.some(m => m.text.includes(LONG_TAIL))).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 30_000);

  it("模型在写工具调用时不截断（F6）", async () => {
    const h = await harness("tool");

    try {
      h.session.startTask("对比 Ingress 和 Gateway API。", page);
      await until(() => h.calls.length === 1 && h.held.length === 1, 10_000, "第一次调用开始写工具调用");
      await h.session.steerCurrentTask(STEER, page, undefined, { rewrite: true });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(h.calls).toHaveLength(1);
      expect(h.held[0]!.aborted).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 30_000);

  it("不是侧栏文字插话时照旧排队，不截断（F7）", async () => {
    const h = await harness("text");

    try {
      h.session.startTask("对比 Ingress 和 Gateway API。", page);
      await until(() => h.calls.length === 1 && h.emitted.some(e => e.kind === "text_delta"), 10_000, "第一次调用开始写正文");
      await h.session.steerCurrentTask(STEER, page);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(h.calls).toHaveLength(1);
      expect(h.held[0]!.aborted).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 30_000);
});
