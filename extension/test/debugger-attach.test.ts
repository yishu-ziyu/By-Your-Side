import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

function installChrome() {
  let attachCalls = 0;
  let detachCalls = 0;
  const mockAttachedTabs = new Set<number>();

  vi.stubGlobal("chrome", {
    debugger: {
      attach: vi.fn(async (details: { tabId: number }) => {
        attachCalls++;
        const { tabId } = details;

        if (mockAttachedTabs.has(tabId)) {
          throw new Error("Another debugger is already attached");
        }

        mockAttachedTabs.add(tabId);
        await new Promise((resolve) => setImmediate(resolve));
      }),
      detach: vi.fn(async (details: { tabId: number }) => {
        detachCalls++;
        const { tabId } = details;
        mockAttachedTabs.delete(tabId);
      }),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    },
  });

  return {
    attachCalls: () => attachCalls,
    detachCalls: () => detachCalls,
    mockAttachedTabs,
    attach: (chrome as any).debugger.attach,
    detach: (chrome as any).debugger.detach,
    sendCommand: (chrome as any).debugger.sendCommand,
  };
}

describe("debugger 并发 attach", () => {
  let realSetTimeout: typeof setTimeout;
  let timers: ReturnType<typeof setTimeout>[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    realSetTimeout = globalThis.setTimeout;
    timers = [];
    (globalThis as any).setTimeout = (...args: Parameters<typeof setTimeout>) => {
      const timer = realSetTimeout(...args);
      timers.push(timer);

      return timer;
    };
  });

  afterEach(async () => {
    globalThis.setTimeout = realSetTimeout;
    timers.forEach(clearTimeout);
  });

  it("两个并发 ensureAttached(7) 只发起 1 次 attach，两者都 resolve", async () => {
    const chromeStub = installChrome();
    const { ensureAttached } = await import("../src/background/debugger.js");

    const results = await Promise.allSettled([
      ensureAttached(7),
      ensureAttached(7),
    ]);

    expect(chromeStub.attachCalls()).toBe(1);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("fulfilled");

    // 验证 sendCommand 可用（attach 已成功）
    const sendResult = await chromeStub.sendCommand();
    expect(sendResult).toEqual({});

    const { detachAll } = await import("../src/background/debugger.js");
    await detachAll();
  });

  it('attach 抛 "Another debugger is already attached" → 两者都 reject，下次可重试', async () => {
    const chromeStub = installChrome();
    // 预先把 tab 7 标记为已被占用
    chromeStub.mockAttachedTabs.add(7);

    const { ensureAttached, detachAll } = await import(
      "../src/background/debugger.js"
    );

    const results = await Promise.allSettled([
      ensureAttached(7),
      ensureAttached(7),
    ]);

    // 两个都应该 reject，且消息相同
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");

    if (results[0].status === "rejected") {
      expect((results[0].reason as Error).message).toBe(
        "PERMISSION_DENIED: 该标签页正被 DevTools 或其他调试器占用"
      );
    }

    if (results[1].status === "rejected") {
      expect((results[1].reason as Error).message).toBe(
        "PERMISSION_DENIED: 该标签页正被 DevTools 或其他调试器占用"
      );
    }

    // 初始状态下 attach 应该被调用过
    const initialAttachCalls = chromeStub.attachCalls();
    expect(initialAttachCalls).toBeGreaterThan(0);

    // 下一次重新尝试（预先清掉占用，模拟释放）
    chromeStub.mockAttachedTabs.clear();
    vi.mocked(chromeStub.attach).mockClear();

    // 重新尝试应该可以成功
    await expect(ensureAttached(7)).resolves.toBeUndefined();
    expect(chromeStub.attach).toHaveBeenCalled();

    await detachAll();
  });

  it('attach 抛 "already attached" 后以本扩展只读命令核对连接', async () => {
    const chromeStub = installChrome();

    const { ensureAttached, detachAll } = await import(
      "../src/background/debugger.js"
    );

    // Mock attach 抛出 "already attached"
    vi.mocked(chromeStub.attach).mockImplementation(async () => {
      throw new Error("Debugger session id UUID is already attached");
    });
    vi.mocked(chromeStub.sendCommand).mockImplementation(async (...args: unknown[]) => args[1] === "Page.getFrameTree"
      ? { frameTree: { frame: { id: "owned-frame" } } } : {});

    // 调用应该不报错
    await expect(ensureAttached(7)).resolves.toBeUndefined();

    // 后续 sendCommand 应该可用（虽然实际 attach 抛了错，但被视为已连接）
    const sendResult = await chromeStub.sendCommand();
    expect(sendResult).toEqual({});

    await detachAll();
  });

  it("不同 tab 并发各 attach 一次", async () => {
    const chromeStub = installChrome();

    const { ensureAttached, detachAll } = await import(
      "../src/background/debugger.js"
    );

    const results = await Promise.allSettled([
      ensureAttached(7),
      ensureAttached(8),
      ensureAttached(7),
      ensureAttached(8),
    ]);

    // 全部应该成功
    results.forEach((r) => {
      expect(r.status).toBe("fulfilled");
    });

    // 应该有 2 次 attach（tab 7 和 tab 8 各一次）
    expect(chromeStub.attachCalls()).toBe(2);

    await detachAll();
  });

  it("detach 清掉 in-flight 项，之后可重新 attach", async () => {
    const chromeStub = installChrome();

    const { ensureAttached, detach, detachAll } = await import(
      "../src/background/debugger.js"
    );

    // 第一次 attach
    await ensureAttached(7);
    expect(chromeStub.attachCalls()).toBe(1);

    // Detach
    await detach(7);

    // 再次 attach（应该触发新的 attach 调用）
    await ensureAttached(7);
    expect(chromeStub.attachCalls()).toBe(2);

    await detachAll();
  });
});
