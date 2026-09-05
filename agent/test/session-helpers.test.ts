import { describe, expect, it, vi } from "vitest";
import {
  AcceptanceContinuity,
  BrowserAgentSession,
  lastAssistantError,
  runProducedNothing,
  shouldSurfaceAgentEndIssue,
  withPageContext,
} from "../src/session.js";
import { handbackContinueText } from "../../shared/control.js";

function controlledBrowserSession(streaming = true) {
  let isStreaming = streaming;
  let subscriber: ((event: any) => void) | null = null;
  let settleAbort!: () => void;
  let rejectAbort!: (error: Error) => void;
  const abortPending = new Promise<void>((resolve, reject) => {
    settleAbort = () => {
      isStreaming = false;
      resolve();
    };
    rejectAbort = reject;
  });
  let rejectPrompt!: (error: Error) => void;
  const promptPending = new Promise<void>((_resolve, reject) => {
    rejectPrompt = reject;
  });
  const raw = {
    get isStreaming() {
      return isStreaming;
    },
    model: { id: "test" },
    agent: { state: { messages: [] } },
    abort: vi.fn(() => abortPending),
    prompt: vi.fn((_text: string) => promptPending),
    steer: vi.fn(async (_text: string) => {}),
    subscribe: vi.fn((fn: (event: any) => void) => {
      subscriber = fn;
      return () => {};
    }),
  };
  const Session = BrowserAgentSession as unknown as new (...args: any[]) => BrowserAgentSession;
  const callbacks = { emit: vi.fn(), setStatus: vi.fn() };
  const wrapped = new Session(raw, null, callbacks, null, null);
  (wrapped as any).subscribeEvents();
  return {
    wrapped,
    raw,
    callbacks,
    settleAbort,
    rejectAbort,
    rejectPrompt,
    setStreaming: (value: boolean) => {
      isStreaming = value;
    },
    agentStart: () => subscriber?.({ type: "agent_start" }),
  };
}

describe("BrowserAgentSession handback serialization", () => {
  it("abort 尚未 settle 时不 steer 旧流；等 idle 后只 prompt 一次", async () => {
    const { wrapped, raw, settleAbort, agentStart } = controlledBrowserSession();
    wrapped.holdForUser();

    expect(raw.abort).toHaveBeenCalledTimes(1);
    const started = wrapped.continueAfterHandback(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "HANDOFF-WORKER-20260905",
    ) as unknown as Promise<boolean>;
    expect(started).toBeInstanceOf(Promise);
    expect(raw.steer).not.toHaveBeenCalled();
    expect(raw.prompt).not.toHaveBeenCalled();

    settleAbort();
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    agentStart();
    await expect(started).resolves.toBe(true);
    expect(raw.steer).not.toHaveBeenCalled();
    expect(raw.prompt.mock.calls[0]?.[0]).toContain("HANDOFF-WORKER-20260905");
  });

  it("abort reject 时 handback 不启动且仍归 user", async () => {
    const { wrapped, raw, rejectAbort } = controlledBrowserSession();
    wrapped.holdForUser();
    const started = wrapped.continueAfterHandback(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "fresh worker page",
    ) as unknown as Promise<boolean>;

    rejectAbort(new Error("abort failed"));
    await expect(started).resolves.toBe(false);
    expect(wrapped.isHeld()).toBe(true);
    expect(raw.prompt).not.toHaveBeenCalled();
  });

  it("prompt reject 时 handback 不算 restored，并重新归 user", async () => {
    const { wrapped, raw, settleAbort, rejectPrompt } = controlledBrowserSession();
    wrapped.holdForUser();
    const started = wrapped.continueAfterHandback(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "fresh worker page",
    ) as unknown as Promise<boolean>;

    settleAbort();
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    rejectPrompt(new Error("prompt failed"));
    await expect(started).resolves.toBe(false);
    expect(wrapped.isHeld()).toBe(true);
  });

  it("交还等待期间再次接管会取消排队续跑，且不会重复 abort", async () => {
    const { wrapped, raw, settleAbort } = controlledBrowserSession();
    wrapped.holdForUser();
    const started = wrapped.continueAfterHandback(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "fresh worker page",
    ) as unknown as Promise<boolean>;

    wrapped.holdForUser();
    expect(raw.abort).toHaveBeenCalledTimes(1);
    settleAbort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(raw.prompt).not.toHaveBeenCalled();
    expect(raw.steer).not.toHaveBeenCalled();
    await expect(started).resolves.toBe(false);
  });

  it("waiting_message 接管时保留 waiter，交还时再停旧流并等待后 prompt", async () => {
    const { wrapped, raw, settleAbort, agentStart } = controlledBrowserSession();
    wrapped.holdForUser({ abortStream: false });
    expect(raw.abort).not.toHaveBeenCalled();

    const started = wrapped.continueAfterHandback(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "fresh worker page",
    ) as unknown as Promise<boolean>;
    expect(raw.abort).toHaveBeenCalledTimes(1);
    expect(raw.prompt).not.toHaveBeenCalled();

    settleAbort();
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    agentStart();
    await expect(started).resolves.toBe(true);
    expect(raw.steer).not.toHaveBeenCalled();
  });

  it("交还等待期间中止会取消排队续跑，不产生幽灵 prompt", async () => {
    const { wrapped, raw, settleAbort } = controlledBrowserSession();
    wrapped.holdForUser();
    const started = wrapped.continueAfterHandback(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "fresh worker page",
    ) as unknown as Promise<boolean>;

    wrapped.abort();
    settleAbort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(raw.abort).toHaveBeenCalledTimes(1);
    expect(raw.prompt).not.toHaveBeenCalled();
    expect(raw.steer).not.toHaveBeenCalled();
    await expect(started).resolves.toBe(false);
  });

  it("新一轮接管取消已发出的 handback prompt；迟到 agent_start 不得算 restored", async () => {
    const { wrapped, raw, settleAbort, setStreaming, agentStart, callbacks } = controlledBrowserSession();
    wrapped.holdForUser();
    const started = wrapped.continueAfterHandback(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "fresh worker page",
    );

    settleAbort();
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    setStreaming(true);
    wrapped.holdForUser();
    agentStart();

    await expect(started).resolves.toBe(false);
    expect(wrapped.isHeld()).toBe(true);
    expect(callbacks.setStatus).not.toHaveBeenCalledWith("running");
  });

  it("空闲会话交还直接 prompt 一次，重复交还不再启动第二轮", async () => {
    const { wrapped, raw, agentStart } = controlledBrowserSession(false);
    wrapped.holdForUser();
    const context = { tabId: 21, title: "Worker", url: "https://example.com/worker" };

    const started = wrapped.continueAfterHandback(context, "fresh worker page") as unknown as Promise<boolean>;
    await expect(wrapped.continueAfterHandback(context, "duplicate")).resolves.toBe(false);
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    agentStart();
    await expect(started).resolves.toBe(true);

    expect(raw.abort).not.toHaveBeenCalled();
    expect(raw.steer).not.toHaveBeenCalled();
  });
});

describe("AcceptanceContinuity", () => {
  it("同一实例只在自己的 fresh snapshot marker 出现后推进原任务 step", () => {
    const continuity = new AcceptanceContinuity("instance-worker");
    const before = continuity.seed("task-worker", "user-worker-marker");
    expect(before).toMatchObject({ instanceId: "instance-worker", taskId: "task-worker", step: "before", active: true });

    const wrong = continuity.continue(
      { tabId: 11, title: "Lead", url: "https://example.com/lead" },
      "user-lead-marker",
    );
    expect(wrong).toMatchObject({ step: "before", resumedTabId: 11, snapshotMarkerFound: false });

    const after = continuity.continue(
      { tabId: 21, title: "Worker", url: "https://example.com/worker" },
      "fresh user-worker-marker",
    );
    expect(after).toMatchObject({
      instanceId: "instance-worker",
      taskId: "task-worker",
      step: "continued",
      resumedTabId: 21,
      snapshotMarkerFound: true,
    });
  });
});

describe("withPageContext", () => {
  it("无上下文时原文返回", () => {
    expect(withPageContext("这页面是关于什么")).toBe("这页面是关于什么");
    expect(withPageContext("hi", undefined)).toBe("hi");
  });

  it("有上下文时前置页面锚点行", () => {
    const out = withPageContext("这页面是关于什么", {
      tabId: 12,
      title: "历史正在发生的地方",
      url: "https://zhuanlan.zhihu.com/p/1",
    });
    expect(out).toBe(
      '[User\'s current page: tab 12 "历史正在发生的地方" — https://zhuanlan.zhihu.com/p/1]\n这页面是关于什么',
    );
  });

  it("标题含换行时折叠为单行", () => {
    const out = withPageContext("hi", { tabId: 1, title: "第一行\n第二行", url: "https://a.b" });
    expect(out.startsWith('[User\'s current page: tab 1 "第一行 第二行" — https://a.b]\n')).toBe(true);
  });

  it("空标题回退为 (untitled)", () => {
    expect(withPageContext("hi", { tabId: 1, title: "", url: "https://a.b" })).toContain('"(untitled)"');
  });

  it("交还续写走同一当前页前缀，另附 snapshot，不是新任务口吻", () => {
    const ctx = { tabId: 9, title: "另一条", url: "https://v.flomoapp.com/mine" };
    const body = handbackContinueText(ctx, "note A");
    const wrapped = withPageContext(body, ctx);
    expect(wrapped.startsWith("[User's current page: tab 9")).toBe(true);
    expect(wrapped).toContain("note A");
    expect(wrapped).toContain("Continue the original task");
    expect(wrapped).toContain("Do not switch tabs, navigate, reload, or reopen any page");
    expect(wrapped).toContain("The CURRENT page and snapshot are authoritative");
    expect(wrapped).toContain("do not redo it");
  });

  it("steer 插话与 prompt 走同一前缀（打断后仍带当前页锚点）", () => {
    const ctx = { tabId: 7, title: "Locked", url: "https://example.com/a" };
    expect(withPageContext("先点登录", ctx)).toBe(
      '[User\'s current page: tab 7 "Locked" — https://example.com/a]\n先点登录',
    );
  });
});

describe("shouldSurfaceAgentEndIssue", () => {
  it("接管主动停止生成时不把 abort 当模型失败", () => {
    expect(shouldSurfaceAgentEndIssue(true, false)).toBe(false);
  });

  it("用户点中止后回到 idle，也不把该轮 abort 当模型失败", () => {
    expect(shouldSurfaceAgentEndIssue(false, false, true)).toBe(false);
  });

  it("正常运行最终失败仍要显示，自动重试期间不显示", () => {
    expect(shouldSurfaceAgentEndIssue(false, false)).toBe(true);
    expect(shouldSurfaceAgentEndIssue(false, true)).toBe(false);
  });
});

describe("lastAssistantError", () => {
  it("提取最后一条 assistant 消息的 errorMessage", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [], errorMessage: "fetch failed" },
    ];
    expect(lastAssistantError(messages)).toBe("fetch failed");
  });

  it("没有 errorMessage 时返回 null", () => {
    expect(lastAssistantError([{ role: "assistant", content: [] }])).toBeNull();
    expect(lastAssistantError([])).toBeNull();
    expect(lastAssistantError("bad")).toBeNull();
  });
});

describe("runProducedNothing", () => {
  it("空文本视为空响应", () => {
    expect(runProducedNothing([{ role: "assistant", content: [{ type: "text", text: "  " }] }])).toBe(true);
    expect(runProducedNothing([{ role: "assistant", content: [] }])).toBe(true);
  });

  it("有文本或工具调用则不算空", () => {
    expect(runProducedNothing([{ role: "assistant", content: [{ type: "text", text: "好" }] }])).toBe(false);
    expect(runProducedNothing([{ role: "assistant", toolCalls: [{ id: "1" }] }])).toBe(false);
  });

  it("非数组输入不算空（不误报）", () => {
    expect(runProducedNothing(undefined)).toBe(false);
  });
});
