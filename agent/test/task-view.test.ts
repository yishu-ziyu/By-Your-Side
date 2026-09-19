/**
 * T02 统一任务视图：投影正确性与协议契约（A02-01—A02-08）。
 * 投影是纯函数；这里的「重放」指 restoreResults 从持久快照恢复。
 */
import { describe, expect, it } from "vitest";
import { TaskProgress } from "../src/task-progress.js";
import { projectTaskView, isTaskView, type TaskView } from "../../shared/task-view.js";
import { parseServerMessage } from "../../shared/protocol.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";
import type { ServerMessage, ClientMessage } from "../../shared/protocol.js";

const CID = "conv-a";

/** 固定时钟：实时与重放投影必须逐字段一致（含 observedAt）。 */
function harness(id = CID) {
  let tick = 1000;
  const progress = new TaskProgress(id, () => tick++);
  const emit = (event: Record<string, unknown>, member = "main") =>
    progress.observe({ type: "agent_event", sessionId: member, event } as ServerMessage);
  return { progress, emit, tick: () => tick };
}

function startedRun() {
  const h = harness();
  h.progress.request("比较三家方案，统一口径", { tabId: 7, title: "方案列表", url: "http://fixture.test/offers" });
  h.emit({ kind: "agent_start" });
  h.emit({ kind: "tool_start", toolCallId: "c1", name: "snapshot", params: {} });
  h.emit({ kind: "tool_end", toolCallId: "c1", name: "snapshot", isError: false, executionFact: "executed", resultText: "ok" });
  return h;
}

describe("A02-01 实时与重放投影一致", () => {
  it("同一快照的实时投影与面板重开等价投影逐字段相等", () => {
    const h = startedRun();
    const snap = h.progress.snapshot();
    const live = projectTaskView(snap);
    // 面板重开/重连（同 host 进程）：replayState 直接重发当前快照的投影
    const replayed = projectTaskView({ ...snap });
    expect(replayed).toEqual(live);
  });
  it("host 重启恢复后的活动任务必须显示为已中断（不是仍在运行）", () => {
    const h = startedRun();
    const restored = new TaskProgress(CID, () => 1000);
    restored.restoreResults(h.progress.snapshot()); // 持久化恢复 = host 重启路径
    const view = projectTaskView(restored.snapshot());
    expect(view.state).toBe("interrupted");
    expect(view.waiting?.reason).toBe("restart_checkpoint");
  });
  it("重放不重复产生任务或操作：results/active 不翻倍", () => {
    const h = startedRun();
    const restored = new TaskProgress(CID, () => 1000);
    restored.restoreResults(h.progress.snapshot());
    restored.restoreResults(h.progress.snapshot()); // 重复恢复同一快照
    const view = projectTaskView({ ...restored.snapshot() });
    expect(view.results.length).toBe((h.progress.snapshot().results ?? []).length);
  });
});

describe("A02-02 身份与作用页面隔离", () => {
  it("A 页任务的视图绑定 A 页，不受其他会话/页面影响", () => {
    const a = startedRun();
    const b = harness("conv-b");
    b.progress.request("在另一个页面读文章", { tabId: 99, title: "文章", url: "http://fixture.test/article" });
    b.emit({ kind: "agent_start" });
    const viewA = projectTaskView(a.progress.snapshot());
    const viewB = projectTaskView(b.progress.snapshot());
    expect(viewA.conversationId).toBe(CID);
    expect(viewB.conversationId).toBe("conv-b");
    expect(viewA.page?.tabId).toBe(7);
    expect(viewB.page?.tabId).toBe(99);
    // 页面身份以 urlHash 持久化（不存原文 URL）；两页哈希必须不同
    expect(viewA.page?.urlHash).not.toBe(viewB.page?.urlHash);
    // A 的活动不混入 B
    expect(viewB.active.every((x) => !viewA.goal?.includes(x.action))).toBe(true);
  });
});

describe("A02-03 取消后旧事件不复活任务", () => {
  it("abort 后同 run 的迟到 running/tool_end 不改终止状态", () => {
    const h = startedRun();
    h.emit({ kind: "tool_start", toolCallId: "c2", name: "fill", params: { target: "@1", value: "x" } });
    h.progress.abort();
    const before = projectTaskView(h.progress.snapshot());
    expect(before.state).toBe("aborted");
    // 旧事件晚到
    h.progress.observe({ type: "status", state: "running" } as ServerMessage);
    h.emit({ kind: "tool_end", toolCallId: "c2", name: "fill", isError: false, executionFact: "executed", resultText: "ok" });
    const after = projectTaskView(h.progress.snapshot());
    expect(after.state).toBe("aborted");
    expect(after.waiting?.reason).toBe("cancelled");
    expect(after.active).toEqual([]);
  });
});

describe("A02-04 状态与真实下一步一致", () => {
  it("running / 接管 / 中断 / 错误分别投影，无一伪装成完成", () => {
    const h = startedRun();
    expect(projectTaskView(h.progress.snapshot()).state).toBe("running");
    expect(projectTaskView(h.progress.snapshot()).waiting).toBeNull();

    h.progress.observe({ type: "status", state: "user" } as ServerMessage);
    const held = projectTaskView(h.progress.snapshot());
    expect(held.state).toBe("paused");
    expect(held.waiting?.reason).toBe("human_control");

    // 中断：host 重启时活动中的 run 恢复为 interrupted
    const restored = new TaskProgress(CID, () => 1000);
    restored.restoreResults({ ...h.progress.snapshot(), state: "running" });
    const interrupted = projectTaskView(restored.snapshot());
    expect(interrupted.state).toBe("interrupted");
    expect(interrupted.waiting?.reason).toBe("restart_checkpoint");
    expect(interrupted.resumable).toBe(true);

    h.progress.observe({ type: "agent_event", event: { kind: "error", message: "boom" } } as ServerMessage);
    const errored = projectTaskView(h.progress.snapshot());
    expect(errored.state === "error" || errored.waiting !== null).toBe(true);
    // 任何态都没有业务成功字段
    for (const v of [held, interrupted, errored]) expect(JSON.stringify(v)).not.toContain("successVerified\":true");
  });
});

describe("A02-05 工具成功但义务未尽", () => {
  it("outstanding 保留未完成项，无全任务成功表述", () => {
    const h = startedRun();
    h.progress.registerResults([
      { id: "r1", description: "读取方案 A", tool: "snapshot", target: null },
      { id: "r2", description: "填写表单", tool: "fill", target: null },
    ] as never);
    h.emit({ kind: "tool_start", toolCallId: "c9", name: "fill", params: { target: "@3", value: "v" } });
    h.emit({ kind: "tool_end", toolCallId: "c9", name: "fill", isError: false, executionFact: "executed", resultText: "ok" });
    const view = projectTaskView(h.progress.snapshot());
    expect(view.outstanding.length).toBeGreaterThan(0);
    expect(view.state).not.toBe("aborted");
    expect(JSON.stringify(view)).not.toContain("全部完成");
  });
});

describe("A02-06 回执 unknown 明确为未知", () => {
  it("不写成功说明，不生成百分比", () => {
    const h = startedRun();
    h.emit({ kind: "tool_start", toolCallId: "c5", name: "fill", params: { target: "@1", value: "v" } });
    h.emit({ kind: "tool_end", toolCallId: "c5", name: "fill", isError: true, executionFact: "unknown", resultText: "lost" });
    const snap = h.progress.snapshot();
    const view = projectTaskView(snap);
    expect(view.waiting?.reason).toMatch(/^unknown/);
    expect(JSON.stringify(view)).not.toMatch(/\d+%/);
    expect(view.results.some((r) => r.status === "unknown")).toBe(true);
  });
});

describe("A02-07 旧快照兼容与损坏拒绝", () => {
  it("缺少新增字段的旧快照正常投影，未知字段不靠猜填满", () => {
    const h = startedRun();
    const legacy = h.progress.snapshot() as Partial<TaskProgressSnapshot>;
    delete legacy.results;
    delete legacy.nextStep;
    delete legacy.recoveryInput;
    delete legacy.conversationContext;
    const view = projectTaskView(legacy as TaskProgressSnapshot);
    expect(view.results).toEqual([]);
    expect(view.outstanding).toEqual([]);
    expect(view.revisions).toEqual([]);
    expect(view.page).toBeNull();
    expect(view.latestDelivery).toBeNull();
    expect(isTaskView(view)).toBe(true);
  });
  it("损坏字段明确失败，不回退到更早「成功」", () => {
    const view = projectTaskView(startedRun().progress.snapshot());
    expect(isTaskView({ ...view, state: "garbage" })).toBe(false);
    expect(isTaskView({ ...view, conversationId: "" })).toBe(false);
    expect(isTaskView({ ...view, controlVersion: 1.5 })).toBe(false);
    expect(isTaskView(null)).toBe(false);
    expect(isTaskView("running")).toBe(false);
  });
});

describe("A02-08 重连后视图来自持久事实；投影无副作用", () => {
  it("投影是纯函数：同输入两次相等，输入不被改写", () => {
    const h = startedRun();
    const snap = h.progress.snapshot();
    const before = JSON.stringify(snap);
    const v1 = projectTaskView(snap);
    const v2 = projectTaskView(snap);
    expect(v1).toEqual(v2);
    expect(JSON.stringify(snap)).toBe(before);
  });
  it("恢复后再投影与原始一致（修订、页面、任务身份均来自持久事实）", () => {
    const h = startedRun();
    h.progress.observe({ type: "agent_event", event: { kind: "user_delivery", delivery: { conversationId: CID, id: "d1", runId: h.progress.snapshot().runId, kind: "finding", text: "结果", composedAt: 1, status: "delivered" } } } as unknown as ServerMessage);
    const snap = h.progress.snapshot();
    const restored = new TaskProgress(CID, () => 1000);
    restored.restoreResults(snap);
    const live = projectTaskView(snap);
    const replayed = projectTaskView({ ...restored.snapshot(), observedAt: snap.observedAt });
    expect(replayed.goal).toBe(live.goal);
    expect(replayed.page).toEqual(live.page);
    expect(replayed.runId).toBe(live.runId);
    expect(replayed.latestDelivery).toEqual(live.latestDelivery);
  });
});

describe("协议契约：task_view 消息校验", () => {
  it("合法视图通过，损坏视图被 parseServerMessage 拒绝", () => {
    const view = projectTaskView(startedRun().progress.snapshot());
    const ok = parseServerMessage(JSON.stringify({ type: "task_view", conversationId: CID, view }));
    expect(ok).toMatchObject({ type: "task_view" });
    const bad = parseServerMessage(JSON.stringify({ type: "task_view", conversationId: CID, view: { ...view, state: "bogus" } }));
    expect(bad).toBeNull();
  });
});

describe("manager 集成：task_view 随真实状态变化下发与重放", () => {
  it("任务开始/结束/中断都会收到投影，重放时强制重发当前视图", async () => {
    const { ConversationManager } = await import("../src/conversation-manager.js");
    const emitted: ServerMessage[] = [];
    const runtimes = new Map<string, { emit: (m: ServerMessage) => void }>();
    const manager = new ConversationManager(async (id: string, emit: (m: ServerMessage) => void) => {
      runtimes.set(id, { emit });
      return {
        session: { modelName: () => "test/model", availableModels: async () => [], available: true, abort: () => {}, isHeld: () => false, isStreaming: () => false },
        consent: { list: () => [], cancelAll: () => {} },
        fleet: { teamView: () => null, isGroupHeld: () => false, list: () => [], reset: () => {}, abortTeam: () => {} },
        rpc: { rejectAll: () => {} }, dispose: () => {}, handleMessage: () => {},
      } as never;
    }, (m) => emitted.push(m));
    await manager.ensureDefault();
    await manager.handleMessage({ type: "user_message", text: "读一下当前页面" } as ClientMessage);
    runtimes.get("default")!.emit({ type: "agent_event", event: { kind: "agent_start" } });
    // 微任务合并：等一拍让视图发出
    await new Promise((r) => setTimeout(r, 0));
    const views = emitted.filter((m) => m.type === "task_view");
    expect(views.length).toBeGreaterThan(0);
    const last = views.at(-1)!;
    expect(last).toMatchObject({ type: "task_view", conversationId: "default" });
    expect((last as { view: TaskView }).view.goal).toBe("读一下当前页面");
    expect((last as { view: TaskView }).view.state).toBe("running");
    // 重放（面板重开/重连）：强制重发当前视图，内容与最近一次一致
    const before = emitted.length;
    manager.replayState((m) => emitted.push(m));
    const replayed = emitted.slice(before).filter((m) => m.type === "task_view");
    expect(replayed.length).toBeGreaterThan(0);
    // observedAt 是投影时刻，允许前进；其余字段必须一致
    const stripTime = ({ observedAt: _t, ...rest }: TaskView) => rest;
    expect(stripTime((replayed.at(-1) as { view: TaskView }).view)).toEqual(stripTime((last as { view: TaskView }).view));
    manager.dispose();
  });
});
