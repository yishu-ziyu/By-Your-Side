import { describe, expect, it, vi } from "vitest";
import { ConversationManager } from "../src/conversation-manager.js";
import { FetchConsentBroker } from "../src/fetch-consent.js";
import { parseClientMessage, parseServerMessage, type ServerMessage } from "../../shared/protocol.js";

const REQUEST = {
  id: "consent-default-1",
  conversationId: "default",
  runId: "run-1",
  controlVersion: 0,
  url: "https://shop.example/order",
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: "{}",
  expiresAt: Date.now() + 60_000,
};

const parse = (value: unknown): string => JSON.stringify(value);

describe("consent protocol", () => {
  it("只认形状完整的 consent_decision / consent_list", () => {
    expect(parseClientMessage(parse({ type: "consent_decision", conversationId: "default", requestId: "consent-default-1", allow: true })))
      .toMatchObject({ type: "consent_decision", allow: true });
    expect(parseClientMessage(parse({ type: "consent_decision", conversationId: "default", requestId: "consent-default-1", allow: false })))
      .toMatchObject({ type: "consent_decision", allow: false });
    expect(parseClientMessage(parse({ type: "consent_list", conversationId: "default" }))).toMatchObject({ type: "consent_list" });
    expect(parseClientMessage(parse({ type: "consent_decision", conversationId: "default", requestId: "consent-default-1", allow: "yes" }))).toBeNull();
    expect(parseClientMessage(parse({ type: "consent_decision", conversationId: "default", allow: true }))).toBeNull();
    expect(parseClientMessage(parse({ type: "consent_decision", conversationId: "default", requestId: "", allow: true }))).toBeNull();
    expect(parseClientMessage(parse({ type: "consent_list", conversationId: "../escape" }))).toBeNull();
  });

  it("严格校验 consent_request / consent_result / consent_list", () => {
    expect(parseServerMessage(parse({ type: "consent_request", conversationId: "default", request: REQUEST })))
      .toMatchObject({ type: "consent_request" });
    expect(parseServerMessage(parse({ type: "consent_request", conversationId: "default", request: { ...REQUEST, method: "PUT" } }))).toBeNull();
    expect(parseServerMessage(parse({ type: "consent_request", conversationId: "default", request: { ...REQUEST, controlVersion: -1 } }))).toBeNull();
    expect(parseServerMessage(parse({ type: "consent_request", conversationId: "default", request: { ...REQUEST, body: "x".repeat(65_537) } }))).toBeNull();
    // 跨会话展示不放行
    expect(parseServerMessage(parse({ type: "consent_request", conversationId: "other", request: REQUEST }))).toBeNull();
    expect(parseServerMessage(parse({ type: "consent_result", conversationId: "default", requestId: "consent-default-1", status: "allowed", message: "已允许本次请求。" })))
      .toMatchObject({ type: "consent_result", status: "allowed" });
    for (const status of ["rejected", "expired", "cancelled"]) {
      expect(parseServerMessage(parse({ type: "consent_result", conversationId: "default", requestId: "r", status, message: "未发送。" }))).toMatchObject({ status });
    }
    expect(parseServerMessage(parse({ type: "consent_result", conversationId: "default", requestId: "r", status: "sent", message: "已发送。" }))).toBeNull();
    expect(parseServerMessage(parse({ type: "consent_result", conversationId: "default", requestId: "r", status: "allowed", message: "" }))).toBeNull();
    expect(parseServerMessage(parse({ type: "consent_list", conversationId: "default", requests: [REQUEST] })))
      .toMatchObject({ type: "consent_list" });
    expect(parseServerMessage(parse({ type: "consent_list", conversationId: "default", requests: [REQUEST, { ...REQUEST, url: "" }] }))).toBeNull();
    expect(parseServerMessage(parse({ type: "consent_list", conversationId: "default", requests: REQUEST }))).toBeNull();
  });
});

const ORDER = { url: "https://shop.example/order", method: "POST", body: "{}" };

function managerHarness() {
  const emitted: ServerMessage[] = [];
  const brokers = new Map<string, FetchConsentBroker>();
  const sessions = new Map<string, { streaming: boolean; emit: (message: ServerMessage) => void }>();
  const factory = async (id: string, emit: (message: ServerMessage) => void) => {
    const consent = new FetchConsentBroker({ conversationId: id, emit });
    brokers.set(id, consent);
    const state = { streaming: false };
    sessions.set(id, { get streaming() { return state.streaming; }, set streaming(value: boolean) { state.streaming = value; }, emit });
    return {
      consent,
      session: {
        modelName: () => "test/model", availableModels: async () => [], available: true,
        isHeld: () => false, isStreaming: () => state.streaming, abort: vi.fn(), startTask: vi.fn(),
        steerCurrentTask: vi.fn(async () => {}),
        persistTaskResults: () => {}, readPersistedTaskResults: () => null,
      },
      fleet: { teamView: () => null, isGroupHeld: () => false, abortTeam: vi.fn(), reset: vi.fn(), list: () => [] },
      rpc: { rejectAll: vi.fn() },
      dispose: vi.fn(),
      handleMessage: vi.fn(),
    };
  };
  return {
    manager: new ConversationManager(factory as never, (message) => emitted.push(message)),
    emitted,
    brokers,
    sessions,
  };
}

describe("conversation manager consent routing", () => {
  it("按会话转发 decision/list，别的会话的 id 放行不了", async () => {
    const { manager, emitted, brokers } = managerHarness();
    await manager.ensureDefault();
    await manager.handleMessage({ type: "user_message", text: "把订单提交了" });
    const waiting = brokers.get("default")!.request(ORDER);
    await vi.waitFor(() => expect(brokers.get("default")!.list()).toHaveLength(1));
    await manager.handleMessage({ type: "consent_list" });
    const list = emitted.filter((message) => message.type === "consent_list").at(-1) as Extract<ServerMessage, { type: "consent_list" }>;
    expect(list.conversationId).toBe("default");
    expect(list.requests).toHaveLength(1);
    const id = list.requests[0]!.id;
    await manager.handleMessage({ type: "conversation_create", requestId: "other" });
    const other = manager.list().find((summary) => summary.id !== "default")!.id;
    await manager.handleMessage({ type: "consent_decision", conversationId: other, requestId: id, allow: true });
    expect(brokers.get("default")!.list()).toHaveLength(1);
    await manager.handleMessage({ type: "consent_decision", requestId: id, allow: true });
    await expect(waiting).resolves.toMatchObject({ allowed: true });
    expect(emitted.filter((message) => message.type === "consent_result").at(-1))
      .toMatchObject({ status: "allowed", message: "已允许本次请求。" });
  });

  it("接管、改需求、换任务、终止、断线都会作废等待中的请求", async () => {
    const { manager, emitted, brokers, sessions } = managerHarness();
    await manager.ensureDefault();
    await manager.handleMessage({ type: "user_message", text: "把订单提交了" });
    const broker = brokers.get("default")!;
    const runtime = sessions.get("default")!;
    // 返回对象而不是 promise：async 函数直接 return 一个 thenable 会被摊平，变成等确认结果。
    const start = async () => {
      const promise = broker.request(ORDER);
      await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
      return { promise };
    };
    const cancelled = async (promise: Promise<unknown>) => {
      await expect(promise).resolves.toMatchObject({ allowed: false });
      expect(emitted.filter((message) => message.type === "consent_result").at(-1)).toMatchObject({ status: "cancelled" });
    };

    const { promise: take } = await start();
    await manager.handleMessage({ type: "takeover", requestId: "t1" });
    await cancelled(take);

    const { promise: steer } = await start();
    await manager.handleMessage({ type: "steer", text: "改成先别提交" });
    await cancelled(steer);

    // 真正跑起来的任务上被接受的修改：作废等待中的请求。
    runtime.streaming = true;
    runtime.emit({ type: "status", state: "running" });
    const { promise: planned } = await start();
    await manager.handleMessage({
      type: "task_action",
      request: {
        requestId: "s1", conversationId: "default", source: "text", action: "steer",
        expectedRunId: manager.getTaskProgress("default")!.runId ?? null, text: "改成先别提交",
      },
    });
    await cancelled(planned);

    // 换任务：交给空闲的原 run 之后启动新任务，才作废等待中的请求。
    runtime.streaming = false;
    runtime.emit({ type: "status", state: "idle" });
    const { promise: next } = await start();
    await manager.handleMessage({
      type: "task_action",
      request: { requestId: "n1", conversationId: "default", source: "text", action: "start", expectedRunId: manager.getTaskProgress("default")!.runId ?? null, text: "换个任务" },
    });
    await cancelled(next);

    const { promise: offline } = await start();
    manager.disconnect();
    await cancelled(offline);
  });

  it("面板重开时回放仍在等待的授权卡片", async () => {
    const { manager, emitted, brokers } = managerHarness();
    await manager.ensureDefault();
    await manager.handleMessage({ type: "user_message", text: "把订单提交了" });
    const waiting = brokers.get("default")!.request(ORDER);
    await vi.waitFor(() => expect(brokers.get("default")!.list()).toHaveLength(1));
    const replayed: ServerMessage[] = [];
    manager.replayState((message) => replayed.push(message));
    const list = replayed.find((message) => message.type === "consent_list") as Extract<ServerMessage, { type: "consent_list" }>;
    expect(list.conversationId).toBe("default");
    expect(list.requests).toHaveLength(1);
    expect(emitted.some((message) => message.type === "consent_request")).toBe(true);
    await manager.handleMessage({ type: "consent_decision", requestId: list.requests[0]!.id, allow: false });
    await expect(waiting).resolves.toMatchObject({ allowed: false });
  });
});
