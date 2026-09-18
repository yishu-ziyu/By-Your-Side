import { describe, expect, it, vi } from "vitest";
import { BrowserAgentSession, runProducedNothing } from "../src/session.js";
import {createUserDelivery,toolDeliveryId} from '../src/user-delivery.js';

// 这些用例用合成会话驱动真实 SDK 事件形状，不落用户轨迹（与 session-helpers.test.ts 同一约定）。
vi.mock("../src/run-trace.js", () => ({ RunTrace: class {
  begin() {}
  record() {}
  event() {}
} }));

/** Pi assistant 消息的真实形状：content 是 text / thinking / toolCall 块，没有顶层 toolCalls 字段。 */
const toolCallBlock = (id = "t1", name = "send_user_message", args: Record<string, unknown> = {}) =>
  ({ type: "toolCall" as const, id, name, arguments: args });

function fixture(opts: { explicitDelivery?: boolean } = {}) {
  let isStreaming = true;
  let subscriber: ((event: any) => void) | null = null;
  const raw = {
    get isStreaming() {
      return isStreaming;
    },
    model: { id: "test" },
    agent: { state: { messages: [] } },
    abort: vi.fn(() => Promise.resolve()),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    subscribe: vi.fn((fn: (event: any) => void) => {
      subscriber = fn;
      return () => {};
    }),
  };
  const callbacks = { emit: vi.fn(), setStatus: vi.fn() };
  const Session = BrowserAgentSession as unknown as new (...args: any[]) => BrowserAgentSession;
  const wrapped = new Session(raw, null, callbacks, null, null);
  (wrapped as any).explicitDelivery = !!opts.explicitDelivery;
  (wrapped as any).subscribeEvents();
  const event = (e: any) => subscriber?.(e);
  const notices = () => callbacks.emit.mock.calls
    .map(([e]) => e as { kind: string; message?: string })
    .filter(e => e.kind === "notice" || e.kind === "error")
    .map(e => e.message ?? "");
  /** 合成成功交付的完整事件顺序：参数生成、工具开始、校验后的正式交付、工具成功。 */
  const deliver = (id: string, kind: "finding" | "ack", content: string) => {
    event({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        partial: { content: [toolCallBlock(id, "send_user_message", { kind, content })] },
      },
    });
    event({ type: "tool_execution_start", toolCallId: id, toolName: "send_user_message", args: { kind, content } });
    (wrapped as any).emitValidatedDelivery({kind:'user_delivery',delivery:createUserDelivery({conversationId:'default',runId:'run-fixture',id:toolDeliveryId(id),kind,text:content})});
    event({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "send_user_message",
      isError: false,
      result: { content: [{ type: "text", text: `delivered:${id}` }] },
    });
  };
  return {
    wrapped,
    raw,
    callbacks,
    event,
    notices,
    deliver,
    setStreaming: (value: boolean) => {
      isStreaming = value;
    },
  };
}

describe("交付后的收尾不再误报空响应", () => {
  it("有效 finding 交付后的空尾收尾轮不再提示模型空响应", () => {
    const h = fixture({ explicitDelivery: true });
    h.deliver("t1", "finding", "岗位是前端开发，城市上海。");
    h.event({ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false });

    expect(h.callbacks.emit).toHaveBeenCalledWith({
      kind: "user_delivery_stream",
      stream: expect.objectContaining({ phase: "streaming", text: "岗位是前端开发，城市上海。" }),
    });
    expect(h.notices().filter(m => m.includes("空响应"))).toEqual([]);
  });

  it("含 toolCall 块的收尾轮不算无输出（真实 content 形状）", () => {
    expect(runProducedNothing([
      { role: "assistant", content: [toolCallBlock("t1", "browser_run", {})] },
    ])).toBe(false);
    expect(runProducedNothing([
      { role: "assistant", content: [{ type: "thinking", thinking: "先读页面" }, toolCallBlock("t2", "snapshot", {})] },
    ])).toBe(false);
  });

  it("只有流式预览、交付工具失败时仍报告空尾与重试", () => {
    const h = fixture({ explicitDelivery: true });
    h.event({ type: "message_update", assistantMessageEvent: {
      type: "toolcall_delta", contentIndex: 0,
      partial: { content: [toolCallBlock("preview", "send_user_message", { kind: "finding", content: "尚未获准的回答" })] },
    }});
    h.event({ type: "tool_execution_start", toolCallId: "preview", toolName: "send_user_message", args: { kind: "finding" } });
    h.event({ type: "tool_execution_end", toolCallId: "preview", toolName: "send_user_message", isError: true, result: { content: [] } });
    h.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
    h.event({ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false });
    expect(h.notices().some(m => m.includes("正在重试"))).toBe(true);
    expect(h.notices().some(m => m.includes("空响应"))).toBe(true);
  });

  it.each(["ack", "failed-delivery", "snapshot"])("%s 工具消息留在收尾历史里也不替代正式交付", kind => {
    const h = fixture({ explicitDelivery: true });
    if (kind === "ack") h.deliver("only", "ack", "收到");
    else {
      const name = kind === "snapshot" ? "snapshot" : "send_user_message";
      h.event({ type: "tool_execution_start", toolCallId: "only", toolName: name, args: { kind: "finding" } });
      h.event({ type: "tool_execution_end", toolCallId: "only", toolName: name, isError: kind !== "snapshot", result: { content: [] } });
    }
    h.event({ type: "agent_end", willRetry: false, messages: [
      { role: "assistant", content: [toolCallBlock("only", kind === "snapshot" ? "snapshot" : "send_user_message", {kind: kind === "ack" ? "ack" : "finding"})] },
      { role: "assistant", content: [] },
    ] });
    expect(h.notices().some(m => m.includes("空响应"))).toBe(true);
  });

  it("纯 ack 不算最终交付，空尾仍要提示空响应", () => {
    const h = fixture({ explicitDelivery: true });
    h.deliver("t1", "ack", "收到，我马上去看这页。");
    h.event({ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false });

    expect(h.notices().filter(m => m.includes("空响应"))).toHaveLength(1);
  });

  it("工具连续失败已交付失败结论时，不再叠加空响应提示", () => {
    const h = fixture({ explicitDelivery: true });
    (h.wrapped as any).pendingToolFailure = {
      conversationId: "default",
      id: "fail-1",
      runId: "run-1",
      kind: "finding",
      text: "工具「click」连续三次返回相同错误，已停止重试。这一步没有完成。",
      composedAt: 1,
      status: "composed",
    };
    h.event({ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false });

    expect(h.callbacks.emit).toHaveBeenCalledWith({
      kind: "user_delivery",
      delivery: expect.objectContaining({ id: "fail-1" }),
    });
    expect(h.notices().filter(m => m.includes("空响应"))).toEqual([]);
  });
});

describe("真正无输出与真实最终失败仍然可见", () => {
  it("没有任何交付的空轮仍提示空响应", () => {
    const h = fixture({ explicitDelivery: true });
    h.event({ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false });

    expect(h.notices().filter(m => m.includes("空响应"))).toHaveLength(1);
  });

  it("只写了空文本的空轮仍提示空响应", () => {
    const h = fixture({ explicitDelivery: true });
    h.event({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "   " }] }],
      willRetry: false,
    });

    expect(h.notices().filter(m => m.includes("空响应"))).toHaveLength(1);
  });

  it("真实最终失败仍报错误，且不叠加空响应", () => {
    const h = fixture({ explicitDelivery: true });
    h.event({
      type: "agent_end",
      messages: [{ role: "assistant", content: [], errorMessage: "rate limit exceeded" }],
      willRetry: false,
    });

    expect(h.notices().filter(m => m.includes("模型请求最终失败"))).toHaveLength(1);
    expect(h.notices().filter(m => m.includes("空响应"))).toEqual([]);
  });

  it("上一轮成功交付不掩盖下一轮真正无输出", () => {
    const h = fixture({ explicitDelivery: true });
    h.deliver("t1", "finding", "第一次任务的结果。");
    h.event({ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false });
    h.setStreaming(false);
    h.wrapped.sendUserMessage("再问一个新问题");

    h.event({ type: "agent_end", messages: [{ role: "assistant", content: [] }], willRetry: false });

    expect(h.notices().filter(m => m.includes("空响应"))).toHaveLength(1);
  });
});

describe("自动重试提示不过度泄露", () => {
  const retry = (attempt = 1, maxAttempts = 3) => ({
    type: "auto_retry_start",
    attempt,
    maxAttempts,
    delayMs: 1000,
    errorMessage: "rate limit exceeded",
  });

  it("未交付前自动重试仍然提示", () => {
    const h = fixture({ explicitDelivery: true });
    h.event(retry());

    expect(h.notices().filter(m => m.includes("正在重试"))).toHaveLength(1);
  });

  it("本轮已交付结果后的自动重试不再刷请求失败", () => {
    const h = fixture({ explicitDelivery: true });
    h.deliver("t1", "finding", "这一轮的结论。");
    h.event(retry());

    expect(h.notices().filter(m => m.includes("正在重试"))).toEqual([]);
  });

  it("接管期间不把自动重试说成请求失败", () => {
    const h = fixture({ explicitDelivery: true });
    h.wrapped.holdForUser();
    h.event(retry());

    expect(h.notices().filter(m => m.includes("正在重试"))).toEqual([]);
  });

  it("用户中止的尾声不提示自动重试", () => {
    const h = fixture({ explicitDelivery: true });
    h.wrapped.abort();
    h.event(retry());

    expect(h.notices().filter(m => m.includes("正在重试"))).toEqual([]);
  });
});
