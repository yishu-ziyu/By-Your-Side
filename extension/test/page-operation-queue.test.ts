import { afterEach, describe, expect, it, vi } from "vitest";
import { PageOperationQueue } from "../src/background/page-operation-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("page operation queue", () => {
  it("完整短动作结束后才让下一位操作者开始", async () => {
    const queue = new PageOperationQueue();
    const releaseFirst = deferred<void>();
    const events: string[] = [];
    const first = queue.run(7, async () => {
      events.push("甲:核对", "甲:focus", "甲:输入");
      await releaseFirst.promise;
      events.push("甲:读回");
      return "甲";
    });
    const second = queue.run(7, async () => {
      events.push("乙:核对", "乙:focus", "乙:输入", "乙:读回");
      return "乙";
    });
    await Promise.resolve();
    expect(events).toEqual(["甲:核对", "甲:focus", "甲:输入"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["甲", "乙"]);
    expect(events).toEqual(["甲:核对", "甲:focus", "甲:输入", "甲:读回", "乙:核对", "乙:focus", "乙:输入", "乙:读回"]);
  });

  it("接管立即挡住排队与迟到写，只等待在途短动作", async () => {
    const queue = new PageOperationQueue();
    const release = deferred<void>();
    const events: string[] = [];
    const inflight = queue.run(9, async () => { events.push("inflight"); await release.promise; events.push("safe"); });
    await Promise.resolve();
    const queued = queue.run(9, async () => { events.push("queued"); });
    const takeover = queue.takeover(9);
    await expect(queue.run(9, async () => { events.push("late"); })).rejects.toThrow(/页面现在归你/);
    release.resolve();
    await inflight;
    await takeover;
    await expect(queued).rejects.toThrow(/页面现在归你/);
    expect(events).toEqual(["inflight", "safe"]);

    queue.handback(9);
    await expect(queue.run(9, async () => "restored")).resolves.toBe("restored");
  });

  it("接管后立刻交还也不会复活接管前已排队的写", async () => {
    const queue = new PageOperationQueue();
    const release = deferred<void>();
    const first = queue.run(10, async () => { await release.promise; });
    await Promise.resolve();
    const oldQueued = queue.run(10, async () => "stale");
    const takeover = queue.takeover(10);
    queue.handback(10);
    release.resolve();
    await first;
    await takeover;
    await expect(oldQueued).rejects.toThrow(/页面现在归你/);
    await expect(queue.run(10, async () => "fresh")).resolves.toBe("fresh");
  });

  it("不同页可并行，控制门在真正获锁后复查", async () => {
    const queue = new PageOperationQueue();
    const release = deferred<void>();
    let allowed = true;
    const first = queue.run(1, async () => { await release.promise; });
    const stale = queue.run(1, async () => "must-not-run", () => allowed);
    const other = queue.run(2, async () => "other-conversation");
    await expect(other).resolves.toBe("other-conversation");
    allowed = false;
    release.resolve();
    await first;
    await expect(stale).rejects.toThrow(/页面现在归你/);
  });
});

describe("page_operation executor", () => {
  afterEach(() => {
    vi.doUnmock("../src/background/state.js");
    vi.doUnmock("../src/background/axstate.js");
    vi.doUnmock("../src/background/debugger.js");
    vi.unstubAllGlobals();
  });

  it("在共享页返回操作者、修改状态和读回结果", async () => {
    vi.resetModules();
    const key = "conversation-A::writer";
    vi.doMock("../src/background/state.js", () => ({
      resolveWorkingTab: vi.fn(async () => ({ id: 12 })),
      getTabResource: vi.fn(async () => ({ tabId: 12, conversationId: "conversation-A", mode: "shared", collaborators: [key] })),
    }));
    vi.doMock("../src/background/axstate.js", () => ({ isAxRef: () => false }));
    vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn() }));
    let field = "old";
    vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn(async (details: any) => {
      if (details.files) return [{ result: undefined }];
      if (details.world === "ISOLATED") return [{ result: 0 }];
      if (details.args[1] === "inspect") return [{ result: { ok: true, data: { value: field, rect: { x: 1, y: 2, width: 30, height: 10 } } } }];
      const previousValue = field;
      if (previousValue !== details.args[2]) throw new Error("原值冲突");
      field = details.args[3];
      return [{ result: { ok: true, data: { previousValue, readBack: field } } }];
    }) } });
    const { pageOperation } = await import("../src/background/exec/page-operation.js");
    await expect(pageOperation({ tabId: 12, target: "#name", expectedValue: "old", value: "new" }, key)).resolves.toMatchObject({
      operator: "writer", previousValue: "old", changed: true, readBack: "new", verified: true,
    });
  });

  it("expectedValue 冲突时不写，并在错误中报告操作者与未修改", async () => {
    vi.resetModules();
    const key = "conversation-A::reviewer";
    vi.doMock("../src/background/state.js", () => ({
      resolveWorkingTab: vi.fn(async () => ({ id: 13 })),
      getTabResource: vi.fn(async () => ({ tabId: 13, conversationId: "conversation-A", mode: "shared", collaborators: [key] })),
    }));
    vi.doMock("../src/background/axstate.js", () => ({ isAxRef: () => false }));
    vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn() }));
    const executeScript = vi.fn(async (details: any) => details.files ? [{ result: undefined }] : [{ result: { ok: true, data: { value: "changed-by-page", rect: { x: 0, y: 0, width: 10, height: 10 } } } }]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    const { pageOperation } = await import("../src/background/exec/page-operation.js");
    await expect(pageOperation({ tabId: 13, target: "#school", expectedValue: "old", value: "new" }, key)).rejects.toThrow(/operator=reviewer.*changed=false.*原值冲突/);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("页面注入显式 error 不会被当作成功结果", async () => {
    vi.resetModules();
    const key = "conversation-A::writer";
    vi.doMock("../src/background/state.js", () => ({
      resolveWorkingTab: vi.fn(async () => ({ id: 14 })),
      getTabResource: vi.fn(async () => ({ tabId: 14, conversationId: "conversation-A", mode: "shared", collaborators: [key] })),
    }));
    vi.doMock("../src/background/axstate.js", () => ({ isAxRef: () => false }));
    vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn() }));
    vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn(async () => [{ error: "injected function threw" }]) } });
    const { pageOperation } = await import("../src/background/exec/page-operation.js");
    await expect(pageOperation({ tabId: 14, target: "#name", expectedValue: "", value: "new" }, key)).rejects.toThrow(/页面脚本执行失败.*injected function threw/);
  });

  it("只读字段在 focus 和 setter 前被拒绝", async () => {
    vi.resetModules();
    const key = "conversation-A::writer";
    vi.doMock("../src/background/state.js", () => ({
      resolveWorkingTab: vi.fn(async () => ({ id: 16 })),
      getTabResource: vi.fn(async () => ({ tabId: 16, conversationId: "conversation-A", mode: "shared", collaborators: [key] })),
    }));
    vi.doMock("../src/background/axstate.js", () => ({ isAxRef: () => false }));
    vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn() }));
    const focus = vi.fn();
    const field = { tagName: "INPUT", type: "text", disabled: false, readOnly: true, value: "old", focus, scrollIntoView: vi.fn(), getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }) };
    vi.stubGlobal("document", { querySelectorAll: () => [field] });
    vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn(async (details: any) => [{ result: details.func(...details.args) }]) } });
    const { pageOperation } = await import("../src/background/exec/page-operation.js");
    await expect(pageOperation({ tabId: 16, target: "#name", expectedValue: "old", value: "new" }, key)).rejects.toThrow(/字段已禁用或只读/);
    expect(focus).not.toHaveBeenCalled();
    expect(field.value).toBe("old");
  });

  it("写后重定位失败报告 changed=true，不谎称未修改", async () => {
    vi.resetModules();
    const key = "conversation-A::writer";
    vi.doMock("../src/background/state.js", () => ({
      resolveWorkingTab: vi.fn(async () => ({ id: 15 })),
      getTabResource: vi.fn(async () => ({ tabId: 15, conversationId: "conversation-A", mode: "shared", collaborators: [key] })),
    }));
    vi.doMock("../src/background/axstate.js", () => ({ isAxRef: () => false }));
    vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn() }));
    vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn(async (details: any) => {
      if (details.files) return [{ result: undefined }];
      if (details.world === "ISOLATED") return [{ result: 0 }];
      if (details.args[1] === "inspect") return [{ result: { ok: true, data: { value: "old", rect: { x: 0, y: 0, width: 10, height: 10 } } } }];
      return [{ result: { ok: false, error: "输入事件后字段已被替换", changed: true, readBack: null } }];
    }) } });
    const { pageOperation } = await import("../src/background/exec/page-operation.js");
    await expect(pageOperation({ tabId: 15, target: "#name", expectedValue: "old", value: "new" }, key)).rejects.toThrow(/changed=true.*字段已被替换/);
  });
});

describe("page operation execution fact", () => {
  it("未改页的明确拒绝可重试，改过或不明一律未知", async () => {
    vi.resetModules();
    vi.doMock("../src/background/state.js", () => ({
      resolveWorkingTab: vi.fn(async () => ({ id: 15 })),
      getTabResource: vi.fn(async () => ({ tabId: 15, conversationId: "conversation-A", mode: "shared", collaborators: ["conversation-A::writer"] })),
    }));
    vi.doMock("../src/background/axstate.js", () => ({ isAxRef: () => false }));
    vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn() }));
    const { PageOperationError, pageOperationExecutionFact } = await import("../src/background/exec/page-operation.js");
    expect(pageOperationExecutionFact(new PageOperationError({ operator: "w", target: "#a", changed: false, readBack: null, reason: "原值冲突" }))).toBe("not_executed");
    expect(pageOperationExecutionFact(new PageOperationError({ operator: "w", target: "#a", changed: true, readBack: "x", reason: "读回不一致" }))).toBe("unknown");
    expect(pageOperationExecutionFact(new Error("页面已变化"))).toBe("unknown");
  });
});
