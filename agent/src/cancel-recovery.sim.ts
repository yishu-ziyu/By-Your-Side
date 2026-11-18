import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationSummary, ServerMessage } from "../../shared/protocol.js";
import type { TaskRecord } from "../../shared/task-record.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";
import type { ConversationPersistence } from "./conversation-persistence.js";
import { ConversationManager } from "./conversation-manager.js";
import { TaskRecordStore } from "./task-record-store.js";
import { TaskProgress } from "./task-progress.js";
import { renderFactCheck } from "../../extension/src/sidepanel/fact-check-note.js";

function createHarnessStorage() {
  let summaries: ConversationSummary[] = [];
  let persistedSnapshot: TaskProgressSnapshot | null = null;
  let recordsRaw: string | null = null;

  const persistence: ConversationPersistence = {
    load: () => structuredClone(summaries),
    save: (next) => { summaries = structuredClone(next); },
    saveReading: () => {},
  };

  const taskRecords = new TaskRecordStore({
    read: async () => recordsRaw,
    write: async (text) => { recordsRaw = text; },
    exclusive: async (fn) => fn(),
  });

  const makeManager = (emitted: ServerMessage[], opts?: { paused?: boolean; waitForStop?: () => Promise<void> }) => {
    let held = opts?.paused ?? false;

    const manager = new ConversationManager(
      async (_id, emit) => {
        const session = {
          modelName: () => "custom/fixture",
          available: true,
          isStreaming: () => false,
          isHeld: () => held,
          executionEpoch: () => 0,
          setThinking: () => {},
          emitThinkingLevel: () => {},
          bindTaskResults: () => {},
          bindDeliveryRun: () => {},
          bindVoiceTurnGate: () => {},
          bindConversationContext: () => {},
          bindVisitedUrls: () => {},
          readPersistedTaskResults: () => structuredClone(persistedSnapshot),
          persistTaskResults: (s: TaskProgressSnapshot) => { persistedSnapshot = structuredClone(s); },
          persistAcceptedTask: (s: TaskProgressSnapshot) => { persistedSnapshot = structuredClone(s); },
          flushPersistence: async () => {},
          waitForStop: opts?.waitForStop ?? (async () => {}),
          abort: () => { held = false; },
          settleAnswerGate: () => {},
          startTask: () => {
            emit({ type: "status", state: held ? "user" : "running" });
            emit({ type: "agent_event", event: { kind: "agent_start" } });
          },
          dispose: () => {},
        };
        const runtime = {
          session,
          rpc: {},
          control: { setTabCoordinator: () => {}, setIdleOwnerCheck: () => {}, isGroupHeld: () => false },
          onHandToUser: () => {},
          onWaitForCondition: () => {},
          handleMessage: (msg: { type: string }) => {
            if (msg.type === "abort") {
              held = false;
              emit({ type: "status", state: "idle" });
            }
          },
          dispose: () => {},
        };
        return runtime as never;
      },
      (msg) => emitted.push(msg),
      persistence,
      undefined,
    );
    manager.taskRecords = taskRecords;

    return {
      manager,
      setHeld: (next: boolean) => { held = next; },
    };
  };

  return {
    taskRecords,
    makeManager,
    setSnapshot: (s: TaskProgressSnapshot | null) => { persistedSnapshot = structuredClone(s); },
    getSnapshot: () => structuredClone(persistedSnapshot),
    setSummaries: (s: ConversationSummary[]) => { summaries = structuredClone(s); },
    writeTaskRecords: async (tasks: TaskRecord[]) => {
      recordsRaw = JSON.stringify({ format: 1, tasks });
    },
  };
}

test("非流式 interrupted 任务收到无 taskRequestId 的 abort 后重启不再恢复为 interrupted", async () => {
  const storage = createHarnessStorage();
  const id = "conv-interrupted";
  const runningSnap: TaskProgressSnapshot = {
    conversationId: id,
    observedAt: 1000,
    state: "running",
    goal: "测试中断停止",
    startedAt: 1000,
    runId: "run-1",
    active: [],
    lastAction: null,
    successVerified: false,
    results: [],
  };
  storage.setSummaries([{ id, title: "中断任务", createdAt: 1000, updatedAt: 1000, state: "idle", mode: "act", runId: "run-1" }]);
  storage.setSnapshot(runningSnap);
  await storage.writeTaskRecords([{
    id: "task-1",
    originConversationId: id,
    executionConversationId: id,
    runId: "run-1",
    goal: "测试中断停止",
    revision: 0,
    controlVersion: 0,
    state: "running",
    updatedAt: 1000,
  }]);

  const firstEmitted: ServerMessage[] = [];
  const first = storage.makeManager(firstEmitted);
  await first.manager.ensureDefault();
  assert.equal(first.manager.getTaskProgress(id)?.state, "interrupted");

  await first.manager.handleMessage({ type: "abort", conversationId: id });
  assert.equal(first.manager.getTaskProgress(id)?.state, "aborted");

  const secondEmitted: ServerMessage[] = [];
  const second = storage.makeManager(secondEmitted);
  await second.manager.ensureDefault();
  const summary = second.manager.list().find((item) => item.id === id);
  assert.equal(summary?.checkpoint, undefined);
  assert.equal(second.manager.getTaskProgress(id)?.state, "aborted");
  assert.equal(
    secondEmitted.some((msg) => msg.type === "agent_event" && msg.conversationId === id && msg.event.kind === "notice" && msg.event.message.includes("中断")),
    false,
  );
});

test("非流式 paused 任务收到带 taskRequestId 的 abort 后重启保持取消且记录为 cancelled", async () => {
  const storage = createHarnessStorage();
  const id = "conv-paused";
  const pausedSnap: TaskProgressSnapshot = {
    conversationId: id,
    observedAt: 1000,
    state: "paused",
    goal: "暂停测试任务",
    startedAt: 1000,
    runId: "run-p1",
    active: [],
    lastAction: null,
    successVerified: false,
    results: [],
  };
  storage.setSummaries([{ id, title: "暂停任务", createdAt: 1000, updatedAt: 1000, state: "user", mode: "act", runId: "run-p1" }]);
  storage.setSnapshot(pausedSnap);
  await storage.writeTaskRecords([{
    id: "task-p1",
    originConversationId: id,
    executionConversationId: id,
    runId: "run-p1",
    goal: "暂停测试任务",
    revision: 0,
    controlVersion: 0,
    state: "paused",
    updatedAt: 1000,
  }]);

  const firstEmitted: ServerMessage[] = [];
  const first = storage.makeManager(firstEmitted, { paused: true });
  await first.manager.ensureDefault();

  const controlPromise = first.manager.controls.request(id, "req-abort-paused", "abort", "run-p1");
  await Promise.resolve();
  await first.manager.handleMessage({ type: "abort", conversationId: id, taskRequestId: "req-abort-paused" });
  const ack = firstEmitted.find((msg) => msg.type === "task_control_ack");
  assert.ok(ack && ack.type === "task_control_ack" && ack.ok);
  first.manager.controls.receive({ type: "task_control_result", conversationId: id, requestId: "req-abort-paused", action: "abort", runId: "run-p1", ok: true });
  await controlPromise;

  const savedRecord = await storage.taskRecords.get("task-p1");
  assert.equal(savedRecord?.state, "cancelled");

  const secondEmitted: ServerMessage[] = [];
  const second = storage.makeManager(secondEmitted);
  await second.manager.ensureDefault();
  const summary = second.manager.list().find((item) => item.id === id);
  assert.equal(summary?.checkpoint, undefined);
  assert.equal(second.manager.getTaskProgress(id)?.state, "aborted");
});

test("后台还在等待停稳时，取消记录已可用于重启恢复", async () => {
  const storage = createHarnessStorage();
  const id = "conv-stop-in-flight";
  const snapshot: TaskProgressSnapshot = {
    conversationId: id, observedAt: 1000, state: "running", goal: "保留作业结果", startedAt: 1000,
    runId: "run-stop", active: [], lastAction: null, successVerified: false, results: [],
  };
  storage.setSnapshot(snapshot);
  storage.setSummaries([{ id, title: "正在收尾", createdAt: 1000, updatedAt: 1000, state: "running", mode: "act", runId: "run-stop" }]);
  await storage.writeTaskRecords([{
    id: "task-stop", originConversationId: id, executionConversationId: id, runId: "run-stop",
    goal: snapshot.goal!, revision: 0, controlVersion: 0, state: "running", updatedAt: 1000,
  }]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { manager } = storage.makeManager([], { waitForStop: () => { entered.resolve(); return release.promise; } });
  await manager.ensureDefault();
  const stopping = manager.handleMessage({ type: "abort", conversationId: id });
  try {
    await entered.promise;
    assert.equal((await storage.taskRecords.get("task-stop"))?.state, "cancelled", "等待旧运行停稳前先保存取消");
    const restarted = storage.makeManager([]).manager;
    await restarted.ensureDefault();
    assert.equal(restarted.getTaskProgress(id)?.state, "aborted");
  } finally {
    release.resolve();
    await stopping;
  }
});

test("崩溃窗口恢复：taskRecords 已记 cancelled 但会话快照停留在 running 时不误报中断且立即落盘修正", async () => {
  const storage = createHarnessStorage();
  const id = "conv-crash-window";
  storage.setSummaries([{ id, title: "崩溃窗口", createdAt: 1000, updatedAt: 1000, state: "running", mode: "act", runId: "run-c1" }]);
  storage.setSnapshot({
    conversationId: id,
    observedAt: 1000,
    state: "running",
    goal: "刚点停止就崩溃",
    startedAt: 1000,
    runId: "run-c1",
    active: [],
    lastAction: null,
    successVerified: false,
    results: [],
  });
  await storage.writeTaskRecords([{
    id: "task-c1",
    originConversationId: id,
    executionConversationId: id,
    runId: "run-c1",
    goal: "刚点停止就崩溃",
    revision: 0,
    controlVersion: 1,
    state: "cancelled",
    updatedAt: 1500,
  }]);

  const emitted: ServerMessage[] = [];
  const { manager } = storage.makeManager(emitted);
  await manager.ensureDefault();

  const summary = manager.list().find((item) => item.id === id);
  assert.equal(summary?.checkpoint, undefined);
  assert.equal(summary?.state, "idle");
  assert.equal(manager.getTaskProgress(id)?.state, "aborted");
  assert.equal(storage.getSnapshot()?.state, "aborted");
  assert.equal(
    emitted.some((msg) => msg.type === "agent_event" && msg.conversationId === id && msg.event.kind === "notice"),
    false,
  );
});

test("TaskProgress.abort 后拒绝迟到结果改写任务项状态", () => {
  const progress = new TaskProgress("conv-late", () => 1000);
  progress.request("点保存");
  progress.observe({ type: "agent_event", event: { kind: "agent_start" } });
  progress.observe({ type: "agent_event", event: { kind: "tool_start", toolCallId: "tc-1", name: "click", params: { target: "#save" } } });
  progress.observe({ type: "agent_event", event: { kind: "tool_end", toolCallId: "tc-1", name: "click", isError: true, executionFact: "unknown", resultText: "timeout" } });
  assert.equal(progress.snapshot().results?.[0]?.status, "unknown");

  progress.abort();
  assert.equal(progress.handleLateResult("tc-1", true), false);
  assert.equal(progress.snapshot().results?.[0]?.status, "unknown");
});

test("renderFactCheck 携带 answerId 时精准更新目标气泡而不误改同前缀后续气泡", () => {
  const makeBubble = (deliveryId: string, markdown: string) => ({
    dataset: { deliveryId, markdown } as Record<string, string>,
    textContent: markdown,
    querySelector: () => null,
  });
  const oldBubble = makeBubble("d-old", "当前库存为 12 件。");
  const newBubble = makeBubble("d-new", "当前库存为 12 件。");
  const messages = {
    querySelectorAll: () => [oldBubble, newBubble],
  };

  let replacedId = "";
  const hit = renderFactCheck(
    { answer: "当前库存为 12 件。", problems: [], replacement: "当前库存为 15 件。", answerId: "d-old" } as never,
    messages as unknown as HTMLElement,
    (el) => { replacedId = el.dataset.deliveryId ?? ""; },
  );
  assert.equal(hit, oldBubble as unknown as HTMLElement);
  assert.equal(replacedId, "d-old");
});
