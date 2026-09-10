import { describe, expect, it, vi } from "vitest";
import {
  AcceptanceContinuity,
  BrowserAgentSession,
  HANDBACK_RESTORE_TIMEOUT_MS,
  extractImages,
  lastAssistantError,
  runProducedNothing,
  shouldSurfaceAgentEndIssue,
  withPageContext,
} from "../src/session.js";
import { handbackContinueText } from "../../shared/control.js";

// These tests use synthetic sessions; keep their events out of the user's retained traces.
// Actual persistence/redaction is covered by run-trace.test.ts.
vi.mock("../src/run-trace.js", () => ({ RunTrace: class {
  begin() {}
  record() {}
  event() {}
} }));

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function controlledBrowserSession(streaming = true, handbackRestoreTimeoutMs?: number) {
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
  const wrapped = new Session(raw, null, callbacks, null, null, handbackRestoreTimeoutMs);
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
  it('holds paused changes until real handback and includes fresh context without starting early',async()=>{
    const {wrapped,raw,settleAbort,agentStart}=controlledBrowserSession();
    wrapped.holdForUser();wrapped.queueSteerForResume('预算改600');
    expect(raw.prompt).not.toHaveBeenCalled();expect(raw.steer).not.toHaveBeenCalled();
    const context={tabId:123,title:'fresh',url:'https://example.com/fresh'};
    const resumed=wrapped.continueAfterHandback(context,'fresh-user-marker');settleAbort();await flushMicrotasks();
    expect(raw.prompt).toHaveBeenCalledTimes(1);
    expect(raw.prompt.mock.calls[0]![0]).toContain('预算改600');expect(raw.prompt.mock.calls[0]![0]).toContain('fresh-user-marker');
    agentStart();expect(await resumed).toBe(true);
  });
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

describe("BrowserAgentSession 交还恢复超时", () => {
  const ctx = { tabId: 21, title: "Worker", url: "https://example.com/worker" };

  it("默认恢复超时常量不低于 30s", () => {
    expect(HANDBACK_RESTORE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("provider 永不响应：恢复超时后交还失败、hold 归还 user、reason 表达超时语义", async () => {
    vi.useFakeTimers();
    try {
      const { wrapped, raw, settleAbort } = controlledBrowserSession(true, 1_000);
      wrapped.holdForUser();
      const started = wrapped.continueAfterHandback(ctx, "fresh worker page");

      settleAbort();
      await flushMicrotasks();
      expect(raw.prompt).toHaveBeenCalledTimes(1);
      expect(wrapped.isHeld()).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(started).resolves.toBe(false);
      expect(wrapped.isHeld()).toBe(true);
      expect(wrapped.handbackFailureReason).toMatch(/超时/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时后迟到的 agent_start 不得标 restored：按 stale 处理停掉旧流，仍归 user", async () => {
    vi.useFakeTimers();
    try {
      const { wrapped, raw, settleAbort, setStreaming, agentStart, callbacks } = controlledBrowserSession(true, 1_000);
      wrapped.holdForUser();
      const started = wrapped.continueAfterHandback(ctx, "fresh worker page");

      settleAbort();
      await flushMicrotasks();
      expect(raw.prompt).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(started).resolves.toBe(false);

      setStreaming(true);
      agentStart();

      expect(wrapped.isHeld()).toBe(true);
      expect(callbacks.setStatus).toHaveBeenCalledWith("user");
      expect(callbacks.setStatus).not.toHaveBeenCalledWith("running");
      expect(raw.abort).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时未触发前再次接管：清理恢复定时器，推进时间不误报超时", async () => {
    vi.useFakeTimers();
    try {
      const { wrapped, raw, settleAbort, callbacks } = controlledBrowserSession(true, 1_000);
      wrapped.holdForUser();
      const started = wrapped.continueAfterHandback(ctx, "fresh worker page");

      settleAbort();
      await flushMicrotasks();
      expect(raw.prompt).toHaveBeenCalledTimes(1);

      wrapped.holdForUser();
      await expect(started).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(wrapped.isHeld()).toBe(true);
      expect(wrapped.handbackFailureReason).toBeNull();
      expect(raw.prompt).toHaveBeenCalledTimes(1);
      expect(callbacks.emit).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时未触发前中止：清理恢复定时器，不误报超时", async () => {
    vi.useFakeTimers();
    try {
      const { wrapped, raw, settleAbort } = controlledBrowserSession(true, 1_000);
      wrapped.holdForUser();
      const started = wrapped.continueAfterHandback(ctx, "fresh worker page");

      settleAbort();
      await flushMicrotasks();
      expect(raw.prompt).toHaveBeenCalledTimes(1);

      wrapped.abort();
      await expect(started).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(wrapped.isHeld()).toBe(false);
      expect(wrapped.handbackFailureReason).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("有选区时在页面锚点后附上划词正文", () => {
    const out = withPageContext("这是什么", {
      tabId: 3,
      title: "MiroFish",
      url: "https://en.wikipedia.org/wiki/MiroFish",
      selection: { text: "MiroFish is a made-up term." },
    });
    expect(out).toBe(
      '[User\'s current page: tab 3 "MiroFish" — https://en.wikipedia.org/wiki/MiroFish]\n[User\'s selected text]\nMiroFish is a made-up term.\n这是什么',
    );
  });

  it("steer 插话与 prompt 走同一前缀（打断后仍带当前页锚点）", () => {
    const ctx = { tabId: 7, title: "Locked", url: "https://example.com/a" };
    expect(withPageContext("先点登录", ctx)).toBe(
      '[User\'s current page: tab 7 "Locked" — https://example.com/a]\n先点登录',
    );
  });

  it("有选区时附上 selected text 块", () => {
    const out = withPageContext("解释这段选中的文字。", {
      tabId: 3,
      title: "Methods",
      url: "https://nature.com/x",
      selection: { text: "  contamination\nfraction  " },
    });
    expect(out).toContain("[User's selected text]");
    expect(out).toContain("contamination fraction");
    expect(out.endsWith("解释这段选中的文字。")).toBe(true);
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

describe("extractImages & attachments integration", () => {
  it("extracts images from attachment array", () => {
    expect(extractImages(undefined)).toEqual([]);
    expect(extractImages([])).toEqual([]);
    expect(
      extractImages([
        {
          id: "1",
          type: "image",
          name: "a.png",
          dataBase64: "AAAA",
          mimeType: "image/png",
        },
      ]),
    ).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  });

  it("passes images to prompt when sending user message", () => {
    const { wrapped, raw, setStreaming } = controlledBrowserSession(false);
    setStreaming(false);
    wrapped.sendUserMessage("see this", undefined, [
      {
        id: "1",
        type: "image",
        name: "a.png",
        dataBase64: "AAAA",
        mimeType: "image/png",
      },
    ]);
    expect(raw.prompt).toHaveBeenCalledWith("see this", {
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
  });
});

it('voice steering waits for queue acceptance and cannot restart an idle task', async () => {
  const {wrapped,raw,setStreaming}=controlledBrowserSession(true);
  let accept!:()=>void;
  raw.steer.mockImplementation(()=>new Promise<void>(resolve=>{accept=resolve;}));
  let accepted=false;const pending=wrapped.steerCurrentTask('预算改成八百').then(()=>{accepted=true;});
  await flushMicrotasks();expect(accepted).toBe(false);expect(raw.prompt).not.toHaveBeenCalled();expect(raw.abort).not.toHaveBeenCalled();
  accept();await pending;expect(accepted).toBe(true);expect(raw.steer).toHaveBeenCalledExactlyOnceWith('预算改成八百');
  setStreaming(false);await expect(wrapped.steerCurrentTask('预算改成六百')).rejects.toThrow('当前没有正在执行');
  expect(raw.prompt).not.toHaveBeenCalled();
});

it('keeps the original task goal when resuming after a saved parameter change',async()=>{
 const {wrapped,raw,setStreaming,settleAbort,agentStart}=controlledBrowserSession(false);
 const goal='持续统计新增记录，直到用户暂停或终止。';wrapped.startTask(goal);setStreaming(true);wrapped.holdForUser();wrapped.queueSteerForResume('预算改600');
 const resumed=wrapped.continueAfterHandback({tabId:1,title:'current',url:'https://example.com'},'fresh marker');settleAbort();await flushMicrotasks();
 expect(raw.prompt.mock.calls.at(-1)![0]).toContain(goal);expect(raw.prompt.mock.calls.at(-1)![0]).toContain('预算改600');expect(raw.prompt).toHaveBeenCalledTimes(2);agentStart();expect(await resumed).toBe(true);
});
