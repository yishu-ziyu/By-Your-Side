import { describe, expect, it, vi } from "vitest";
import { TaskProgress } from "../src/task-progress.js";
import { ConversationManager } from "../src/conversation-manager.js";
import { isTaskProgressSnapshot, isVoiceConversationContext } from "../../shared/voice.js";
import type { ServerMessage } from "../../shared/protocol.js";

const ev = (event: object, sessionId?: string): ServerMessage =>
  ({ type: "agent_event", conversationId: "c", event, ...(sessionId ? { sessionId } : {}) }) as ServerMessage;

function runWithResult(p: TaskProgress, text: string, result: string) {
  p.request(text);
  p.observe(ev({ kind: "agent_start" }));
  p.observe(ev({ kind: "turn_start" }));
  p.observe(ev({ kind: "text_delta", delta: result }));
  p.observe(ev({ kind: "turn_end" }));
  p.observe(ev({ kind: "agent_end" }));
}

describe("TaskProgress conversationContext", () => {
  it("captures only the final lead turn text as the sourced result", () => {
    const p = new TaskProgress("c");
    p.request("看一下最近邮箱有什么");
    p.observe(ev({ kind: "agent_start" }));
    p.observe(ev({ kind: "text_delta", delta: "我正在打开邮箱。" }));
    p.observe(ev({ kind: "tool_start", toolCallId: "t", name: "snapshot", params: {} }));
    p.observe(ev({ kind: "tool_end", toolCallId: "t", name: "snapshot", isError: false, resultText: "RAW_PAGE_EXCLUDED" }));
    p.observe(ev({ kind: "turn_start" }));
    p.observe(ev({ kind: "text_delta", delta: "青鹭工作坊发来活动邀请。" }));
    p.observe(ev({ kind: "turn_end" }));
    p.observe(ev({ kind: "agent_end" }));
    const s = p.snapshot();
    expect(s.conversationContext?.latestResult).toMatchObject({ runId: s.runId, text: "青鹭工作坊发来活动邀请。", source: "assistant_output" });
    expect(JSON.stringify(s.conversationContext)).not.toContain("RAW_PAGE_EXCLUDED");
    expect(JSON.stringify(s.conversationContext)).not.toContain("我正在打开");
    expect(s.conversationContext?.recentTurns).toEqual([
      { role: "user", text: "看一下最近邮箱有什么" },
    ]);
    expect(s.successVerified).toBe(false);
    expect(isTaskProgressSnapshot(s)).toBe(true);
    // Explicit delivery is what the user was told; raw evidence alone is not a reply.
    p.observe(ev({ kind: "user_delivery", delivery: {
      conversationId: "c", id: "finding-one", runId: s.runId,
      kind: "finding", text: "青鹭工作坊发来活动邀请。", composedAt: 200, status: "composed",
    } }));
    expect(p.snapshot().conversationContext?.recentTurns).toEqual([
      { role: "user", text: "看一下最近邮箱有什么" },
      { role: "assistant", text: "青鹭工作坊发来活动邀请。" },
    ]);
  });

  it("excludes worker text and keeps conversations isolated by member", () => {
    const p = new TaskProgress("c");
    p.request("A邮箱");
    p.observe(ev({ kind: "agent_start" }));
    p.observe(ev({ kind: "text_delta", delta: "WORKER_PRIVATE_INTERMEDIATE" }, "worker"));
    p.observe(ev({ kind: "turn_start" }));
    p.observe(ev({ kind: "text_delta", delta: "主任务最终结果" }));
    p.observe(ev({ kind: "agent_end" }));
    expect(JSON.stringify(p.snapshot().conversationContext)).not.toContain("WORKER_PRIVATE");
  });

  it("publishes no result for failed, empty, aborted or superseded runs", () => {
    const p = new TaskProgress("c");
    runWithResult(p, "读邮箱", "第一版结果");
    const oldRun = p.snapshot().runId;
    p.request("现在看地图");
    expect(p.snapshot().runId).not.toBe(oldRun);
    expect(p.snapshot().conversationContext?.latestResult ?? null).toBeNull();
    p.observe(ev({ kind: "agent_start" }));
    p.observe(ev({ kind: "agent_end" })); // 空响应
    expect(p.snapshot().conversationContext?.latestResult ?? null).toBeNull();
    p.request("再次读地图");
    p.observe(ev({ kind: "agent_start" }));
    p.observe(ev({ kind: "text_delta", delta: "准备查看" }));
    p.observe(ev({ kind: "error", message: "upstream failed" }));
    p.observe(ev({ kind: "agent_end" }));
    expect(p.snapshot().state).toBe("error");
    expect(p.snapshot().conversationContext?.latestResult ?? null).toBeNull();
    // 错误可在 agent_end 之后到达（生产时序）
    p.request("又一次");
    p.observe(ev({ kind: "agent_start" }));
    p.observe(ev({ kind: "text_delta", delta: "部分文字" }));
    p.observe(ev({ kind: "agent_end" }));
    p.observe(ev({ kind: "error", message: "late failure" }));
    expect(p.snapshot().conversationContext?.latestResult ?? null).toBeNull();
  });

  it("drops a premature capture when the same run retries", () => {
    const p = new TaskProgress("c");
    p.request("读邮箱");
    p.observe(ev({ kind: "agent_start" }));
    p.observe(ev({ kind: "text_delta", delta: "半途文字" }));
    p.observe(ev({ kind: "agent_end" })); // 若被误采
    p.observe(ev({ kind: "agent_start" })); // 重试继续同一 run
    expect(p.snapshot().conversationContext?.latestResult ?? null).toBeNull();
    p.observe(ev({ kind: "turn_start" }));
    p.observe(ev({ kind: "text_delta", delta: "真正结果" }));
    p.observe(ev({ kind: "agent_end" }));
    expect(p.snapshot().conversationContext?.latestResult?.text).toBe("真正结果");
  });

  it("bounds turns and text, and keeps old results only as turns", () => {
    const p = new TaskProgress("c");
    for (let i = 0; i < 15; i++) runWithResult(p, `任务${i} ${"长".repeat(2100)}`, `结果${i}`);
    const s = p.snapshot();
    expect(s.conversationContext?.recentTurns.length).toBeLessThanOrEqual(12);
    for (const t of s.conversationContext?.recentTurns ?? []) expect(t.text.length).toBeLessThanOrEqual(2000);
    expect(s.conversationContext?.latestResult?.text).toBe("结果14");
    expect(s.conversationContext?.latestResult!.text.length).toBeLessThanOrEqual(6000);
    expect(isTaskProgressSnapshot(s)).toBe(true);
  });
});

describe("voice user turns in recentTurns", () => {
  it("records voice originals once per request and never twice for a replay or a following start", () => {
    const p = new TaskProgress("c");
    p.recordUserTurn("不是访谈，是活动邀请", "req-1");
    p.recordUserTurn("不是访谈，是活动邀请", "req-1"); // 同请求重放
    p.recordUserTurn("那个呢", "req-2");
    expect(p.snapshot().conversationContext?.recentTurns).toEqual([
      { role: "user", text: "不是访谈，是活动邀请" },
      { role: "user", text: "那个呢" },
    ]);
    p.recordUserTurn("打开邮箱", "req-3");
    p.request("打开邮箱"); // 语音 start 落地时不再重复记
    const texts = p.snapshot().conversationContext!.recentTurns.map(t => t.text);
    expect(texts.filter(t => t === "打开邮箱")).toHaveLength(1);
  });

  it("feeds processed voice chat/steer originals to the next classification, replay excluded", async () => {
    const runtimes = new Map<string, any>();
    const manager = new ConversationManager(async (id, emit) => {
      let running = false;
      const publish = (message: ServerMessage) => {
        if (message.type === "agent_event" && message.event.kind === "agent_start") running = true;
        if (message.type === "agent_event" && message.event.kind === "agent_end") running = false;
        emit(message);
      };
      const runtime: any = {
        session: {
          modelName: () => "test", availableModels: async () => [], available: true,
          isStreaming: () => running, isHeld: () => false,
          classifyVoiceInput: vi.fn(async (text: string) => ({ steps: [{ action: "chat", text, target: null }] })),
          startTask: vi.fn(() => publish({ type: "agent_event", event: { kind: "agent_start" } })), abort: vi.fn(),
        },
        fleet: { teamView: () => null, isGroupHeld: () => false, abortTeam: vi.fn(), reset: vi.fn() },
        rpc: { rejectAll: vi.fn() }, dispose: () => {},
        handleMessage: (message: any) => { if (message.type === "user_message") publish({ type: "agent_event", event: { kind: "agent_start" } }); },
      };
      runtimes.set(id, { runtime, publish });
      return runtime;
    }, () => {});
    await manager.ensureDefault();
    await manager.handleMessage({ type: "user_message", text: "看最近邮件" });
    runtimes.get("default")!.publish({ type: "agent_event", event: { kind: "turn_start" } });
    runtimes.get("default")!.publish({ type: "agent_event", event: { kind: "text_delta", delta: "青鹭工作坊发来活动邀请。" } });
    runtimes.get("default")!.publish({ type: "agent_event", event: { kind: "agent_end" } });
    const runId=manager.getTaskProgress("default")!.runId!;
    runtimes.get("default")!.publish({type:"agent_event",event:{kind:"user_delivery",delivery:{conversationId:"default",id:"history-finding",runId,kind:"finding",text:"青鹭工作坊发来活动邀请。",composedAt:100,status:"composed"}}});
    const session = runtimes.get("default")!.runtime.session;
    const route = { requestId: "voice-req-1", voiceId: "v", turn: 1, runId: manager.getTaskProgress("default")!.runId??null };
    await manager.routeVoiceInput("default", "不是访谈，是活动邀请", null, () => true, route);
    // resumeReadOnly 重放不重复记
    await manager.routeVoiceInput("default", "不是访谈，是活动邀请", null, () => true, { ...route, resumeReadOnly: "chat" });
    await manager.routeVoiceInput("default", "那个呢", null, () => true, { ...route, requestId: "voice-req-2", turn: 2, runId:manager.getTaskProgress("default")!.runId??null });
    const lastCall = session.classifyVoiceInput.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("那个呢");
    expect(JSON.stringify(lastCall)).toContain("不是访谈，是活动邀请");
    expect(JSON.stringify(lastCall)).toContain("青鹭工作坊");
    const turns = manager.getTaskProgress("default")!.conversationContext!.recentTurns;
    expect(turns.filter(t => t.text === "不是访谈，是活动邀请")).toHaveLength(1);
    manager.dispose();
  });

  it("never writes explicitly old-run output into the replacement run result", async () => {
    const p = new TaskProgress("c");
    runWithResult(p, "读邮箱", "旧结果");
    const oldRun = p.snapshot().runId!;
    p.request("新任务看地图");
    p.observe(ev({ kind: "agent_start" }));
    p.observe({ type: "agent_event", conversationId: "c", runId: oldRun, event: { kind: "text_delta", delta: "STALE_OLD_RESULT" } } as unknown as ServerMessage);
    p.observe({ type: "agent_event", conversationId: "c", runId: oldRun, event: { kind: "agent_end" } } as unknown as ServerMessage);
    expect(p.snapshot().conversationContext?.latestResult ?? null).toBeNull();
  });
});

describe("isVoiceConversationContext", () => {  const good = { recentTurns: [{ role: "user", text: "看邮件" }], latestResult: { runId: "run-A", text: "结果", observedAt: 2, source: "assistant_output" } };
  it("accepts a valid context and rejects malformed ones", () => {
    expect(isVoiceConversationContext(good)).toBe(true);
    expect(isVoiceConversationContext({ recentTurns: [], latestResult: null })).toBe(true);
    expect(isVoiceConversationContext({ ...good, latestResult: { ...good.latestResult, source: "verified_success" } })).toBe(false);
    expect(isVoiceConversationContext({ recentTurns: [{ role: "system", text: "x" }], latestResult: null })).toBe(false);
    expect(isVoiceConversationContext({ recentTurns: Array.from({ length: 13 }, () => ({ role: "user", text: "x" })), latestResult: null })).toBe(false);
    expect(isVoiceConversationContext({ recentTurns: [{ role: "user", text: "x".repeat(2001) }], latestResult: null })).toBe(false);
    expect(isVoiceConversationContext({ recentTurns: [], latestResult: { ...good.latestResult, text: "x".repeat(6001) } })).toBe(false);
  });
});
