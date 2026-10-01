// 扩展里的循环必须把 agent_settled 等生命周期事件交给 pi.on 注册的钩子，与 Pi 原生路径一致。
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ModelPort } from "../src/agent-loop.js";
import { PiAgentLoop } from "../src/pi-agent-loop.js";

const model: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024,
};

function reply(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "text", text: "好" }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };

  if (errorMessage) message.errorMessage = errorMessage;

  return message;
}

function scripted(replies: AssistantMessage[]): ModelPort {
  let calls = 0;

  return {
    getModel: () => model,
    getAvailable: async () => [model],
    completeSimple: async () => { throw new Error("不调用"); },
    streamSimple: () => {
      const message = replies[Math.min(calls, replies.length - 1)]!;
      calls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: "stop", message });
      });

      return stream;
    },
  };
}

function recorder(log: string[]): ExtensionFactory {
  // SAFETY: 测试钩子只调用 on，事件名与真实钩子相同。
  return (pi => {
    for (const name of ["agent_end", "agent_settled"]) {
      const handler = async () => { await Promise.resolve(); log.push(name); };
      // SAFETY: 事件名与处理函数形状同真实钩子，只调用 on。

      pi.on(name as never, handler as never);
    }
  }) as ExtensionFactory;
}

describe("扩展循环转发生命周期钩子", () => {
  it("agent_settled 钩子在一轮结束后恰好触发一次，且在 agent_end 之后", async () => {
    const log: string[] = [];
    const loop = new PiAgentLoop({ models: scripted([reply("stop")]), model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [recorder(log)] });

    await loop.prompt("做点什么");

    expect(log).toEqual(["agent_end", "agent_settled"]);
  });

  it("重试等待期间不触发 agent_settled，重试结束后才触发一次", async () => {
    const log: string[] = [];
    const loop = new PiAgentLoop({ models: scripted([reply("error", "500 internal server error"), reply("stop")]), model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [recorder(log)], retry: { maxRetries: 3, baseDelayMs: 1 } });

    await loop.prompt("做点什么");

    expect(log.filter(name => name === "agent_settled")).toHaveLength(1);
    expect(log.at(-1)).toBe("agent_settled");
  });
});

describe("钩子慢或卡住时不拖住循环", () => {
  function stuck(log: string[]): ExtensionFactory {
    const onEnd = async () => { log.push("agent_end"); };

    const onSettled = () => {
      log.push("agent_settled");

      return new Promise<void>(() => {});
    };

    // SAFETY: 返回的函数只接收 pi 并调用 on，与 ExtensionFactory 的调用方式一致。
    return (pi => {
      // SAFETY: 事件名与处理函数形状同真实钩子，只调用 on。
      pi.on("agent_end" as never, onEnd as never);

      // SAFETY: 同上。
      pi.on("agent_settled" as never, onSettled as never);
    }) as ExtensionFactory;
  }

  it("agent_settled 钩子永不返回时，prompt 与 abort 照常完成，先后仍是 agent_end → agent_settled", async () => {
    const log: string[] = [];
    const loop = new PiAgentLoop({ models: scripted([reply("stop")]), model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [stuck(log)] });

    await loop.prompt("第一轮");
    await loop.abort();
    await loop.prompt("第二轮");
    await loop.abort();
    await Promise.resolve();

    expect(log).toEqual(["agent_end", "agent_settled"]);
  });

  it("abort 等到自己这一轮结束，不被别的轮次提前放行", async () => {
    const loop = new PiAgentLoop({ models: scripted([reply("stop")]), model, tools: [], systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [] });
    const running = loop.prompt("第一轮");
    await loop.abort();

    expect(loop.isStreaming).toBe(false);
    await running;
    await loop.prompt("第二轮");
    await loop.abort();

    expect(loop.isStreaming).toBe(false);
  });
});
