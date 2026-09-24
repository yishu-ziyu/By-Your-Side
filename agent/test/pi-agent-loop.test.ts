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
