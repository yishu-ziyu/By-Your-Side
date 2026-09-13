import { describe, expect, it, vi } from "vitest";
import { ConversationManager } from "../src/conversation-manager.js";
import { BrowserAgentSession } from "../src/session.js";
import type { ServerMessage } from "../../shared/protocol.js";
import type { VoiceRouteContext } from "../../shared/voice.js";

// Independent acceptance of the manager -> actual session handoff. The SDK and
// browser transport are substitutes; no personal trace or model request is made.
vi.mock("../src/run-trace.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/run-trace.js")>(),
  RunTrace: class {
  begin() {}
  record() {}
  event() {}
} }));

async function setup(readFails = false) {
  let running = false;
  const raw = {
    model: { id: "fixture", provider: "fixture" },
    get isStreaming() { return running; },
    steer: vi.fn(async (_text: string, _images?: unknown[]) => {}),
  };
  const rpc = { call: vi.fn(async (_name: string, _params: unknown) => {
    if (readFails) throw new Error("original tab closed");
    return { text: "ORIGINAL_PAGE_A_FRESH_CONTENT", tabId: 101 };
  }) };
  let wrapped!: BrowserAgentSession;
  const manager = new ConversationManager(async (_id, emit) => {
    const Session = BrowserAgentSession as unknown as new (...args: any[]) => BrowserAgentSession;
    wrapped = new Session(raw, null, {
      emit: (event: Extract<ServerMessage, {type: "agent_event"}>["event"]) => emit({type: "agent_event", event}),
      setStatus: (state: "idle" | "running" | "user") => emit({type: "status", state}),
    }, null, null, undefined, null, rpc);
    wrapped.startTask = () => {
      running = true;
      emit({type: "agent_event", event: {kind: "agent_start"}});
    };
    wrapped.classifyVoiceInput = async text => ({steps: [{action: "steer", text, target: null}]});
    return {
      session: wrapped,
      fleet: {reset() {}, isGroupHeld: () => false},
      rpc: {rejectAll() {}},
      dispose() {},
    } as any;
  }, () => {});
  await manager.ensureDefault();
  const started = await manager.dispatchTaskAction({requestId: "start", conversationId: "default", source: "text", action: "start", expectedRunId: null, text: "查看页面"});
  expect(started).toMatchObject({status: "accepted"});
  expect(manager.getTaskProgress("default")?.state).toBe("running");
  const route: VoiceRouteContext = {
    requestId: "voice-1", voiceId: "voice", turn: 1,
    runId: manager.getTaskProgress("default")!.runId ?? null,
    controlVersion: 0,
    input: {
      context: {tabId: 101, title: "原页面A", url: "https://example.invalid/a", selection: {text: "原选区"}},
      attachments: [{id: "a", type: "image", name: "a.png", mimeType: "image/png", dataBase64: "QUFB"}],
    },
  };
  async function confirm() {
    const asked = await manager.routeVoiceInput("default", "不是刚才那个，改看当前页面", null, () => true, route);
    expect(asked.kind).toBe("clarify");
    expect(raw.steer).not.toHaveBeenCalled();
    return manager.routeVoiceInput("default", "对", null, () => true, {
      ...route, requestId: "voice-2", turn: 2,
      input: {
        context: {tabId: 202, title: "确认时页面B", url: "https://example.invalid/b"},
        attachments: [{id: "b", type: "image", name: "b.png", mimeType: "image/png", dataBase64: "QkJC"}],
      },
    });
  }
  return { manager, raw, rpc, wrapped, confirm };
}

describe("纠正确认的跨模块验收", () => {
  it("确认后真实 session 观察原页，向 SDK 交付原页事实和原图，并使旧写入代次失效", async () => {
    const h = await setup();
    try {
      const previousEpoch = h.wrapped.executionEpoch();
      expect(await h.confirm()).toMatchObject({kind: "steer", ok: true});
      expect(h.rpc.call).toHaveBeenCalledExactlyOnceWith("snapshot", {tabId: 101}, 4000);
      expect(h.raw.steer).toHaveBeenCalledTimes(1);
      const [input, images] = h.raw.steer.mock.calls[0]!;
      expect(input).toContain("ORIGINAL_PAGE_A_FRESH_CONTENT");
      expect(input).toContain("原选区");
      expect(input).not.toContain("确认时页面B");
      expect(images).toEqual([{type: "image", data: "QUFB", mimeType: "image/png"}]);
      expect(h.wrapped.executionEpoch()).toBeGreaterThan(previousEpoch);
      expect(h.wrapped.canWriteCurrentInput()).toBe(false);
    } finally { h.manager.dispose(); }
  });

  it("原页读不到时仍保留原页锚点，不读取或注入确认时活动页", async () => {
    const h = await setup(true);
    try {
      expect(await h.confirm()).toMatchObject({kind: "steer", ok: true});
      expect(h.rpc.call).toHaveBeenCalledExactlyOnceWith("snapshot", {tabId: 101}, 4000);
      const [input] = h.raw.steer.mock.calls[0]!;
      expect(input).toContain("https://example.invalid/a");
      expect(input).not.toContain("https://example.invalid/b");
      expect(input).not.toContain("FRESH PAGE OBSERVATION");
    } finally { h.manager.dispose(); }
  });
});
