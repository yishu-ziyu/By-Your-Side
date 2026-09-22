/**
 * 新任务首轮"当前页预观察"要走一次 snapshot 工具帧。扩展侧 executeToolCall
 * （extension/src/background/index.ts）用 conversationSummaries.runId 校验每个工具帧：
 * runId 与最近发布的身份不一致就直接拒绝（"原任务已停止或发生变化，操作未执行。"）。
 * 这里复刻那道闸门，验证真实装配的帧次序：新任务的预观察 snapshot 到达扩展之前，
 * 新 runId 必须已经通过 conversation_updated 发布；旧 run / 已中止 run 仍被拒；
 * 运行中插话及交还请求不额外更换或发布任务身份。
 */
import { describe, expect, it, vi } from "vitest";
import { ConversationManager } from "../src/conversation-manager.js";
import type { ClientMessage, PageContext, ServerMessage } from "../../shared/protocol.js";

const CONVERSATION_ID = "default";
const TAB_ID = 77;
const IDENTITY_ERROR = "原任务已停止或发生变化，操作未执行。";

function pageContext(): PageContext {
  return { tabId: TAB_ID, title: "模拟测试页面", url: "http://127.0.0.1:48765/?scenario=a" };
}

/** 扩展侧身份闸门的等价复刻：conversationSummaries + abortedRuns + executeToolCall 校验。 */
function extensionGate() {
  let published: string | null | undefined;
  const aborted = new Set<string>();
  const rejections: string[] = [];
  return {
    apply(message: ServerMessage): void {
      if (message.type === "conversation_list") {
        published = message.conversations.find((c) => c.id === CONVERSATION_ID)?.runId;
        return;
      }
      if ((message.type === "conversation_updated" || message.type === "conversation_created")
        && message.conversationId === CONVERSATION_ID) {
        published = message.conversation.runId;
      }
    },
    /** 扩展收到中止时把当前发布的 runId 记进 abortedRuns（index.ts handleAbort）。 */
    noteAbort(): void {
      if (published) aborted.add(published);
    },
    /** 与 executeToolCall 的 checkIdentity() 同一判定。 */
    checkToolCall(message: ServerMessage): string | null {
      const runId = (message as { runId?: string | null }).runId;
      if (runId && (aborted.has(runId) || published !== runId)) {
        rejections.push(IDENTITY_ERROR);
        return IDENTITY_ERROR;
      }
      return null;
    },
    get publishedRunId(): string | null | undefined {
      return published;
    },
    rejections,
  };
}

/**
 * 生产装配的最小复刻：工厂里的 emit 就是 ConversationManager 的会话回调，
 * 工具帧因此和真实一致地带上前进后的 runId 发往扩展。
 */
function harness() {
  const emitted: ServerMessage[] = [];
  const gate = extensionGate();
  let streaming = false;
  let emitFrame: (message: ServerMessage) => void = () => {};

  const factory = async (_id: string, emit: (message: ServerMessage) => void) => {
    emitFrame = emit;
    const session = {
      modelName: () => "test/model",
      available: true,
      isHeld: () => false,
      isStreaming: () => streaming,
      /** 生产次序：sendUserMessage 先做首轮预观察（snapshot 帧），再进模型轮次。 */
      sendUserMessage: (_text: string, context?: PageContext) => {
        if (context && typeof context.tabId === "number") {
          emit({ type: "tool_call", id: `snapshot-${context.tabId}`, name: "snapshot", params: { tabId: context.tabId } });
        }
        streaming = true;
        emit({ type: "agent_event", event: { kind: "agent_start" } });
        emit({ type: "status", state: "running" });
      },
      startTask: (text: string, context?: PageContext) => session.sendUserMessage(text, context),
      steerCurrentTask: async (_text: string, context?: PageContext) => {
        if (context && typeof context.tabId === "number") {
          emit({ type: "tool_call", id: `snapshot-steer-${context.tabId}`, name: "snapshot", params: { tabId: context.tabId } });
        }
      },
      abort: vi.fn(async () => {
        streaming = false;
      }),
    };
    const runtime = {
      session,
      fleet: { reset: vi.fn(), setTabCoordinator: vi.fn(), list: () => [], get: () => undefined, bindConversationContext: vi.fn() },
      dispose: vi.fn(),
      handleMessage: (message: ClientMessage) => {
        if (message.type === "user_message") {
          if (streaming) emit({ type: "tool_call", id: `snapshot-steer-${TAB_ID}`, name: "snapshot", params: { tabId: TAB_ID } });
          else session.sendUserMessage(message.text, message.context);
        }
        if (message.type === "steer") void session.steerCurrentTask(message.text, message.context).catch(() => {});
        if (message.type === "abort") void session.abort();
      },
    };
    return runtime as never;
  };

  const manager = new ConversationManager(factory as never, (message) => {
    emitted.push(message);
    gate.apply(message);
    if (message.type === "tool_call") gate.checkToolCall(message);
  });
  return {
    manager,
    emitted,
    gate,
    emitFrame: (message: ServerMessage) => emitFrame(message),
    setStreaming: (value: boolean) => { streaming = value; },
    frames: () => emitted.filter((m): m is Extract<ServerMessage, { type: "tool_call" }> => m.type === "tool_call"),
  };
}

describe("新任务预观察的身份次序", () => {
  it("首轮 snapshot 到达扩展之前，新 runId 已经发布", async () => {
    const h = harness();
    await h.manager.ensureDefault();
    await h.manager.handleMessage({ type: "user_message", text: "只把姓名填成验收甲，其他不变", context: pageContext() });

    const snapshot = h.frames().find((f) => f.name === "snapshot");
    expect(snapshot).toBeDefined();
    const runId = h.manager.getTaskProgress(CONVERSATION_ID)!.runId;
    expect(snapshot!.runId).toBe(runId);

    const publishedIndex = h.emitted.findIndex(
      (m) => m.type === "conversation_updated" && m.conversation.runId === runId,
    );
    expect(publishedIndex).toBeGreaterThanOrEqual(0);
    expect(publishedIndex).toBeLessThan(h.emitted.findIndex((m) => m.type === "tool_call" && m.name === "snapshot"));
    expect(h.gate.rejections).toEqual([]);
  });

  it("task_action start 在首个预观察之前发布身份", async () => {
    const h = harness();
    await h.manager.ensureDefault();
    const receipt = await h.manager.dispatchTaskAction({
      requestId: "pre-observe-start", conversationId: CONVERSATION_ID,
      source: "text", action: "start", expectedRunId: null,
      text: "只填姓名", context: pageContext(),
    });
    expect(receipt.status).toBe("accepted");
    const frame = h.frames().find(f => f.name === "snapshot")!;
    expect(frame).toBeDefined();
    const published = h.emitted.findIndex(m => m.type === "conversation_updated" && m.conversation.runId === frame.runId);
    expect(published).toBeGreaterThanOrEqual(0);
    expect(published).toBeLessThan(h.emitted.indexOf(frame));
    expect(h.gate.rejections).toEqual([]);
  });

  it("中止后的新任务先发布新身份；旧 run 的工具帧仍被拒", async () => {
    const h = harness();
    await h.manager.ensureDefault();
    await h.manager.handleMessage({ type: "user_message", text: "第一个任务", context: pageContext() });
    const firstRun = h.manager.getTaskProgress(CONVERSATION_ID)!.runId;
    expect(h.gate.publishedRunId).toBe(firstRun);

    h.gate.noteAbort();
    h.setStreaming(false);
    await h.manager.handleMessage({ type: "abort", conversationId: CONVERSATION_ID });
    await h.manager.handleMessage({ type: "user_message", text: "只把姓名填成验收甲", context: pageContext() });

    const secondRun = h.manager.getTaskProgress(CONVERSATION_ID)!.runId;
    expect(secondRun).not.toBe(firstRun);
    expect(h.gate.publishedRunId).toBe(secondRun);
    expect(h.gate.rejections).toEqual([]);

    // 旧身份的工具帧（例如上一任务迟到的一步）仍按原身份被扩展拒绝。
    h.emitFrame({ type: "tool_call", id: "late-old-run", name: "snapshot", params: { tabId: TAB_ID }, runId: firstRun });
    const late = h.emitted.at(-1);
    expect(late).toMatchObject({ type: "tool_call", runId: firstRun });
    expect(h.gate.checkToolCall(late!)).toBe(IDENTITY_ERROR);
    expect(h.manager.getTaskProgress(CONVERSATION_ID)!.runId).toBe(secondRun);
  });

  it("运行中插话及交还请求不额外更换或发布任务身份", async () => {
    const h = harness();
    await h.manager.ensureDefault();
    await h.manager.handleMessage({ type: "user_message", text: "第一个任务", context: pageContext() });
    const runId = h.manager.getTaskProgress(CONVERSATION_ID)!.runId;
    const publishedUpdates = () => h.emitted.filter((m) => m.type === "conversation_updated").length;
    const before = publishedUpdates();

    await h.manager.handleMessage({ type: "steer", conversationId: CONVERSATION_ID, text: "预算改 600", context: pageContext() });
    await h.manager.handleMessage({ type: "handback", conversationId: CONVERSATION_ID, requestId: "handback-1" });

    expect(h.manager.getTaskProgress(CONVERSATION_ID)!.runId).toBe(runId);
    expect(h.gate.publishedRunId).toBe(runId);
    expect(h.gate.rejections).toEqual([]);
    // 插话/交还只是原任务的新输入，不得借机发布新身份或重发会话摘要。
    expect(publishedUpdates()).toBe(before);

    // 交还之后同一个 run 的工具帧仍按已发布身份通过。
    h.emitFrame({ type: "tool_call", id: "after-handback", name: "snapshot", params: { tabId: TAB_ID } });
    expect(h.gate.rejections).toEqual([]);
    expect(h.frames().at(-1)!.runId).toBe(runId);
  });

  it("已中止任务：直连 display 帧不携带已中止身份（新语音请求不被连坐），任务帧仍按原身份被拒", async () => {
    const h = harness();
    await h.manager.ensureDefault();
    await h.manager.handleMessage({ type: "user_message", text: "第一个任务", context: pageContext() });
    const run = h.manager.getTaskProgress(CONVERSATION_ID)!.runId;
    h.gate.noteAbort();
    h.setStreaming(false);
    // SAFETY: 测试直接驱动会话内部的 TaskProgress 构造“已中止”状态（生产由用户停止达成）。
    (h.manager as unknown as { progress: Map<string, { abort(): void }> }).progress.get(CONVERSATION_ID)!.abort();
    expect(h.manager.getTaskProgress(CONVERSATION_ID)!.state).toBe("aborted");

    // 新的直连用户请求（display-* 帧）：不附着已中止 runId，不被身份闸门连坐。
    h.emitFrame({ type: "tool_call", id: "display-after-stop", name: "switch_tab", params: { tabId: TAB_ID }, sdkId: "display-after-stop" });
    expect((h.emitted.at(-1) as { runId?: string | null }).runId ?? null).toBeNull();
    expect(h.gate.rejections).toEqual([]);

    // 任务族迟到帧：仍附着原身份 → 扩展按原样拒收（保住“停任务杀旧步”的原语义）。
    h.emitFrame({ type: "tool_call", id: "task-after-stop", name: "snapshot", params: { tabId: TAB_ID } });
    expect((h.emitted.at(-1) as { runId?: string | null }).runId).toBe(run);
    expect(h.gate.rejections).toEqual([IDENTITY_ERROR]);
  });
});
