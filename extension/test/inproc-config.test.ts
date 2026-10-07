/**
 * 扩展内 agent 与设置页配置的先后顺序。
 *
 * 1. 设置页先存 A 再存 B（提示「侧栏接下来的任务会使用 B」），新建对话的任务必须调用 B。
 *    可能的失败：核心按第一次收到的配置记住默认模型，只更新已有对话。
 * 2. 首次使用：侧栏打开就发了新建会话，这时还没配置模型；侧栏 4 秒没回执就留在默认会话。
 *    配好模型后马上发的第一句话必须在默认会话里得到回答。
 *    可能的失败：配好后补建那条早先的新建会话，侧栏被切到空会话，第一句话的回答被挤到后台（2026-10-07 实测）。
 * 判据只看协议上可见的结果（调用了哪个模型、有没有 conversation_created），不看实现路径。
 */
import { SessionLog } from "../../agent/src/session-log.js";
import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";

const base = {
  api: "switch-probe", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024,
};

/** 侧栏协议消息，加上 background 推给 offscreen 的模型配置。 */
type Inbound = ClientMessage | { type: "inproc_config"; config: { provider: string; modelId: string }; credentials: Record<string, never> };

type Probe = typeof base & { provider: string; id: string; name: string };

const probe = (provider: string, id: string): Probe => ({ ...base, provider, id, name: `${provider}/${id}` });

function reply(model: Probe) {
  const message = {
    role: "assistant", content: [{ type: "text", text: "好了。" }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };

  const events = [{ type: "start", partial: message }, { type: "done", reason: "stop", message }];

  return {
    async *[Symbol.asyncIterator]() { yield* events; },
    result: async () => message,
  };
}

async function until<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 8000): Promise<T> {
  const started = Date.now();

  for (;;) {
    const value = read();

    if (value) return value;

    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function startHost() {
  return import("../src/inproc/browser-host.js").then(({ startInprocHost }) => {
    const frames: ServerMessage[] = [];
    const called: string[] = [];
    let onMessage: ((message: Inbound) => void) | null = null;
    const send = (message: Inbound) => onMessage?.(message);

    const port = {
      name: "inproc-host",
      postMessage: (frame: ServerMessage) => frames.push(frame),
      onMessage: { addListener: (listener: (message: Inbound) => void) => { onMessage = listener; } },
      onDisconnect: { addListener: () => {} },
    };

    const stream = (model: Probe) => {
      called.push(`${model.provider}/${model.id}`);

      return reply(model);
    };

    const runtime = {
      sessionId: "switch", headersFor: () => undefined,
      resolveModel: (config: { provider: string; modelId: string }) => probe(config.provider, config.modelId),
      createCoreModels: () => ({
        getModel: (provider: string, id: string) => probe(provider, id),
        getAvailable: async () => [probe("vendor-a", "model-a"), probe("vendor-b", "model-b")],
        streamSimple: stream,
        completeSimple: async (model: Probe) => stream(model).result(),
      }),
      credentials: { load: async () => {} },
    };

    // SAFETY: browser-host 只用到 runtime 的这些成员和端口的 name / postMessage / onMessage / onDisconnect。
    startInprocHost({ sessionData: async id => ({session:SessionLog.load(SessionLog.header(id, 0), async () => {}).log}), createRuntime: () => runtime as never, onConnect: listener => listener(port as never) });

    const configure = (provider: string, modelId: string) => send({ type: "inproc_config", config: { provider, modelId }, credentials: {} });

    const created = (requestId: string) => frames.find((f): f is Extract<ServerMessage, { type: "conversation_created" }> => f.type === "conversation_created" && f.requestId === requestId);

    return { frames, called, send, configure, created };
  });
}

describe("扩展内 agent 的模型配置", () => {
  it("设置页从 A 换成 B 后，新建对话的任务调用 B", async () => {
    const host = await startHost();
    host.send({ type: "hello", token: "", client: "sidepanel" });
    host.configure("vendor-a", "model-a");
    await until(() => host.frames.some(f => f.type === "hello_ok"), "核心按 A 启动");
    host.configure("vendor-b", "model-b");

    host.send({ type: "conversation_create", requestId: "new-1" });
    const conversationId = (await until(() => host.created("new-1"), "新对话建好")).conversation.id;
    host.send({
      type: "task_action", conversationId,
      request: { requestId: "task-1", conversationId, source: "text", action: "start", expectedRunId: null, text: "你好" },
    });
    await until(() => host.called.length > 0, "任务调用模型");

    expect(host.called[0]).toBe("vendor-b/model-b");
  }, 20_000);

  it("配置模型前发出的新建会话，配好后不再补建；第一句话在默认会话里得到回答", async () => {
    const host = await startHost();
    host.send({ type: "hello", token: "", client: "sidepanel" });
    host.send({ type: "conversation_create", requestId: "early-1" });
    await new Promise(resolve => setTimeout(resolve, 50));
    host.configure("vendor-a", "model-a");
    host.send({
      type: "task_action", conversationId: "default",
      request: { requestId: "task-1", conversationId: "default", source: "text", action: "start", expectedRunId: null, text: "你好" },
    });
    await until(() => host.called.length > 0, "第一句话调用模型");
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(host.called[0]).toBe("vendor-a/model-a");
    expect(host.frames.some(f => f.type === "conversation_created")).toBe(false);
  }, 20_000);
});
