import { beforeEach, describe, expect, it, vi } from "vitest";

type ScriptDetails = { target: { tabId: number }; files?: string[]; func?: unknown; args?: unknown[] };

function installChrome(opts: { titles?: Record<number, string>; activeId?: number | null } = {}) {
  const titles = opts.titles ?? {};
  const executeScript = vi.fn(async (_details: ScriptDetails) => [{ frameId: 0, result: undefined }]);
  const query = vi.fn(async () => (opts.activeId == null ? [] : [{ id: opts.activeId }]));
  const get = vi.fn(async (tabId: number) => ({ id: tabId, title: titles[tabId] ?? "" }));
  const update = vi.fn(async () => ({}));
  const activated: Array<() => void> = [];
  const removed: Array<(tabId: number) => void> = [];
  vi.stubGlobal("chrome", {
    debugger: { onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
    scripting: { executeScript },
    tabs: {
      onRemoved: { addListener: (fn: (tabId: number) => void) => removed.push(fn) },
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: (fn: () => void) => activated.push(fn) },
      query,
      get,
      update,
    },
    windows: { update: vi.fn(async () => ({})) },
  });
  return { executeScript, query, get, update, activated, removed };
}

/** 取"状态画到哪一页"的调用：args[0] 是光标实例 id。 */
function statusCalls(executeScript: ReturnType<typeof vi.fn>, instanceId = "main") {
  return executeScript.mock.calls.filter(([details]) => (details as ScriptDetails).args?.[0] === instanceId);
}

function pillCalls(executeScript: ReturnType<typeof vi.fn>) {
  return executeScript.mock.calls.filter(([details]) => {
    const view = (details as ScriptDetails).args?.[1];
    return Boolean(view && typeof view === "object" && "title" in (view as object));
  });
}

describe("光标状态层", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("状态落到工作页的光标名牌上（先注入再画）", async () => {
    const env = installChrome();
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });

    expect(env.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 21 }, files: ["content-cursor.js"] }),
    );
    expect(statusCalls(env.executeScript)[0]?.[0]).toMatchObject({ target: { tabId: 21 } });
    expect(statusCalls(env.executeScript)[0]?.[0].args).toEqual(["main", "waiting"]);
  });

  it("复合执行键只把成员 id 当光标实例", async () => {
    const env = installChrome();
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "design::worker-1", state: "reading", tabId: 7 });

    expect(statusCalls(env.executeScript, "worker-1")[0]?.[0].args).toEqual(["worker-1", "reading"]);
  });

  it("没有工作页时按显式 tabId 画", async () => {
    const env = installChrome();
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "reading", tabId: 9 });

    expect(statusCalls(env.executeScript)[0]?.[0].target).toEqual({ tabId: 9 });
  });

  it("页面禁止注入时不抛错，也不留状态", async () => {
    const env = installChrome();
    env.executeScript.mockRejectedValue(new Error("cannot access contents of the page"));
    const { showCursorStatus, cursorStatusForTests } = await import("../src/background/cursor-status.js");

    await expect(
      showCursorStatus({ key: "main", state: "waiting", tabId: 3 }),
    ).resolves.toBeUndefined();
    expect(cursorStatusForTests("main")?.state).toBe("waiting");
  });

  it("它在别的标签页干活时，给用户当前看的页挂可点胶囊（带标题）", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘 · 招聘" }, activeId: 5 });
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });

    const pill = pillCalls(env.executeScript)[0]?.[0];
    expect(pill?.target).toEqual({ tabId: 5 });
    expect(pill?.args?.[1]).toMatchObject({ state: "waiting", title: "BOSS直聘 · 招聘", sessionId: "main" });
  });

  it("用户看的就是它在干的那一页时不挂胶囊", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" }, activeId: 21 });
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "reading", tabId: 21 });

    expect(pillCalls(env.executeScript)).toHaveLength(0);
  });

  it("完成/失败阶段不挂胶囊（“正在另一个标签页工作”不成立）", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" }, activeId: 5 });
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "done", tabId: 21 });

    expect(pillCalls(env.executeScript)).toHaveLength(0);
  });

  it("用户切回工作页后胶囊收起", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" }, activeId: 5 });
    const { showCursorStatus, cursorStatusForTests } = await import("../src/background/cursor-status.js");
    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    expect(cursorStatusForTests("main")?.pillTabId).toBe(5);
    env.executeScript.mockClear();
    env.query.mockResolvedValue([{ id: 21 }] as never);

    for (const listener of env.activated) listener();
    await vi.waitFor(() => expect(pillCalls(env.executeScript)).toHaveLength(0));

    const hidden = env.executeScript.mock.calls.find(([details]) => (details as ScriptDetails).target.tabId === 5);
    expect((hidden?.[0] as ScriptDetails | undefined)?.args ?? []).toEqual([]);
  });

  it("点胶囊能反查它正在干活的那一页", async () => {
    installChrome({ titles: { 21: "BOSS直聘" }, activeId: 5 });
    const { showCursorStatus, workingTabBehindPill } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "reading", tabId: 21 });

    expect(workingTabBehindPill(5)).toBe(21);
    expect(workingTabBehindPill(21)).toBeNull();
    expect(workingTabBehindPill(null)).toBeNull();
  });

  it("工作页被关掉后不再指向它", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" }, activeId: 5 });
    const { showCursorStatus, cursorStatusForTests } = await import("../src/background/cursor-status.js");
    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });

    for (const listener of env.removed) listener(21);

    expect(cursorStatusForTests("main")).toBeNull();
  });

  it("接管时立刻收起，恢复工作前不再上状态", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" }, activeId: 5 });
    const { showCursorStatus, suppressCursorStatus, resumeCursorStatus, cursorStatusForTests } = await import(
      "../src/background/cursor-status.js"
    );
    await showCursorStatus({ key: "main", state: "reading", tabId: 21 });
    env.executeScript.mockClear();

    await suppressCursorStatus("main");
    expect(statusCalls(env.executeScript)).toHaveLength(1);
    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    expect(statusCalls(env.executeScript)).toHaveLength(1);

    resumeCursorStatus("main");
    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    expect(cursorStatusForTests("main")?.state).toBe("waiting");
  });

  it("idle 只清等待/读页面，完成与失败留到下一轮", async () => {
    installChrome({ titles: { 21: "BOSS直聘" }, activeId: 21 });
    const { showCursorStatus, clearAmbientCursorStatus, cursorStatusForTests } = await import(
      "../src/background/cursor-status.js"
    );

    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    await clearAmbientCursorStatus("main");
    expect(cursorStatusForTests("main")).toBeNull();

    await showCursorStatus({ key: "main", state: "done", tabId: 21 });
    await clearAmbientCursorStatus("main");
    expect(cursorStatusForTests("main")?.state).toBe("done");

    await showCursorStatus({ key: "main", state: "failed", tabId: 21 });
    await clearAmbientCursorStatus("main");
    expect(cursorStatusForTests("main")?.state).toBe("failed");
  });

  it("每个成员各记各的状态", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" }, activeId: 21 });
    const { showCursorStatus, cursorStatusForTests } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    await showCursorStatus({ key: "worker-1", state: "reading", tabId: 4 });

    expect(cursorStatusForTests("main")?.state).toBe("waiting");
    expect(cursorStatusForTests("worker-1")?.state).toBe("reading");
    expect(env.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 4 } }));
  });

  it("不同会话的同名成员各记各的状态（执行键隔离）", async () => {
    const env = installChrome({ titles: { 21: "A" }, activeId: 21 });
    const { showCursorStatus, cursorStatusForTests } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "desk::main", state: "waiting", tabId: 21 });
    await showCursorStatus({ key: "main", state: "reading", tabId: 4 });

    expect(cursorStatusForTests("desk::main")?.state).toBe("waiting");
    expect(cursorStatusForTests("main")?.state).toBe("reading");
    const byTab = env.executeScript.mock.calls
      .filter(([details]) => (details as ScriptDetails).args?.[1] === "waiting")
      .map(([details]) => (details as ScriptDetails).target.tabId);
    expect(byTab).toEqual([21]);
  });

  it("跨页胶囊带着目标标签页一起下发：service worker 重启后点它仍然跳得对", async () => {
    const env = installChrome({ titles: { 21: "opencode" }, activeId: 7 });
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    // 它在 21 号标签页干活，用户当前看的是 7 号 → 胶囊画在 7 号上，指向 21
    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });

    const pill = pillCalls(env.executeScript).at(-1);
    expect(pill?.[0].target).toEqual({ tabId: 7 });
    expect((pill?.[0].args?.[1] as { tabId?: number })?.tabId).toBe(21);
  });

  it("正在干活的就是当前页时不画胶囊（用户已经看着它了）", async () => {
    const env = installChrome({ titles: { 21: "同一个页面" }, activeId: 21 });
    const { showCursorStatus } = await import("../src/background/cursor-status.js");

    await showCursorStatus({ key: "main", state: "waiting", tabId: 21 });

    const painted = pillCalls(env.executeScript).filter(([details]) => (details as ScriptDetails).args?.[1] !== undefined);
    expect(painted.every(([details]) => (details as ScriptDetails).target.tabId === 21)).toBe(true);
    expect((painted.at(-1)?.[0].args?.[1] as { tabId?: number } | undefined)?.tabId).toBeUndefined();
  });
});
