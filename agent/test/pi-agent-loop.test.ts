// 扩展循环自己实现了 Pi 的自动重试：可重试的模型错误按次数与退避重试，成功后发出 auto_retry_end。
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelPort } from "../src/agent-loop.js";
import { PiAgentLoop } from "../src/pi-agent-loop.js";

const model: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024,
};

function reply(stopReason: AssistantMessage["stopReason"], text: string, errorMessage?: string): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };

  if (errorMessage) message.errorMessage = errorMessage;

  return message;
}

/** 依次给出预设的回复；每次调用都是一条完整的流。 */
function scripted(replies: AssistantMessage[]): ModelPort & { calls: number } {
  const port: ModelPort & { calls: number } = {
    calls: 0,
    getModel: () => model,
    getAvailable: async () => [model],
    completeSimple: async () => { throw new Error("这些用例不调用 completeSimple"); },
    streamSimple: () => {
      const message = replies[Math.min(port.calls, replies.length - 1)]!;
      port.calls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: "stop", message });
      });

      return stream;
    },
  };

  return port;
}

describe("扩展循环的自动重试", () => {
  it("可重试的错误重试后成功，并发出开始与成功结束事件", async () => {
    const models = scripted([reply("error", "", "500 internal server error"), reply("stop", "好了")]);
    const loop = new PiAgentLoop({ models, model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [], retry: { maxRetries: 3, baseDelayMs: 1 } });
    const events: string[] = [];
    loop.subscribe(event => { if (event.type === "auto_retry_start" || event.type === "auto_retry_end") events.push(`${event.type}:${"success" in event ? event.success : event.attempt}`); });

    await loop.prompt("做点什么");

    expect(models.calls).toBe(2);
    expect(events).toEqual(["auto_retry_start:1", "auto_retry_end:true"]);
    const last = loop.agent.state.messages.at(-1);
    expect(last?.role === "assistant" && last.stopReason).toBe("stop");
  });

  it("不可重试的错误不重试", async () => {
    const models = scripted([reply("error", "", "invalid api key"), reply("stop", "不该到这里")]);
    const loop = new PiAgentLoop({ models, model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [], retry: { maxRetries: 3, baseDelayMs: 1 } });

    await loop.prompt("做点什么");

    expect(models.calls).toBe(1);
  });

  it("重试用尽后停止，并发出失败结束事件", async () => {
    const models = scripted([reply("error", "", "503 service unavailable")]);
    const loop = new PiAgentLoop({ models, model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [], retry: { maxRetries: 2, baseDelayMs: 1 } });
    const ends: boolean[] = [];
    loop.subscribe(event => { if (event.type === "auto_retry_end") ends.push(event.success); });

    await loop.prompt("做点什么");

    expect(models.calls).toBe(3);
    expect(ends).toEqual([false]);
  });
});

// YIS-92：模型在工具参数里无休止地写空白，这一轮不该挂在「正在思考」，应取消并重来。
// 失败方式：守卫不触发（用例超时）；触发了但不重试（只调一次）；正常参数里的一段空白被误判（多调一次）。
describe("工具参数写跑了", () => {
  /** 第一次：开始写一个工具调用，然后每 1 ms 送 64 个空格直到被取消；之后：按 replies 给完整回复。 */
  function runaway(blankChunks: number, after: AssistantMessage): ModelPort & { calls: number } {
    const port: ModelPort & { calls: number } = {
      calls: 0,
      getModel: () => model,
      getAvailable: async () => [model],
      completeSimple: async () => { throw new Error("这些用例不调用 completeSimple"); },
      streamSimple: (_model, _context, options) => {
        port.calls += 1;
        const stream = createAssistantMessageEventStream();

        if (port.calls > 1) {
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: after }));

          return stream;
        }

        const partial = reply("toolUse", "");
        partial.content = [{ type: "toolCall", id: "c1", name: "user_memory", arguments: {} }];
        stream.push({ type: "start", partial });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"action":"change","query":"x","', partial });
        let sent = 0;

        const timer = setInterval(() => {
          if (options?.signal?.aborted || sent >= blankChunks) {
            clearInterval(timer);

            if (!options?.signal?.aborted) stream.push({ type: "done", reason: "stop", message: reply("stop", "参数里有一段空白也照常收尾") });

            return;
          }

          sent += 1;
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: " ".repeat(64), partial });
        }, 1);

        return stream;
      },
    };

    return port;
  }

  it("参数一直是空白：取消这次请求并重试，第二次正常回答", async () => {
    const models = runaway(Number.POSITIVE_INFINITY, reply("stop", "记下了"));
    const loop = new PiAgentLoop({ models, model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [], retry: { maxRetries: 3, baseDelayMs: 1 } });

    await loop.prompt("记住我的邮箱是 a@example.com");

    expect(models.calls).toBe(2);
    const last = loop.agent.state.messages.at(-1);
    expect(last?.role === "assistant" && last.content).toEqual([{ type: "text", text: "记下了" }]);
  }, 5_000);

  it("参数里一段不长的空白（128 个）不算写跑", async () => {
    const models = runaway(2, reply("stop", "不该重试"));
    const loop = new PiAgentLoop({ models, model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [], retry: { maxRetries: 3, baseDelayMs: 1 } });

    await loop.prompt("做点什么");

    expect(models.calls).toBe(1);
  });
});
