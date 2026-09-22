import { beforeEach, describe, expect, it, vi } from "vitest";

type ScriptDetails = {
  target: { tabId: number };
  files?: string[];
  func?: unknown;
  args?: unknown[];
};

type QueryGate = { promise: Promise<unknown>; resolve: (value: unknown) => void };

/** 可手动放行的异步替身：用来把绘制卡在 await 中间，制造真实并发窗口。 */
function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function installChrome(opts: { titles?: Record<number, string>; cursorInjectGates?: number[] } = {}) {
  const titles = opts.titles ?? {};
  /** 这些标签页上的光标注入（ensureCursor）会被卡住，用来把旧绘制停在「落笔之前」的真实 await 里。 */
  const gatedTabs = new Set(opts.cursorInjectGates ?? []);
  const cursorGates: Array<{ tabId: number; release: () => void }> = [];

  const executeScript = vi.fn(async (details: ScriptDetails) => {
    if (gatedTabs.has(details.target.tabId) && details.files?.includes("content-cursor.js")) {
      await new Promise<void>((release) => {
        cursorGates.push({ tabId: details.target.tabId, release });
      });
    }

    return [{ frameId: 0, result: undefined }];
  });

  /** 每次查「用户当前看哪一页」都被卡住，测试逐个放行。 */
  const gates: QueryGate[] = [];

  const query = vi.fn(() => {
    const gate = deferred<unknown>();
    gates.push({ promise: gate.promise, resolve: gate.resolve });

    return gate.promise;
  });

  const get = vi.fn(async (tabId: number) => ({ id: tabId, title: titles[tabId] ?? "" }));
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
      update: vi.fn(async () => ({})),
    },
    windows: { update: vi.fn(async () => ({})) },
  });

  return { executeScript, query, get, activated, removed, gates, cursorGates };
}

async function waitForQuery(env: ReturnType<typeof installChrome>, times: number): Promise<void> {
  await vi.waitFor(() => expect(env.query).toHaveBeenCalledTimes(times));
}

/** 放行第 n 次「用户当前看哪一页」的查询（0 起）。 */
function resolveActive(env: ReturnType<typeof installChrome>, index: number, tabId: number | null): void {
  const gate = env.gates[index];

  if (!gate) throw new Error(`第 ${index} 次查询还没发生`);
  gate.resolve(tabId == null ? [] : [{ id: tabId }]);
}

/** 放行第 n 次卡住的光标注入（0 起）。 */
function releaseCursorInject(env: ReturnType<typeof installChrome>, index: number): void {
  const gate = env.cursorGates[index];

  if (!gate) throw new Error(`第 ${index} 次光标注入还没发生`);
  gate.release();
}

/** 画上胶囊的调用：args[1] 是带 title 的跨页视图对象。 */
function pillPaints(executeScript: ReturnType<typeof vi.fn>) {
  return executeScript.mock.calls.filter(([details]) => {
    const view = (details as ScriptDetails).args?.[1];

    return Boolean(view && typeof view === "object" && "title" in (view as object));
  }) as Array<[ScriptDetails]>;
}

function paintsOn(executeScript: ReturnType<typeof vi.fn>, tabId: number) {
  return pillPaints(executeScript).filter(([details]) => details.target.tabId === tabId);
}

function hidesOn(executeScript: ReturnType<typeof vi.fn>, tabId: number) {
  return executeScript.mock.calls.filter(([details]) => {
    const call = details as ScriptDetails;

    // 只认「往页面里执行无参函数」的隐藏调用，不把注入 content-cursor.js 算进来
    return call.target.tabId === tabId && call.files === undefined && (call.args ?? []).length === 0;
  });
}

describe("光标状态层跨页提示的异步残留", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("绘制途中被 clear：旧 waiting 不能把胶囊重新画回来", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" } });

    const { showCursorStatus, clearCursorStatus, cursorStatusForTests } = await import(
      "../src/background/cursor-status.js"
    );

    const showing = showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    await waitForQuery(env, 1);
    const clearing = clearCursorStatus("main");
    resolveActive(env, 0, 5);
    await Promise.all([showing, clearing]);

    expect(cursorStatusForTests("main")).toBeNull();
    expect(pillPaints(env.executeScript)).toHaveLength(0);
  });

  it("绘制途中被 suppress（用户接管）：旧 waiting 不能把胶囊重新画回来", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" } });

    const { showCursorStatus, suppressCursorStatus, cursorStatusForTests } = await import(
      "../src/background/cursor-status.js"
    );

    const showing = showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    await waitForQuery(env, 1);
    const suppressing = suppressCursorStatus("main");
    resolveActive(env, 0, 5);
    await Promise.all([showing, suppressing]);

    expect(cursorStatusForTests("main")).toBeNull();
    expect(pillPaints(env.executeScript)).toHaveLength(0);
  });

  it("同 key 新状态已接管：旧绘制不能把它盖回 waiting", async () => {
    const env = installChrome({ titles: { 21: "BOSS直聘" } });
    const { showCursorStatus, cursorStatusForTests } = await import("../src/background/cursor-status.js");

    const oldShowing = showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    await waitForQuery(env, 1);
    await showCursorStatus({ key: "main", state: "done", tabId: 21 });
    resolveActive(env, 0, 5);
    await oldShowing;

    expect(cursorStatusForTests("main")?.state).toBe("done");
    expect(pillPaints(env.executeScript)).toHaveLength(0);
  });

  it("接管期间被卡住的旧绘制：不重画自己的胶囊，也不动别处仍在干活的会话", async () => {
    const env = installChrome({ titles: { 21: "A 页", 31: "B 页" } });

    const { showCursorStatus, suppressCursorStatus, cursorStatusForTests } = await import(
      "../src/background/cursor-status.js"
    );

    // A 会话在 21 干活、用户看 5 → A 的胶囊画在 5
    const showingA = showCursorStatus({ key: "desk::main", state: "waiting", tabId: 21 });
    await waitForQuery(env, 1);
    resolveActive(env, 0, 5);
    await showingA;
    // B 会话在 31 干活、用户看 7 → B 的胶囊画在 7
    const showingB = showCursorStatus({ key: "main", state: "reading", tabId: 31 });
    await waitForQuery(env, 2);
    resolveActive(env, 1, 7);
    await showingB;
    const baselineOn5 = paintsOn(env.executeScript, 5).length;

    // 标签切换触发重排，A 的这次绘制被卡住；同时用户接管
    for (const listener of env.activated) listener();
    await waitForQuery(env, 3);
    const suppressing = suppressCursorStatus("desk::main");
    resolveActive(env, 2, 5);
    await suppressing;
    await vi.waitFor(() => expect(env.query).toHaveBeenCalledTimes(4));
    resolveActive(env, 3, 7);
    await vi.waitFor(() => expect(cursorStatusForTests("main")?.pillTabId).toBe(7));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cursorStatusForTests("desk::main")).toBeNull();
    expect(paintsOn(env.executeScript, 5)).toHaveLength(baselineOn5);
    expect(hidesOn(env.executeScript, 5)).toHaveLength(1);
    expect(paintsOn(env.executeScript, 7).at(-1)?.[0].args?.[1]).toMatchObject({ tabId: 31, sessionId: "main" });
    expect(hidesOn(env.executeScript, 7)).toHaveLength(0);
  });

  it("绘制正卡在注入光标这段 await 时被接管：旧 waiting 不能把胶囊重新画回来", async () => {
    // 延迟发生在 pill 绘制内部真正落笔之前的那次注入（ensureCursor），不是外面的查 active 页
    const env = installChrome({ titles: { 21: "BOSS直聘" }, cursorInjectGates: [5] });

    const { showCursorStatus, suppressCursorStatus, cursorStatusForTests } = await import(
      "../src/background/cursor-status.js"
    );

    const showing = showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    await waitForQuery(env, 1);
    resolveActive(env, 0, 5);
    // 此时旧绘制已经卡在「对 5 号页注入光标」这一步，还没写 showCrossPage
    await vi.waitFor(() => expect(env.cursorGates).toHaveLength(1));

    const suppressing = suppressCursorStatus("main");
    releaseCursorInject(env, 0);
    await Promise.all([showing, suppressing]);

    expect(cursorStatusForTests("main")).toBeNull();
    expect(paintsOn(env.executeScript, 5)).toHaveLength(0);
    expect(hidesOn(env.executeScript, 5).length).toBeGreaterThan(0);
  });

  it("同一页被两个会话认领：清掉旧的后，仍在干活的那个不被连累", async () => {
    const env = installChrome({ titles: { 21: "A 页", 31: "B 页" } });

    const { showCursorStatus, clearCursorStatus, cursorStatusForTests } = await import(
      "../src/background/cursor-status.js"
    );

    // A 会话在 21 干活、用户看 5 → 胶囊画在 5
    const showingA = showCursorStatus({ key: "desk::main", state: "waiting", tabId: 21 });
    await waitForQuery(env, 1);
    resolveActive(env, 0, 5);
    await showingA;
    // B 会话在 31 干活、用户仍看 5 → 也把胶囊画到 5（后认领的赢）
    const showingB = showCursorStatus({ key: "main", state: "reading", tabId: 31 });
    await waitForQuery(env, 2);
    resolveActive(env, 1, 5);
    await showingB;

    await clearCursorStatus("desk::main");

    expect(cursorStatusForTests("desk::main")).toBeNull();
    // 页面 5 仍归 B：清 A 不能把它一起隐藏
    expect(hidesOn(env.executeScript, 5)).toHaveLength(0);
    expect(cursorStatusForTests("main")?.pillTabId).toBe(5);
    expect(paintsOn(env.executeScript, 5).at(-1)?.[0].args?.[1]).toMatchObject({ tabId: 31, sessionId: "main" });
  });
  it("接管发生在目标页注入期间：旧名牌也不能重新显示", async () => {
    const env = installChrome({ cursorInjectGates: [21] });
    const { showCursorStatus, suppressCursorStatus } = await import("../src/background/cursor-status.js");
    const showing = showCursorStatus({ key: "main", state: "waiting", tabId: 21 });
    await vi.waitFor(() => expect(env.cursorGates).toHaveLength(1));
    const suppressing = suppressCursorStatus("main");
    releaseCursorInject(env, 0);
    await Promise.all([showing, suppressing]);
    expect(env.executeScript.mock.calls.filter(([call]) => call.args?.[1] === "waiting")).toHaveLength(0);
    expect(env.query).not.toHaveBeenCalled();
  });

});
