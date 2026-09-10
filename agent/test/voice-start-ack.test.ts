import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepVoiceSession, STEP_VOICE } from "../src/voice-session.js";
import { contextualStartAck, receiptSpeech } from "../src/voice-receipt.js";
import type { TaskProgressSnapshot, VoiceEvent, VoicePlanSummary, VoiceRouteResult } from "../../shared/voice.js";
import type { TaskReceipt } from "../../shared/task-actions.js";

const receipt = (over: Partial<TaskReceipt> = {}): TaskReceipt => ({
  requestId: "req-1", conversationId: "A", source: "voice", action: "start", runId: "run-1",
  text: "帮我比较两款耳机", targetTitle: "新会话", status: "accepted", message: "已接收新任务：帮我比较两款耳机", updatedAt: 1, ...over,
});
const action = (receipts: TaskReceipt[], over: { plan?: VoicePlanSummary } = {}): VoiceRouteResult =>
  ({ kind: "action", ok: true, status: receipts.at(-1)?.status, message: receipts.map(r => r.message).join("；"), receipts, ...over });

describe("contextualStartAck", () => {
  it("returns the delegation only for a strict single accepted start", () => {
    expect(contextualStartAck(action([receipt({})]))).toBe("帮我比较两款耳机");
    expect(contextualStartAck(action([receipt({})], { plan: { id: "p", conversationId: "A", updatedAt: 1, steps: [{ action: "start", text: "帮我比较两款耳机", targetId: "A", status: "complete" }] } }))).toBe("帮我比较两款耳机");
    expect(contextualStartAck(action([receipt({ status: "rejected" })]))).toBeNull();
    expect(contextualStartAck(action([receipt({ status: "failed" })]))).toBeNull();
    expect(contextualStartAck(action([receipt({ status: "unknown" })]))).toBeNull();
    expect(contextualStartAck(action([receipt({ action: "steer" })]))).toBeNull();
    expect(contextualStartAck(action([receipt({}), receipt({ requestId: "req-2" })]))).toBeNull();
    const compound = { id: "p", conversationId: "A", updatedAt: 1, steps: [
      { action: "start" as const, text: "帮我比较两款耳机", targetId: "A", status: "complete" as const },
      { action: "start" as const, text: "再查天气", targetId: "A", status: "complete" as const },
    ] };
    expect(contextualStartAck(action([receipt({}), receipt({ requestId: "req-2", text: "再查天气" })], { plan: compound }))).toBeNull();
    expect(contextualStartAck({ kind: "action", ok: true, message: "已接收新任务" })).toBeNull(); // 无 receipts 证据
    expect(contextualStartAck({ kind: "none" })).toBeNull();
    expect(contextualStartAck(null)).toBeNull();
    expect(contextualStartAck(action([receipt({ text: "  " })]))).toBeNull();
    const longText = "帮我整理这个页面，" + "要求逐条核对。".repeat(200); // 超2000字的有界截断，200字处不断尾
    expect(contextualStartAck(action([receipt({ text: longText })]))).toBe(longText.slice(0, 2000));
    expect(contextualStartAck(action([receipt({ text: "帮我比较两款耳机，预算不超过500，只看有现货的" })]))).toBe("帮我比较两款耳机，预算不超过500，只看有现货的");
  });
  it("keeps fixed speech for every non-contextual branch", () => {
    expect(receiptSpeech(action([receipt({})]))).toBeNull();
    expect(receiptSpeech(action([receipt({ status: "rejected", message: "当前任务还在执行。要另开会话处理这个新任务吗？" })]))).toContain("另开会话");
    expect(receiptSpeech(action([receipt({ action: "pause", status: "applied", message: "任务已暂停，页面现在归你。" })]))).toBe("任务已暂停，页面现在归你。");
    expect(receiptSpeech(action([receipt({}), receipt({ requestId: "req-2" })]))).toBe("任务已收到。任务已收到。");
    expect(receiptSpeech({ kind: "clarify", message: "请说出目标会话的名称。" })).toBe("请说出目标会话的名称。");
    expect(receiptSpeech({ kind: "silent" })).toBeNull();
  });
});

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: any[] = [];
  send = (data: string) => { this.sent.push(JSON.parse(data)); };
  close = vi.fn();
  server(event: object) { this.emit("message", Buffer.from(JSON.stringify(event))); }
}
const sessions: StepVoiceSession[] = [];
afterEach(() => { sessions.splice(0).forEach(s => s.close()); });

describe("single accepted start acknowledgement", () => {
  it("generates a contextual ack from the receipt instead of a verbatim fixed line", async () => {
    const socket = new Socket();
    const events: VoiceEvent[] = [];
    const route = vi.fn(async (): Promise<VoiceRouteResult> => action([receipt({})]));
    const session = new StepVoiceSession({
      route,
      getSnapshot: (): TaskProgressSnapshot => ({ conversationId: "A", observedAt: Date.now(), state: "running", goal: null, startedAt: 1, active: [], lastAction: null, successVerified: false }),
      emit: e => events.push(e), connect: () => socket as unknown as WebSocket,
    });
    sessions.push(session);
    session.start("synthetic");
    socket.server({ type: "session.created", session: { model: "stepaudio-2.5-realtime" } });
    socket.server({ type: "session.updated", session: { voice: STEP_VOICE, input_audio_format: "pcm16", turn_detection: { type: "" } } });
    session.command({ kind: "interrupt", turn: 1 });
    session.command({ kind: "audio", turn: 1, data: "AQABAA==" });
    session.command({ kind: "commit", turn: 1 });
    socket.server({ type: "input_audio_buffer.committed", item_id: "u1" });
    socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "帮我比较两款耳机" });
    await Promise.resolve(); await Promise.resolve();
    const prompt = socket.sent.filter(e => e.type === "conversation.item.create").at(-1);
    expect(JSON.stringify(prompt)).toContain("帮我比较两款耳机");
    expect(JSON.stringify(prompt)).toContain("即将开始处理");
    expect(JSON.stringify(prompt)).not.toContain("请原样无修改地输出");
    expect(JSON.stringify(prompt)).not.toContain("本轮只朗读以下原文");
    // 不加固定文案护栏：生成的回应按普通音频直接播出，不做逐字校验重试
    socket.server({ type: "response.created", response: { id: "r1" } });
    socket.server({ type: "response.audio.delta", response_id: "r1", item_id: "a1", delta: "AQABAA==" });
    socket.server({ type: "response.audio_transcript.done", response_id: "r1", transcript: "收到，这就去帮你比较这两款耳机。" });
    expect(events.some(e => e.kind === "audio")).toBe(true);
    socket.server({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect(events.find(e => e.kind === "text" && e.role === "assistant")).toMatchObject({ text: "收到，这就去帮你比较这两款耳机。" });
    expect(socket.sent.filter(e => e.type === "response.create")).toHaveLength(1);
  });
});
