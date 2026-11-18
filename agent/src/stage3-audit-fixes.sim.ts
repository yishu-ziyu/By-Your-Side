import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationSummary, ServerMessage } from "../../shared/protocol.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";
import { ConversationManager } from "./conversation-manager.js";
import type { ConversationPersistence } from "./conversation-persistence.js";
import { ContinuePolicy } from "./continue-policy.js";
import { createBrowserTools } from "./tools.js";
import { ToolRpc } from "./rpc.js";
import { VoiceService } from "./voice-service.js";

function createTestConversationManager(options?: {
  onStartTask?: (text: string, context: unknown, options: unknown) => void;
  proposeVoice?: (text: string) => { steps: Array<{ action: string; target: string | null; text: string }> };
}) {
  const summaries: ConversationSummary[] = [];
  const emitted: ServerMessage[] = [];
  let streaming = false;
  let held = false;
  let pumpFn: ((msg: ServerMessage) => void) | null = null;

  const persistence: ConversationPersistence = {
    load: () => structuredClone(summaries),
    save: (next) => {
      summaries.splice(0, summaries.length, ...structuredClone(next));
    },
    saveReading: () => {},
  };

  const manager = new ConversationManager(
    async (_id, emit) => {
      pumpFn = emit;
      const session = {
        modelName: () => "custom/fixture",
        available: true,
        isStreaming: () => streaming,
        isHeld: () => held,
        executionEpoch: () => 0,
        setThinking: () => {},
        emitThinkingLevel: () => {},
        bindTaskResults: () => {},
        bindDeliveryRun: () => {},
        bindVoiceTurnGate: () => {},
        bindConversationContext: () => {},
        bindVisitedUrls: () => {},
        readPersistedTaskResults: () => null,
        persistTaskResults: () => {},
        persistAcceptedTask: () => {},
        flushPersistence: async () => {},
        waitForStop: async () => {},
        abort: () => { streaming = false; },
        settleAnswerGate: () => {},
        recoveryContext: async (_snapshot: unknown, context: unknown) => context ?? { tabId: 1, url: "https://shop-a.example/checkout", title: "Shop A" },
        resumeInterruptedTask: async () => { streaming = true; },
        classifyVoiceInput: async (text: string) => (
          options?.proposeVoice?.(text) ?? { steps: [{ action: "listen", target: null, text: "" }] }
        ),
        startTask: (text: string, context: unknown, _attachments: unknown, opts: unknown) => {
          streaming = true;
          options?.onStartTask?.(text, context, opts);
          emit({ type: "status", state: "running" });
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
        handleMessage: () => {},
        dispose: () => {},
      };
      return runtime as never;
    },
    (msg) => emitted.push(msg),
    persistence,
    undefined,
  );

  return {
    manager,
    emitted,
    setStreaming: (next: boolean) => { streaming = next; },
    setHeld: (next: boolean) => { held = next; },
    emitFromRuntime: (msg: ServerMessage) => { pumpFn?.(msg); },
  };
}

test("S3-1: 跨站 waiting 任务不劫持到另一网站的新文字任务，同站仍可续接", async () => {
  const harness = createTestConversationManager();
  await harness.manager.ensureDefault();

  const first = await harness.manager.dispatchTaskAction({
    requestId: "req-shop",
    conversationId: "default",
    source: "text",
    action: "start",
    expectedRunId: null,
    text: "帮我选一下这个商品的配送方式",
    context: { tabId: 1, title: "Shop A", url: "https://shop-a.example/checkout" },
  });
  assert.equal(first.status, "accepted");
  const shopRunId = harness.manager.getTaskProgress("default")?.runId ?? null;
  assert.ok(shopRunId);

  harness.emitFromRuntime({
    type: "agent_event",
    conversationId: "default",
    event: {
      kind: "user_delivery",
      delivery: {
        conversationId: "default",
        id: "del-ask",
        runId: shopRunId,
        kind: "reply",
        text: "请问你要选标准配送还是加急配送？",
        composedAt: Date.now(),
        status: "composed",
      },
    },
  });
  harness.emitFromRuntime({ type: "agent_event", conversationId: "default", event: { kind: "goal_check", status: "open", remaining: "等待用户选择配送方式" } });
  harness.setStreaming(false);
  harness.emitFromRuntime({ type: "agent_event", conversationId: "default", event: { kind: "agent_end" } });
  harness.emitFromRuntime({ type: "status", conversationId: "default", state: "idle" });

  const docsStart = await harness.manager.dispatchTaskAction({
    requestId: "req-docs",
    conversationId: "default",
    source: "text",
    action: "start",
    expectedRunId: shopRunId,
    text: "总结这篇技术文档的重点",
    context: { tabId: 2, title: "Docs B", url: "https://docs-b.example/guide" },
  });
  assert.equal(docsStart.status, "accepted");
  assert.notEqual(docsStart.runId, shopRunId, "切换到 docs-b.example 后不应劫持并沿用 shop-a.example 的 runId");
  assert.equal(docsStart.action, "start");
  assert.equal(harness.manager.getTaskProgress("default")?.goalPage?.url, "https://docs-b.example/guide");
});

test("核对器的自由文本不能作为下一轮执行任务的一部分", () => {
  const policy = new ContinuePolicy(() => 1_000);
  const result = policy.next(
    { status: "continue", remaining: "核对器建议甲", correction: "核对器建议乙" },
    { runId: "r-s32", snapshot: null, goal: "核对订单状态", failed: [] },
  );
  assert.ok("prompt" in result);
  assert.ok(result.prompt.includes("核对订单状态"));
  assert.ok(!result.prompt.includes("核对器建议"), "保留用户原始目标，省略核对器自由文本");
});

test("S3-3: browser_run 前序步骤已执行但后续步骤抛错时不应整包记为 not_executed", async () => {
  const rpc = new ToolRpc(() => {});
  const callFacts: Array<[string, string]> = [];
  const origNote = rpc.noteToolFact.bind(rpc);
  rpc.noteToolFact = (id, fact) => {
    callFacts.push([id, fact]);
    origNote(id, fact);
  };
  let callIndex = 0;
  rpc.call = async (name) => {
    if (name === "list_tabs") return { tabs: [{ id: 1, url: "https://example.com/", title: "Ex", working: true }] };
    callIndex += 1;
    if (callIndex === 1) return { clicked: true, tabId: 1 };
    const err = new Error("pre-press drift blocked");
    (err as Error & { executionFact?: string }).executionFact = "not_executed";
    throw err;
  };

  rpc.ensureToolCall("br-1", "click");
  const tools = createBrowserTools(rpc);
  const browserRun = tools.find((tool) => tool.name === "browser_run");
  assert.ok(browserRun);

  await assert.rejects(
    () => browserRun.execute("br-1", { code: 'await browser.click({ target: "@e1" }); await browser.click({ target: "@e2" });' }, undefined, undefined, undefined as never),
    /pre-press drift blocked/,
  );

  assert.ok(
    callFacts.some(([id, fact]) => id === "br-1" && fact === "executed"),
    `browser_run 已有步骤执行过，应向 RPC 记为 executed，实际记录：${JSON.stringify(callFacts)}`,
  );
});

test("S3-7b: 语音另开会话提议在跨轮或收到插话嗯/继续时不再误建新会话", async () => {
  const setupProposalHarness = async () => {
    const h = createTestConversationManager({
      proposeVoice: (text) => text.includes("打开另一个网址")
        ? { steps: [{ action: "start", target: null, text }] }
        : { steps: [{ action: "listen", target: null, text: "" }] },
    });
    await h.manager.ensureDefault();
    await h.manager.dispatchTaskAction({
      requestId: "req-main",
      conversationId: "default",
      source: "text",
      action: "start",
      expectedRunId: null,
      text: "在当前页继续整理表格",
      context: { tabId: 1, title: "Sheet", url: "https://sheet.example/" },
    });
    const runId = h.manager.getTaskProgress("default")?.runId ?? null;
    h.setStreaming(false);
    h.emitFromRuntime({ type: "agent_event", conversationId: "default", event: { kind: "agent_end" } });
    h.emitFromRuntime({ type: "status", conversationId: "default", state: "idle" });
    h.setHeld(true);
    const target = { id: "default", title: "Sheet", state: "idle" as const, runId, controlVersion: 0 };
    const proposeRes = await h.manager.routeVoiceInput("default", "打开另一个网址看看", null, () => true, {
      requestId: "vr-1",
      voiceId: "v-prop",
      turn: 1,
      runId,
      targets: [target],
      controlVersion: 0,
      onInputDecision: () => {},
    });
    assert.equal(proposeRes.kind, "clarify");
    h.setHeld(false);
    return { h, runId, target };
  };

  const h1 = await setupProposalHarness();
  const umRes = await h1.h.manager.routeVoiceInput("default", "嗯", null, () => true, {
    requestId: "vr-um",
    voiceId: "v-prop",
    turn: 2,
    runId: h1.runId,
    targets: [h1.target],
    controlVersion: 0,
    interruptedSpeech: true,
    onInputDecision: () => {},
  });
  assert.notEqual(umRes.kind, "action", "插话反馈「嗯」不应触发另开会话动作");
  assert.equal(h1.h.manager.list().length, 1);

  const staleTurnRes = await h1.h.manager.routeVoiceInput("default", "好的", null, () => true, {
    requestId: "vr-stale",
    voiceId: "v-prop",
    turn: 3,
    runId: h1.runId,
    targets: [h1.target],
    controlVersion: 0,
    onInputDecision: () => {},
  });
  assert.notEqual(staleTurnRes.kind, "action", "跨越超过一轮后的「好的」不应触发过期另开会话提议");
  assert.equal(h1.h.manager.list().length, 1);

  const h2 = await setupProposalHarness();
  const contRes = await h2.h.manager.routeVoiceInput("default", "继续", null, () => true, {
    requestId: "vr-cont",
    voiceId: "v-prop",
    turn: 2,
    runId: h2.runId,
    targets: [h2.target],
    controlVersion: 0,
    onInputDecision: () => {},
  });
  assert.notEqual(contRes.kind, "action", "「继续」不应作为另开会话确认词创建新会话");
  assert.equal(h2.h.manager.list().length, 1);

  const h3 = await setupProposalHarness();
  const confirmRes = await h3.h.manager.routeVoiceInput("default", "好的，另开会话", null, () => true, {
    requestId: "vr-yes",
    voiceId: "v-prop",
    turn: 2,
    runId: h3.runId,
    targets: [h3.target],
    controlVersion: 0,
    onInputDecision: () => {},
  });
  assert.equal(confirmRes.kind, "action", "紧邻下一轮明确说出「好的，另开会话」仍应正常新建会话");
  assert.equal(h3.h.manager.list().length, 2);
});

test("S3-7c: 语音意外断线期间完成的交付在 60 秒内重连就绪后应补播，而冷启动不重播历史", async () => {
  let snap: TaskProgressSnapshot = {
    conversationId: "conv-v",
    observedAt: 1000,
    state: "running",
    goal: "帮我查机票",
    startedAt: 1000,
    runId: "run-v1",
    active: [],
    lastAction: null,
    successVerified: false,
    results: [],
    conversationContext: { recentTurns: [], latestResult: null, latestDelivery: null },
  };
  const sessions: Array<{ emit: (ev: unknown) => void; notifies: number }> = [];
  const service = new VoiceService(
    () => snap,
    () => {},
    async () => "k",
    (deps) => {
      const rec = { emit: deps.emit as (ev: unknown) => void, notifies: 0 };
      sessions.push(rec);
      return {
        start: () => {},
        command: () => {},
        close: () => {},
        notify: () => { rec.notifies += 1; },
        streamDelivery: () => {},
        completeDelivery: () => {},
      };
    },
  );

  await service.handle("conv-v", { type: "voice", voiceId: "v-1", command: { kind: "start" } });
  const firstStartedAt = Date.now();
  sessions[0]!.emit({ kind: "state", state: "ready", inputMode: "ptt" });
  sessions[0]!.emit({ kind: "state", state: "closed" });

  snap = {
    ...snap,
    state: "idle",
    observedAt: firstStartedAt + 50,
    conversationContext: {
      recentTurns: [],
      latestResult: { runId: "run-v1", text: "最低票价 860 元。", observedAt: firstStartedAt + 50, source: "assistant_output" },
      latestDelivery: {
        conversationId: "conv-v",
        id: "del-missed",
        runId: "run-v1",
        kind: "finding",
        text: "最低票价 860 元。",
        composedAt: firstStartedAt + 50,
        status: "composed",
      },
    },
  };

  await service.handle("conv-v", { type: "voice", voiceId: "v-2", command: { kind: "start", reconnectOf: "v-1" } });
  sessions[1]!.emit({ kind: "state", state: "ready", inputMode: "ptt" });
  assert.equal(sessions[1]!.notifies, 1, "60 秒内重连就绪后应补播断线期间刚完成且未播报的交付");

  sessions[1]!.emit({ kind: "state", state: "closed" });
  snap.conversationContext!.latestDelivery = { ...snap.conversationContext!.latestDelivery!, id: "del-new", composedAt: Date.now() + 10 };
  await service.handle("conv-v", { type: "voice", voiceId: "v-manual", command: { kind: "start" } });
  sessions[2]!.emit({ kind: "state", state: "ready" });
  assert.equal(sessions[2]!.notifies, 0, "在同一后台手动开启语音时，不补播此前的交付");

  const coldSessions: number[] = [];
  const coldService = new VoiceService(
    () => snap,
    () => {},
    async () => "k",
    (deps) => {
      const idx = coldSessions.push(0) - 1;
      queueMicrotask(() => (deps.emit as (ev: unknown) => void)({ kind: "state", state: "ready", inputMode: "ptt" }));
      return {
        start: () => {},
        command: () => {},
        close: () => {},
        notify: () => { coldSessions[idx]! += 1; },
        streamDelivery: () => {},
        completeDelivery: () => {},
      };
    },
  );
  await coldService.handle("conv-v", { type: "voice", voiceId: "v-cold", command: { kind: "start" } });
  await Promise.resolve();
  assert.equal(coldSessions[0], 0, "全新冷启动语音时不应重播历史已完成交付");
});
