import { afterEach, describe, expect, it, vi } from "vitest";
import { bufferedSteps, conversationForRecordingTab, demoSession, dismissDemo, finishedDemo, isRecording, receiveSteps, resumeDemoIfRecording, startDemo, stopDemo } from "../src/background/demo.js";
import type { DemoStep } from "../../shared/demo-record.js";

afterEach(() => vi.unstubAllGlobals());

function harness() {
  const calls: Array<{ files?: string[]; func?: unknown; args?: unknown[]; target: { tabId: number } }> = [];
  const chrome = {
    scripting: {
      executeScript: vi.fn(async (arg: { files?: string[]; func?: unknown; args?: unknown[]; target: { tabId: number } }) => {
        calls.push(arg);
        return [{ frameId: 0, documentId: "doc1", result: { ok: true } }];
      }),
    },
  };
  vi.stubGlobal("chrome", chrome);
  return { chrome, calls };
}

const step = (at: number, name: string): DemoStep => ({ at, kind: "click", anchor: { tag: "button", name } });

/** 页面侧 stop() 会交出自己真实记下的步数；background 据此等最后一批到齐。 */
function harnessWithPageCount(count: number) {
  const chrome = {
    scripting: {
      executeScript: vi.fn(async (arg: { files?: string[] }) => [{ frameId: 0, documentId: "doc1", result: arg.files ? undefined : { ok: true, count } }]),
    },
  };
  vi.stubGlobal("chrome", chrome);
  return chrome;
}

it("开始示范：注入录制脚本并调用页面入口", async () => {
  const h = harness();
  expect(await startDemo("start", 7)).toEqual({ ok: true });
  expect(h.calls[0]?.files).toEqual(["content-record.js"]);
  expect(h.calls[1]?.target).toEqual({ tabId: 7 });
  expect(isRecording("start")).toBe(true);
  expect(demoSession("start")?.tabId).toBe(7);
});

it("页面不可注入时如实失败，不装作在录", async () => {
  const h = harness();
  h.chrome.scripting.executeScript.mockRejectedValueOnce(new Error("Cannot access contents of the page"));
  const started = await startDemo("fail", 7);
  expect(started.ok).toBe(false);
  expect(started.error).toContain("Cannot access");
  expect(isRecording("fail")).toBe(false);
});

it("步骤整批替换，超上限时截断并标记", async () => {
  harness();
  await startDemo("batch", 7);
  receiveSteps("batch", [step(0, "a"), step(10, "b")], false);
  expect(bufferedSteps("batch").map(s => s.anchor?.name)).toEqual(["a", "b"]);
  receiveSteps("batch", Array.from({ length: 260 }, (_, i) => step(i * 1000, `第${i}个`)), false);
  expect(bufferedSteps("batch")).toHaveLength(200);
  expect(demoSession("batch")?.truncated).toBe(true);
});

it("没在录时的步骤一律丢弃：晚到的一批不能凭空开一份记录", async () => {
  harness();
  receiveSteps("idle", [step(0, "a")], false);
  expect(demoSession("idle")).toBeUndefined();
  expect(bufferedSteps("idle")).toEqual([]);
});

it("结束示范返回这一步记录，并停掉页面录制；重复点不会把同一次示范用两遍", async () => {
  const h = harness();
  await startDemo("stop", 7);
  receiveSteps("stop", [step(0, "a")], false);
  const stopped = await stopDemo("stop");
  expect(stopped?.steps.map(s => s.anchor?.name)).toEqual(["a"]);
  expect(isRecording("stop")).toBe(false);
  expect(await stopDemo("stop")).toBeUndefined();
  expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
});

it("示范页没有任务绑定时也要收步骤：不能靠 tab→session 绑定找会话", async () => {
  harness();
  await startDemo("unbound", 42);
  // 页面侧上行只有 sender.tab；这条路径不走 findSessionForTab
  expect(conversationForRecordingTab(42)).toBe("unbound");
  receiveSteps("unbound", [step(0, "a")], false);
  expect(bufferedSteps("unbound")).toHaveLength(1);
  await stopDemo("unbound");
  expect(conversationForRecordingTab(42)).toBeUndefined();
});

it("收盘时等最后一批到齐，不把尾巴丢掉", async () => {
  harnessWithPageCount(3);
  await startDemo("tail", 9);
  receiveSteps("tail", [step(0, "a")], false);
  setTimeout(() => receiveSteps("tail", [step(0, "a"), step(10, "b"), step(20, "c")], false), 120);
  const stopped = await stopDemo("tail");
  expect(stopped?.steps.map(s => s.anchor?.name)).toEqual(["a", "b", "c"]);
});

it("页面报的步数永远收不到时也不能卡死：超时后照常收盘", async () => {
  harnessWithPageCount(99);
  await startDemo("stuck", 11);
  receiveSteps("stuck", [step(0, "a")], false);
  const started = Date.now();
  const stopped = await stopDemo("stuck");
  expect(stopped?.steps).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(2000);
});

it("收工后记录仍留着给用户看，也不再吃晚到的批次", async () => {
  harness();
  await startDemo("keep", 3);
  receiveSteps("keep", [step(0, "a")], false);
  expect(await stopDemo("keep")).toBeTruthy();
  expect(isRecording("keep")).toBe(false);
  expect(finishedDemo("keep")?.steps.map(s => s.anchor?.name)).toEqual(["a"]);
  receiveSteps("keep", [step(0, "a"), step(10, "迟到")], false);
  expect(bufferedSteps("keep").map(s => s.anchor?.name)).toEqual(["a"]);
  expect(conversationForRecordingTab(3)).toBeUndefined();
});

it("点收起才清掉这份记录", async () => {
  harness();
  await startDemo("dismiss", 4);
  receiveSteps("dismiss", [step(0, "a")], false);
  await stopDemo("dismiss");
  dismissDemo("dismiss");
  expect(demoSession("dismiss")).toBeUndefined();
});

it("再开始一次示范会替换掉上一份已收工的记录", async () => {
  harness();
  await startDemo("replace", 5);
  receiveSteps("replace", [step(0, "旧")], false);
  await stopDemo("replace");
  await startDemo("replace", 5);
  expect(isRecording("replace")).toBe(true);
  expect(bufferedSteps("replace")).toEqual([]);
});

it("示范跨页后续录：把已记下的步骤与已过时间喂回页面，接着记而不是重开", async () => {
  const h = harness();
  await startDemo("nav", 71);
  receiveSteps("nav", [step(0, "筛选"), step(900, "第一条记录")], false);
  const injectedBefore = h.chrome.scripting.executeScript.mock.calls.length;

  await resumeDemoIfRecording(71);

  const calls = h.chrome.scripting.executeScript.mock.calls.slice(injectedBefore);
  expect(calls[0]?.[0].files).toEqual(["content-record.js"]);
  const seeded = (calls[1]?.[0].args?.[0] ?? {}) as { steps?: unknown[]; elapsedMs?: number };
  expect(seeded.steps).toHaveLength(2);
  expect(typeof seeded.elapsedMs).toBe("number");
  expect(seeded.elapsedMs).toBeGreaterThanOrEqual(0);
});

it("没有在录的标签页不注入：不能凭一次导航凭空开录", async () => {
  const h = harness();
  await resumeDemoIfRecording(72);
  expect(h.chrome.scripting.executeScript).not.toHaveBeenCalled();
});

it("收工后的标签页也不再续录", async () => {
  const h = harness();
  await startDemo("done", 73);
  await stopDemo("done");
  const before = h.chrome.scripting.executeScript.mock.calls.length;
  await resumeDemoIfRecording(73);
  expect(h.chrome.scripting.executeScript.mock.calls.length).toBe(before);
});

describe("观察（background 侧）", () => {
  function observeHarness() {
    const local: Record<string, unknown> = {};
    const chrome = {
      storage: { local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(local, obj); }),
        remove: vi.fn(async (key: string) => { delete local[key]; }),
      } },
      tabs: { query: vi.fn(async () => [{ id: 7 }]) },
      scripting: { executeScript: vi.fn(async () => [{ result: { ok: true } }]) },
    };
    vi.stubGlobal("chrome", chrome);
    return { chrome, local };
  }
  const anchors = [{ tag: "a", name: "筛选" }, { tag: "a", name: "第一条记录" }];

  it("默认关：不写任何东西", async () => {
    observeHarness();
    const { isObserving, recordRun, resetObserveForTests, patternCount } = await import("../src/background/observe.js");
    resetObserveForTests();
    expect(await isObserving()).toBe(false);
    await recordRun({ hostname: "x.com", anchors, at: Date.now() });
    expect(await patternCount()).toBe(0);
  });

  it("打开后攒证据；满三次跨两天才成为候选", async () => {
    const h = observeHarness();
    const mod = await import("../src/background/observe.js");
    mod.resetObserveForTests();
    await mod.setObserving(true);
    const day = 24 * 60 * 60 * 1000;
    await mod.recordRun({ hostname: "x.com", anchors, at: 0 });
    await mod.recordRun({ hostname: "x.com", anchors, at: day });
    expect(await mod.listCandidates()).toHaveLength(0);
    await mod.recordRun({ hostname: "x.com", anchors, at: 3 * day });
    expect((await mod.listCandidates())[0]).toMatchObject({ hostname: "x.com", count: 3 });
    expect(h.local.sideagent_observe).toBe(true);
  });

  it("不用过的不再出现；生成技能后候选被消费掉", async () => {
    const h = observeHarness();
    const mod = await import("../src/background/observe.js");
    mod.resetObserveForTests();
    await mod.setObserving(true);
    const day = 24 * 60 * 60 * 1000;
    for (const at of [0, day, 3 * day]) await mod.recordRun({ hostname: "x.com", anchors, at });
    const first = (await mod.listCandidates())[0]!;
    await mod.dismissCandidate(first.signature, "x.com");
    expect(await mod.listCandidates()).toHaveLength(0);
    await mod.recordRun({ hostname: "y.com", anchors, at: 4 * day });
    const second = (await mod.listCandidates())[0];
    if (second) await mod.consumeCandidate(second.signature, "y.com");
    expect((await mod.listCandidates()).some(p => p.hostname === "y.com")).toBe(false);
    expect(h.local).toBeTruthy();
  });

  it("关掉观察会清掉已有证据", async () => {
    observeHarness();
    const mod = await import("../src/background/observe.js");
    mod.resetObserveForTests();
    await mod.setObserving(true);
    await mod.recordRun({ hostname: "x.com", anchors, at: Date.now() });
    expect(await mod.patternCount()).toBe(1);
    await mod.setObserving(false);
    expect(await mod.patternCount()).toBe(0);
  });

  it("accept 会消费候选：同一件事不再问第二遍", async () => {
    observeHarness();
    const mod = await import("../src/background/observe.js");
    mod.resetObserveForTests();
    await mod.setObserving(true);
    const day = 24 * 60 * 60 * 1000;
    for (const at of [0, day, 3 * day]) await mod.recordRun({ hostname: "x.com", anchors, at });
    const candidate = (await mod.listCandidates())[0]!;
    expect(candidate).toBeTruthy();
    await mod.applyObserveAction("accept", candidate.signature, "x.com");
    expect(await mod.listCandidates()).toHaveLength(0);
    expect(await mod.patternCount()).toBe(0);
  });
});
