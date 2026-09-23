import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 未决 CDP 命令的应答；本文件只有 Page.captureScreenshot 这一条挂起命令，回执即其 { data } 截图数据。 */
type PendingCommandReply = { data: string };

// Failure contract before implementation: a browser may apply an input and lose
// its reply. Retrying that input duplicates a real side effect. Attaching may
// also fail before dispatch; that is a different execution fact.
describe("CDP delivery facts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand: vi.fn(async () => ({})),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["Input.insertText", "Input.dispatchMouseEvent", "Runtime.evaluate", "Input.dispatchDragEvent"])(
    "%s applied before a lost reply is never replayed by transport", async (method) => {
      let effects = 0;
      vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, name) => {
        if (name === method) {
          effects += 1;

          if (effects === 1) throw new Error("Detached while handling command");
        }

        return {};
      });
      const { sendCommand } = await import("../src/background/debugger.js");
      await expect(sendCommand(17, method, {})).rejects.toMatchObject({ executionFact: "unknown" });
      expect(effects).toBe(1);
    },
  );

  it("an attach refusal proves no business command was sent", async () => {
    vi.mocked(chrome.debugger.attach).mockRejectedValue(new Error("Another debugger is already attached"));
    const { sendCommand } = await import("../src/background/debugger.js");
    await expect(sendCommand(17, "Input.insertText", { text: "once" })).rejects.toMatchObject({ executionFact: "not_executed" });
    expect(vi.mocked(chrome.debugger.sendCommand).mock.calls.some(([, method]) => method === "Input.insertText")).toBe(false);
  });

  it("recovers an already-owned Chrome session by an ownership-checked read, without replay", async () => {
    vi.mocked(chrome.debugger.attach).mockRejectedValue(new Error("Another debugger is already attached to the tab with id: 17"));
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-owned-by-this-extension" } } };

      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800 } };

      return {};
    });
    const { sendCommand } = await import("../src/background/debugger.js");
    await expect(sendCommand(17, "Page.getLayoutMetrics", {})).resolves.toMatchObject({ cssLayoutViewport: { clientWidth: 800 } });
    expect(vi.mocked(chrome.debugger.sendCommand).mock.calls.filter(([, method]) => method === "Page.getLayoutMetrics")).toHaveLength(1);
  });

  it("a pending command holds its connection beyond the idle interval", async () => {
    let finish: (value: PendingCommandReply) => void = () => {};

    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === "Page.captureScreenshot") return new Promise<PendingCommandReply>(resolve => { finish = resolve; });

      return {};
    });
    const { sendCommand } = await import("../src/background/debugger.js");
    const pending = sendCommand(17, "Page.captureScreenshot", {});
    await vi.advanceTimersByTimeAsync(16_000);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    finish({ data: "real reply" });
    await pending;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 17 });
  });
});
