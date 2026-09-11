import { describe, expect, it, vi } from "vitest";
import { BrowserAgentSession, freshPageObservationText } from "../src/session.js";

// 合成会话不写用户真实 trace（与 session-helpers.test.ts 同策略）。
vi.mock("../src/run-trace.js", () => ({ RunTrace: class {
  begin() {}
  record() {}
  event() {}
} }));

function pageContext() {
  return { tabId: 77, title: "周末海边", url: "https://example.com/video" };
}

function fakeSession(rpc: unknown, streaming = false) {
  const raw = {
    get isStreaming() {
      return streaming;
    },
    model: { id: "test" },
    sessionId: "session-test",
    agent: { state: { messages: [] } },
    abort: vi.fn(async () => {}),
    prompt: vi.fn(async (_text: string) => {}),
    steer: vi.fn(async (_text: string) => {}),
    subscribe: vi.fn(() => () => {}),
  };
  const Session = BrowserAgentSession as unknown as new (...args: any[]) => BrowserAgentSession;
  const callbacks = { emit: vi.fn(), setStatus: vi.fn() };
  const wrapped = new Session(raw, null, callbacks, null, null, undefined, null, rpc) as any;
  return { wrapped, raw };
}

describe("新任务前的当前页预观察", () => {
  it("把用户当前页的观察附在消息后，模型首轮即可动手", async () => {
    const rpc = { call: vi.fn(async () => ({ text: 'button "暂停" [ref=3]', tabId: 77 })) };
    const { wrapped, raw } = fakeSession(rpc);
    wrapped.sendUserMessage("把视频暂停", pageContext());
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    expect(rpc.call.mock.calls[0]?.slice(0, 2)).toEqual(["snapshot", { tabId: 77 }]);
    const text = raw.prompt.mock.calls[0]![0] as string;
    expect(text).toContain("把视频暂停");
    expect(text).toContain('tab 77 "周末海边"');
    expect(text).toContain("FRESH PAGE OBSERVATION");
    expect(text).toContain('button "暂停" [ref=3]');
    expect(text).toContain("<page-content untrusted");
    expect(text.indexOf("FRESH PAGE OBSERVATION")).toBeLessThan(text.indexOf('button "暂停"'));
  });

  it("读不到页面时静默降级：消息照发，不注入观察", async () => {
    const rpc = { call: vi.fn(async () => { throw new Error("Extension is not connected"); }) };
    const { wrapped, raw } = fakeSession(rpc);
    wrapped.sendUserMessage("把视频暂停", pageContext());
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    const text = raw.prompt.mock.calls[0]![0] as string;
    expect(text).toContain("把视频暂停");
    expect(text).not.toContain("FRESH PAGE OBSERVATION");
  });

  it("没有 tabId 时不读页面，消息保持原文", async () => {
    const rpc = { call: vi.fn(async () => ({ text: "unused" })) };
    const { wrapped, raw } = fakeSession(rpc);
    wrapped.sendUserMessage("把视频暂停", undefined);
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    expect(rpc.call).not.toHaveBeenCalled();
    expect(raw.prompt.mock.calls[0]![0]).toBe("把视频暂停");
  });

  it("超长页面观察被截断后再注入", async () => {
    const rpc = { call: vi.fn(async () => ({ text: "x".repeat(20_000), tabId: 77 })) };
    const { wrapped, raw } = fakeSession(rpc);
    wrapped.sendUserMessage("把视频暂停", pageContext());
    await vi.waitFor(() => expect(raw.prompt).toHaveBeenCalledTimes(1));
    const text = raw.prompt.mock.calls[0]![0] as string;
    expect(text).toContain("[same-page observation truncated]");
    expect(text.length).toBeLessThan(14_000);
  });

  it("运行中插话不预注入，仍按原插话路径发送", async () => {
    const rpc = { call: vi.fn(async () => ({ text: "unused", tabId: 77 })) };
    const { wrapped, raw } = fakeSession(rpc, true);
    wrapped.sendUserMessage("预算改 600", pageContext());
    await vi.waitFor(() => expect(raw.steer).toHaveBeenCalledTimes(1));
    expect(rpc.call).not.toHaveBeenCalled();
    expect(raw.steer.mock.calls[0]![0]).toContain("预算改 600");
    expect(raw.steer.mock.calls[0]![0]).not.toContain("FRESH PAGE OBSERVATION");
  });
});

describe("freshPageObservationText", () => {
  it("包裹不可信边界并脱敏凭据样式文本", () => {
    const text = freshPageObservationText(pageContext(), "token=sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(text).toContain("<page-content untrusted");
    expect(text).toContain("tab=77");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});
