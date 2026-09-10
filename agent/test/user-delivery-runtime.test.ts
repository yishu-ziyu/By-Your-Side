import { describe, expect, it, vi } from "vitest";
import { TaskProgress } from "../src/task-progress.js";
import { VoiceService } from "../src/voice-service.js";
import { progressSpeech, receiptSpeech } from "../src/voice-receipt.js";
import { ConversationManager } from "../src/conversation-manager.js";
import { assertDeliveryText, createSendUserMessageTool, createUserDelivery, isLeadDeliveryHost } from "../src/user-delivery.js";
import { UserDeliveryLedger } from "../src/user-delivery-ledger.js";
import type { AgentUiEvent } from "../../shared/protocol.js";
import type { UserDelivery } from "../../shared/voice.js";

const facts = "内部工作记录：竹海工作坊活动邀请；星浦研究访谈邀请。仅读标题，未打开正文。";
const speech = "竹海工作坊发来活动邀请，星浦研究发来访谈邀请。我目前只看了标题，还没打开正文。";

function harness() {
  const p = new TaskProgress("default", () => 100);
  p.request("看看最近邮件，先不打开正文");
  const runId = p.snapshot().runId!;
  const emit = (event: AgentUiEvent, extra: Record<string, unknown> = {}) =>
    p.observe({ type: "agent_event", conversationId: "default", runId, event, ...extra } as any);
  emit({ kind: "agent_start", deliveryMode: "explicit" });
  const delivery = (extra: Partial<UserDelivery> = {}): UserDelivery => ({
    conversationId: "default", id: "delivery-one", runId, kind: "finding", text: speech, composedAt: 100, status: "composed", ...extra,
  });
  return { p, runId, emit, delivery };
}

describe("TaskProgress delivery wiring", () => {
  it("keeps internal text as facts and only records an explicit delivery as the user turn", () => {
    const h = harness();
    h.emit({ kind: "text_delta", delta: facts });
    h.emit({ kind: "agent_end" });
    const before = h.p.snapshot().conversationContext!;
    expect(before.latestResult?.text).toBe(facts);
    expect(before.latestDelivery ?? null).toBeNull();
    expect(before.recentTurns.some(t => t.role === "assistant" && t.text === facts)).toBe(false);
    h.emit({ kind: "user_delivery", delivery: h.delivery() });
    h.emit({ kind: "user_delivery", delivery: h.delivery() });
    const after = h.p.snapshot().conversationContext!;
    expect(after.latestDelivery).toMatchObject({ id: "delivery-one", text: speech, kind: "finding" });
    expect(after.latestResult?.text).toBe(facts);
    expect(after.recentTurns.filter(t => t.role === "assistant" && t.text === speech)).toHaveLength(1);
    expect(h.p.hasFinding()).toBe(true);
  });

  it("rejects worker, other conversation, stale run and a late delivery after a new run", () => {
    const h = harness();
    h.emit({ kind: "user_delivery", delivery: h.delivery() }, { sessionId: "worker-1" });
    h.emit({ kind: "user_delivery", delivery: h.delivery({ conversationId: "other" }) });
    h.emit({ kind: "user_delivery", delivery: h.delivery({ runId: "stale-run" }) });
    expect(h.p.snapshot().conversationContext?.latestDelivery ?? null).toBeNull();
    const old = h.delivery();
    h.emit({ kind: "agent_end" });
    h.p.request("新的地图任务");
    h.p.observe({ type: "agent_event", conversationId: "default", runId: h.p.snapshot().runId, event: { kind: "user_delivery", delivery: old } } as any);
    expect(h.p.snapshot().conversationContext?.latestDelivery ?? null).toBeNull();
  });

  it("keeps ack distinct from a finding the run still owes", () => {
    const h = harness();
    h.emit({ kind: "user_delivery", delivery: h.delivery({ kind: "ack", text: "收到，我先看标题。" }) });
    expect(h.p.snapshot().conversationContext?.latestDelivery?.kind).toBe("ack");
    expect(h.p.snapshot().conversationContext?.latestResult).toBeNull();
    expect(h.p.hasFinding()).toBe(false);
  });
});

describe("send_user_message host tool", () => {
  it("rejects empty or overlong content instead of truncating", () => {
    expect(() => assertDeliveryText("")).toThrow(/不能为空/);
    expect(() => assertDeliveryText("x".repeat(2001))).toThrow(/过长/);
    expect(() => createUserDelivery({ conversationId: "default", runId: "run-a", kind: "finding", text: "x".repeat(2001) })).toThrow(/过长|无效/);
  });

  it("registers Lead delivery by conversationId, not by memory store", () => {
    expect(isLeadDeliveryHost("default")).toBe(true);
    expect(isLeadDeliveryHost(undefined)).toBe(false);
    expect(isLeadDeliveryHost("")).toBe(false);
  });

  it("rejects reply on the host task tool so final results stay finding", async () => {
    const events: AgentUiEvent[] = [];
    const tool = createSendUserMessageTool({ conversationId: "default", getRunId: () => "run-a", emit: e => events.push(e), clock: () => 1 });
    await expect(tool.execute("call-reply", { kind: "reply", content: speech } as any, undefined, undefined, {} as any)).rejects.toThrow(/finding/);
    expect(events).toHaveLength(0);
  });

  it("emits one user_delivery bound to the current run", async () => {
    const events: AgentUiEvent[] = [];
    const tool = createSendUserMessageTool({ conversationId: "default", getRunId: () => "run-a", emit: e => events.push(e), clock: () => 7 });
    const result = await tool.execute("call-1", { kind: "finding", content: speech }, undefined, undefined, {} as any);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^delivered:/) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "user_delivery", delivery: { conversationId: "default", runId: "run-a", kind: "finding", text: speech, status: "composed", composedAt: 7 } });
  });
});

describe("voice consumption", () => {
  it("does not let a finding override pause, abort or error speech", () => {
    const h = harness();
    for (const [state, word] of [["paused", "暂停"], ["aborted", "终止"], ["error", "问题"]] as const) {
      const snapshot: any = { ...h.p.snapshot(), state, conversationContext: { recentTurns: [], latestResult: { runId: h.runId, text: facts, observedAt: 100, source: "assistant_output" }, latestDelivery: h.delivery() } };
      expect(progressSpeech(snapshot)).toContain(word);
      expect(receiptSpeech({ kind: "none", resumeReadOnly: "status", snapshot, spokenText: progressSpeech(snapshot) })).toContain(word);
    }
  });

  it("announces a finding that arrived while running once execution is idle", async () => {
    const h = harness();
    let current: any = { ...h.p.snapshot(), state: "running", conversationContext: { recentTurns: [], latestResult: null, latestDelivery: null } };
    const notifications: any[] = [];
    const service = new VoiceService(() => current, () => {}, async () => "synthetic", () => ({ start() {}, command() {}, close() {}, notify(s: any) { notifications.push(s); } } as any));
    try {
      await service.handle("default", { type: "voice", voiceId: "voice-running", command: { kind: "start" } });
      current = { ...current, conversationContext: { ...current.conversationContext, latestDelivery: h.delivery() } };
      service.observe({ type: "agent_event", conversationId: "default", event: { kind: "user_delivery", delivery: h.delivery() } } as any);
      expect(notifications).toHaveLength(0);
      current = { ...current, state: "idle", conversationContext: { ...current.conversationContext, latestResult: { runId: h.runId, text: facts, observedAt: 101, source: "assistant_output" } } };
      service.observe({ type: "status", conversationId: "default", state: "idle" });
      service.observe({ type: "agent_event", conversationId: "default", event: { kind: "agent_end" } });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].conversationContext.latestDelivery.id).toBe("delivery-one");
    } finally { service.close(); }
  });

  it("announces a finding once and does not replay it on reopen", async () => {
    const h = harness();
    let current: any = { ...h.p.snapshot(), state: "idle", conversationContext: { recentTurns: [], latestResult: { runId: h.runId, text: facts, observedAt: 100, source: "assistant_output" }, latestDelivery: null } };
    const notified: any[] = [];
    const service = new VoiceService(() => current, () => {}, async () => "synthetic", () => ({ start() {}, command() {}, close() {}, notify(s: any) { notified.push(s); } } as any));
    try {
      await service.handle("default", { type: "voice", voiceId: "voice-first", command: { kind: "start" } });
      expect(notified).toHaveLength(0);
      current = { ...current, conversationContext: { ...current.conversationContext, latestDelivery: h.delivery() } };
      const event: any = { type: "agent_event", conversationId: "default", event: { kind: "user_delivery", delivery: h.delivery() } };
      service.observe(event);
      service.observe(event);
      expect(notified).toHaveLength(1);
      current = { ...current, conversationContext: { ...current.conversationContext, latestDelivery: h.delivery({ status: "played" }) } };
      service.observe({ ...event, event: { kind: "user_delivery", delivery: current.conversationContext.latestDelivery } });
      expect(notified).toHaveLength(1);
      await service.handle("default", { type: "voice", voiceId: "voice-first", command: { kind: "stop" } });
      await service.handle("default", { type: "voice", voiceId: "voice-second", command: { kind: "start" } });
      expect(notified).toHaveLength(1);
    } finally {
      service.close();
    }
  });
});

describe("UserDeliveryLedger bookkeeping used by TaskProgress", () => {
  it("does not let a late ack replace a finding", () => {
    const l = new UserDeliveryLedger("default");
    l.beginRun("run-a");
    expect(l.record({ conversationId: "default", id: "ack-first", runId: "run-a", kind: "ack", text: "收到。", composedAt: 1, status: "composed" })).toBe(true);
    expect(l.hasFinding()).toBe(false);
    expect(l.record({ conversationId: "default", id: "delivery-a", runId: "run-a", kind: "finding", text: speech, composedAt: 100, status: "composed" })).toBe(true);
    expect(l.hasFinding()).toBe(true);
    l.record({ conversationId: "default", id: "ack-late", runId: "run-a", kind: "ack", text: "又收到。", composedAt: 200, status: "composed" });
    expect(l.latest()?.id).toBe("delivery-a");
  });
});

describe("delivery closure", () => {
  function fixture() {
    const messages: any[] = [];
    let publish: (e: any) => void = () => {};
    let streaming = false;
    let answer: (text: string) => void = () => {};
    const compose = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    const manager = new ConversationManager(async (_id, emit) => {
      publish = e => { if (e.kind === "agent_start") streaming = true; if (e.kind === "agent_end" || e.kind === "error") streaming = false; emit({ type: "agent_event", event: e }); };
      return { session: { available: true, modelName: () => "test", isStreaming: () => streaming, isHeld: () => false, classifyVoiceInput: async (text: string) => ({ steps: [{ action: "chat", text, target: null }] }), composeUserDelivery: compose, abort: () => { streaming = false; } }, fleet: { teamView: () => null, isGroupHeld: () => false, abortTeam: () => {}, reset: () => {} }, rpc: { rejectAll: () => {} }, handleMessage: (m: any) => { if (m.type === "user_message") publish({ kind: "agent_start" }); }, dispose: () => {} } as any;
    }, m => messages.push(m));
    return { manager, messages, compose, event: (e: any) => publish(e), resolve: (text: string) => answer(text) };
  }
  it("drops a late makeup finding after the run errors", async () => {
    const h = fixture();
    try {
      await h.manager.ensureDefault();
      await h.manager.handleMessage({ type: "user_message", conversationId: "default", text: "只读邮件标题" });
      h.event({ kind: "text_delta", delta: facts });
      h.event({ kind: "agent_end" });
      expect(h.compose).toHaveBeenCalledTimes(1);
      h.event({ kind: "error", message: "任务读取失败" });
      h.resolve("找到活动邀请。");
      await new Promise(r => setTimeout(r, 10));
      expect(h.messages.filter(m => m.event?.kind === "user_delivery" && m.event.delivery.kind === "finding")).toHaveLength(0);
      expect(h.manager.getTaskProgress("default")!.state).toBe("error");
    } finally { h.manager.dispose(); }
  });
  it("does not retag a late delivery onto a newer text-started run", async () => {
    const h = fixture();
    try {
      await h.manager.ensureDefault();
      await h.manager.handleMessage({type:"user_message",conversationId:"default",text:"只读邮件标题"});
      const old=h.manager.getTaskProgress("default")!.runId!;
      h.event({kind:"user_delivery",delivery:{conversationId:"default",id:"old-finding",runId:old,kind:"finding",text:facts,composedAt:100,status:"composed"}});
      h.event({kind:"text_delta",delta:facts});h.event({kind:"agent_end"});
      await h.manager.handleMessage({type:"user_message",conversationId:"default",text:"开始一个新的地图任务"});
      expect(h.manager.getTaskProgress("default")!.runId).not.toBe(old);
      h.event({kind:"user_delivery",delivery:{conversationId:"default",id:"late-reply",runId:old,kind:"reply",text:speech,composedAt:101,status:"composed"}});
      expect(h.manager.getTaskProgress("default")!.conversationContext?.latestDelivery??null).toBeNull();
    } finally {h.manager.dispose();}
  });
  it("records the actual spoken ack and maps playback to that delivery id", () => {
    const h = harness();
    h.p.observe({ type: "agent_event", conversationId: "default", runId: h.runId, event: { kind: "user_delivery", delivery: h.delivery({ kind: "ack", text: "收到，这就去看邮件标题。" }) } } as any);
    expect(h.p.snapshot().conversationContext?.latestDelivery?.text).toBe("收到，这就去看邮件标题。");
    expect(h.p.hasFinding()).toBe(false);
    const finding = h.delivery();
    h.p.observe({ type: "agent_event", conversationId: "default", runId: h.runId, event: { kind: "user_delivery", delivery: finding } } as any);
    expect(h.p.markPlayback("unknown", "played")).toBeNull();
    expect(h.p.markPlayback(finding.id, "speaking")?.status).toBe("speaking");
    expect(h.p.markPlayback(finding.id, "played")?.status).toBe("played");
    expect(h.p.markPlayback(finding.id, "speaking")?.status).toBe("played");
  });
});
