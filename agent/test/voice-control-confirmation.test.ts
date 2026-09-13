import {afterEach, describe, expect, it, vi} from "vitest";
import type {Attachment, PageContext, ServerMessage} from "../../shared/protocol.js";
import type {TaskActionRequest, TaskReceipt} from "../../shared/task-actions.js";
import type {VoiceRouteResult} from "../../shared/voice.js";
import {TaskDispatcher} from "../src/task-dispatcher.js";
import {ConversationManager} from "../src/conversation-manager.js";
import {CONTROL_CONFIRM_TTL_MS, isControlConfirm, isControlReject} from "../src/voice-confirm.js";

/**
 * 真行为用例：走真实 ConversationManager + TaskDispatcher，只替身分类器和页面执行。
 * 目标：确认后执行器收到的是复述那一刻的完整原要求（原文/原页/原附件/原 runId/原控制版本），
 * 确认轮看着的另一页或另一份附件不替换原要求，快照也不受外部对象后续修改影响。
 */

type SteerRecord = {text: string; context?: PageContext; attachments?: Attachment[]};
type Plan = {steps: Array<{action: string; text: string; target: null}>};
/** 已落动作的那一支：steer/action 才有 ok/status。 */
const done = (result: VoiceRouteResult) => result as Extract<VoiceRouteResult, {kind: "steer" | "action"}>;

class RecordingDispatcher extends TaskDispatcher {
  readonly requests: TaskActionRequest[] = [];
  override dispatch(request: TaskActionRequest, title: string, execute: () => Promise<Pick<TaskReceipt, "status" | "message" | "runId">>): Promise<TaskReceipt> {
    this.requests.push(request);
    return super.dispatch(request, title, execute);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

function setup() {
  const received: SteerRecord[] = [];
  const emitted: ServerMessage[] = [];
  const dispatcher = new RecordingDispatcher();
  let classifier = (text: string): Plan => ({steps: [{action: "steer", text, target: null}]});
  let running = false;
  let conversationEmit: (message: ServerMessage) => void = () => {};
  let session: {
    available: boolean; modelName: () => string; availableModels: () => Promise<never[]>; isHeld: () => boolean;
    isStreaming: () => boolean; classifyVoiceInput: (text: string) => Promise<Plan>;
    startTask: () => void; steerCurrentTask: (text: string, context?: PageContext, attachments?: Attachment[]) => Promise<void>;
    queueSteerForResume: () => void; persistTaskResults: () => void; abort: () => void;
  };
  const manager = new ConversationManager(async (_id, emitEvent) => {
    conversationEmit = emitEvent;
    session = {
      available: true,
      modelName: () => "fixture",
      availableModels: async () => [],
      isHeld: () => false,
      isStreaming: () => running,
      classifyVoiceInput: async (text: string) => classifier(text),
      startTask: () => { running = true; emitEvent({type: "agent_event", event: {kind: "agent_start"}} as ServerMessage); },
      steerCurrentTask: async (text: string, context?: PageContext, attachments?: Attachment[]) => { received.push({text, context, attachments}); },
      queueSteerForResume: () => {},
      persistTaskResults: () => {},
      abort: () => { running = false; },
    };
    return {
      session,
      fleet: {isGroupHeld: () => false, reset: () => {}, teamView: () => null, list: () => []},
      rpc: {rejectAll: () => {}},
      handleMessage: (message: ServerMessage) => { if ((message as {type: string}).type === "abort") session.abort(); },
      dispose: () => {},
    } as never;
  }, (message) => { emitted.push(message); }, undefined, undefined, undefined, dispatcher);
  return {
    manager, dispatcher, received, emitted,
    setClassifier: (next: (text: string) => Plan) => { classifier = next; },
    endRun: () => { running = false; conversationEmit({type: "agent_event", conversationId: "default", event: {kind: "agent_end"}} as ServerMessage); },
  };
}

const context = (tabId: number, title: string, url: string): PageContext => ({tabId, title, url});
const image = (id: string, name: string, dataBase64 = "AAAA"): Attachment => ({id, type: "image", name, dataBase64, mimeType: "image/png"});

async function runningTask(manager: ConversationManager, requestId = "text-start", expectedRunId: string | null = null) {
  const started = await manager.dispatchTaskAction({requestId, conversationId: "default", source: "text", action: "start", expectedRunId, text: "在网页上查看内容"});
  expect(started.status).toBe("accepted");
  const snapshot = manager.getTaskProgress("default")!;
  return {runId: snapshot.runId!, controlVersion: snapshot.controlVersion ?? 0};
}

function routeFor(manager: ConversationManager, runId: string, controlVersion: number, over: Record<string, unknown> = {}) {
  return {
    requestId: "voice-1", voiceId: "voice-a", turn: 1, runId, controlVersion,
    targets: manager.voiceTargets(), ...over,
  } as never;
}

afterEach(() => { vi.useRealTimers(); });

describe("语音纠正确认后送达原要求", () => {
  it("确认时在 B 页回答'对'，执行器仍收到 A 页锚点与原附件；确认轮的材料不替换原要求", async () => {
    const {manager, dispatcher, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const originalContext = context(101, "纠正时所指页面", "https://example.invalid/a");
    const originalAttachments = [image("attach-a", "a.png")];
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {
      input: {context: originalContext, attachments: originalAttachments, observation: {token: "obs-secret", tabId: 101}},
    }));
    expect(first.kind).toBe("clarify");
    expect(received).toHaveLength(0);

    const second = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {
      requestId: "voice-2", turn: 2,
      input: {context: context(202, "确认时另一页面", "https://example.invalid/b"), attachments: [image("attach-b", "b.png", "BBBB")]},
    }));
    expect(second.kind).toBe("steer");
    expect(done(second).ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("改看这个页面");
    expect(received[0]!.context).toEqual(originalContext);
    expect(received[0]!.attachments).toEqual(originalAttachments);

    // 送出的请求载荷：只带执行材料，不带只读观察令牌，也不带任何闭包。
    const steerRequest = dispatcher.requests.find((request) => request.action === "steer")!;
    expect(Object.keys(steerRequest).sort()).toEqual(["action", "attachments", "context", "conversationId", "expectedControlVersion", "expectedRunId", "requestId", "source", "text"]);
    expect(() => structuredClone(steerRequest)).not.toThrow();
  });

  it("待确认资料是独立快照：之后改原输入对象，同一次确认仍送原值", async () => {
    const {manager, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const originalContext = context(101, "纠正时所指页面", "https://example.invalid/a");
    const originalAttachments = [image("attach-a", "a.png")];
    const expectedContext = {...originalContext};
    const expectedAttachments = [{...originalAttachments[0]!}];
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {
      input: {context: originalContext, attachments: originalAttachments},
    }));
    expect(first.kind).toBe("clarify");

    originalContext.tabId = 999;
    originalContext.title = "事后被改过的页面";
    originalAttachments[0]!.name = "事后被改过.png";
    originalAttachments.push(image("attach-late", "late.png"));

    const second = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
    expect(done(second).ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.context).toEqual(expectedContext);
    expect(received[0]!.attachments).toEqual(expectedAttachments);
  });

  it("原控制版本变化后，旧纠正不再提交", async () => {
    const {manager, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    await manager.handleMessage({type: "takeover", requestId: "takeover-1", conversationId: "default"});
    const second = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion + 1, {requestId: "voice-2", turn: 2}));
    expect(done(second).ok).toBe(false);
    expect(done(second).status).toBe("rejected");
    expect(received).toHaveLength(0);
  });

  it("原任务被替换后，旧纠正不再提交", async () => {
    const {manager, received, endRun} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    endRun();
    const next = await runningTask(manager, "text-start-2", runId);
    expect(next.runId).not.toBe(runId);
    const second = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, next.runId, next.controlVersion, {requestId: "voice-2", turn: 2}));
    expect(done(second).ok).toBe(false);
    expect(done(second).status).toBe("rejected");
    expect(received).toHaveLength(0);
  });

  it("说'不'撤回：不落动作，也不产生新回执", async () => {
    const {manager, dispatcher, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    const second = await manager.routeVoiceInput("default", "不", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
    expect(second.kind).toBe("clarify");
    expect((second as {message: string}).message).toBe("好，那我不动它。");
    expect(received).toHaveLength(0);
    expect(dispatcher.requests.filter((request) => request.action === "steer")).toHaveLength(0);
  });

  it("超过90秒的确认明确告知失效，不提交旧要求或再次确认", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
    const {manager, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    vi.setSystemTime(Date.now() + CONTROL_CONFIRM_TTL_MS + 1);
    const second = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
    expect(second.kind).toBe("clarify");
    // 过期后不再回退分类器复述确认句，直接说明未执行。
    expect((second as {message: string}).message).toContain("没有执行");
    expect((second as {message: string}).message).not.toContain("你是说");
    expect(received).toHaveLength(0);
  });

  it("换一个语音连接回答'对'不算确认", async () => {
    const {manager, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    const second = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2, voiceId: "voice-b"}));
    expect(second.kind).toBe("clarify");
    expect(received).toHaveLength(0);
  });

  it.each([0, 1])("旧确认轮次 %i 不晚于原句时，不提交旧要求", async turn => {
    const {manager, received} = setup();
    try {
      await manager.ensureDefault();
      const {runId, controlVersion} = await runningTask(manager);
      const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true,
        routeFor(manager, runId, controlVersion));
      expect(first.kind).toBe("clarify");
      await manager.routeVoiceInput("default", "对", null, () => true,
        routeFor(manager, runId, controlVersion, {requestId: "non-adjacent", turn}));
      expect(received).toHaveLength(0);
    } finally { manager.dispose(); }
  });

  it("同一句重复确认只提交一次", async () => {
    const {manager, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    const confirm = () => manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
    const a = await confirm();
    const b = await confirm();
    expect(done(a).ok).toBe(true);
    expect(received).toHaveLength(1);
    // 同编号重放拿到同一份回执，而不是再执行一次。
    expect((b as {kind: string}).kind).toBe("steer");
    expect((b as {ok?: boolean}).ok).toBe(true);
    expect(received).toHaveLength(1);
    // 换个编号再说一次"对"：待确认已消费，只会重新复述，不会替旧要求落地。
    const c = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-3", turn: 3}));
    expect(c.kind).toBe("clarify");
    expect(received).toHaveLength(1);
  });

  it("确认前再次改口：第二份待确认要求取代第一份", async () => {
    const {manager, received} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "第一句改口", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    const second = await manager.routeVoiceInput("default", "第二句改口", null, () => true, routeFor(manager, runId, controlVersion, {
      requestId: "voice-2", turn: 2, input: {context: context(303, "第二句当时看的页面", "https://example.invalid/c")},
    }));
    expect(second.kind).toBe("clarify");
    expect((second as {message: string}).message).toContain("第二句改口");

    const third = await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-3", turn: 3}));
    expect(done(third).ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("第二句改口");
    expect(received[0]!.context).toEqual(context(303, "第二句当时看的页面", "https://example.invalid/c"));
  });

  it("待确认期间的普通闲聊既不确认也不中止", async () => {
    const {manager, received, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {input: {context: context(101, "A", "https://example.invalid/a")}}));
    expect(first.kind).toBe("clarify");

    setClassifier((text) => ({steps: [{action: "chat", text, target: null}]}));
    const second = await manager.routeVoiceInput("default", "这个页面讲了什么", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
    expect(second.kind).toBe("none");
    expect(received).toHaveLength(0);
    expect(manager.getTaskProgress("default")!.state).toBe("running");
  });

  it("终止句沿用原确认规则：确认后按原调度下发，且不扩大页面输入", async () => {
    const {manager, dispatcher, received, emitted, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    setClassifier((text) => ({steps: [{action: "abort", text, target: null}]}));
    const first = await manager.routeVoiceInput("default", "停下", null, () => true, routeFor(manager, runId, controlVersion, {
      input: {context: context(101, "A", "https://example.invalid/a"), attachments: [image("attach-a", "a.png")], observation: {token: "obs-secret", tabId: 101}},
    }));
    expect(first.kind).toBe("clarify");
    expect((first as {message: string}).message).toContain("停下");

    const confirming = manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {
      requestId: "voice-2", turn: 2, input: {context: context(202, "确认时另一页面", "https://example.invalid/b")},
    }));
    await waitFor(() => emitted.some((message) => (message as {type: string}).type === "task_control"));
    const control = emitted.find((message) => (message as {type: string}).type === "task_control") as unknown as {requestId: string; action: string; runId: string};
    await manager.handleMessage({type: "task_control_result", conversationId: "default", requestId: control.requestId, action: "abort", runId: control.runId, ok: true});
    const second = await confirming;
    expect(second.kind).toBe("action");
    expect(done(second).ok).toBe(true);
    expect(received).toHaveLength(0);
    const abortRequest = dispatcher.requests.find((request) => request.action === "abort")!;
    expect(abortRequest.text).toBe("停下");
    expect(abortRequest.context).toBeUndefined();
    expect(abortRequest.attachments).toBeUndefined();
    expect(abortRequest.expectedControlVersion).toBe(controlVersion);
  });

  it("真实序列'对，是苏州，但是不要点确认'是含约束的修订，'是的，确认'按原动作只送达一次", async () => {
    const {manager, dispatcher, received, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const seen: string[] = [];
    setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });

    // turn1：纠正正在跑的任务，产生待确认。
    const turn1 = await manager.routeVoiceInput("default", "不是上海，是苏州。", null, () => true, routeFor(manager, runId, controlVersion, {
      requestId: "voice-1", turn: 1, input: {context: context(101, "纠正时所指页面", "https://example.invalid/a"), attachments: [image("attach-a", "a.png")]},
    }));
    expect(turn1.kind).toBe("clarify");
    expect(received).toHaveLength(0);

    // turn2：带"不要点确认"约束的修订，不能误当纯肯定；它自己走分类器并形成新的待确认。
    const revisionContext = context(202, "修订时所指页面", "https://example.invalid/revision");
    const revisionAttachments = [image("attach-revision", "revision.png")];
    const turn2 = await manager.routeVoiceInput("default", "对，是苏州，但是不要点确认。", null, () => true, routeFor(manager, runId, controlVersion, {
      requestId: "voice-2", turn: 2, input: {context: revisionContext, attachments: revisionAttachments},
    }));
    expect(turn2.kind).toBe("clarify");
    expect(received).toHaveLength(0);
    expect(seen).toContain("对，是苏州，但是不要点确认。");

    // turn3：复合纯肯定"是的，确认"，送达 turn2 的原动作一次，保留 turn2 的 context/attachments/runId/controlVersion。
    const turn3Route = routeFor(manager, runId, controlVersion, {
      requestId: "voice-3", turn: 3, input: {context: context(303, "确认时另一页面", "https://example.invalid/confirm"), attachments: [image("attach-confirm", "confirm.png", "CCCC")]},
    });
    const turn3 = await manager.routeVoiceInput("default", "是的，确认。", null, () => true, turn3Route);
    expect(done(turn3).ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("对，是苏州，但是不要点确认。");
    expect(received[0]!.context).toEqual(revisionContext);
    expect(received[0]!.attachments).toEqual(revisionAttachments);
    const steerRequest = dispatcher.requests.find((request) => request.action === "steer")!;
    expect(steerRequest.expectedRunId).toBe(runId);
    expect(steerRequest.expectedControlVersion).toBe(controlVersion);
    // 确认本身不进分类器，也不会被再次复述。
    expect(seen).not.toContain("是的，确认。");
    expect((turn3 as {message?: string}).message ?? "").not.toContain("你是说");

    // 同编号重放（同一份载荷）不重复落动作。
    const replay = await manager.routeVoiceInput("default", "是的，确认。", null, () => true, turn3Route);
    expect(done(replay).ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(dispatcher.requests.filter((request) => request.action === "steer")).toHaveLength(1);
  });

  it("无待确认时的纯肯定不回退分类器：既不复述确认句，也不落旧动作", async () => {
    const {manager, received, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const seen: string[] = [];
    setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });

    const result = await manager.routeVoiceInput("default", "是的，确认。", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-1", turn: 1}));
    expect(received).toHaveLength(0);
    expect(seen).not.toContain("是的，确认。");
    expect(result.kind).toBe("clarify");
    const message = (result as {message?: string}).message ?? "";
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("你是说");
  });

  it("待确认过期后的纯肯定既不落旧动作，也不回退复述确认句", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
    const {manager, received, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const seen: string[] = [];
    setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-1", turn: 1}));
    expect(first.kind).toBe("clarify");

    vi.setSystemTime(Date.now() + CONTROL_CONFIRM_TTL_MS + 1);
    const second = await manager.routeVoiceInput("default", "是的，确认。", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
    expect(received).toHaveLength(0);
    expect(seen).not.toContain("是的，确认。");
    expect(second.kind).toBe("clarify");
    expect((second as {message: string}).message).not.toContain("你是说");
  });

  it("换语音连接后的纯肯定不回退复述确认句，也不落旧动作", async () => {
    const {manager, received, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const seen: string[] = [];
    setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-1", turn: 1}));
    expect(first.kind).toBe("clarify");

    const second = await manager.routeVoiceInput("default", "是的，确认。", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2, voiceId: "voice-b"}));
    expect(received).toHaveLength(0);
    expect(seen).not.toContain("是的，确认。");
    expect(second.kind).toBe("clarify");
  });

  it("'是的，确认，但是不要保存'含否定约束，不能当纯肯定", async () => {
    const {manager, received, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const seen: string[] = [];
    setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });
    const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-1", turn: 1}));
    expect(first.kind).toBe("clarify");

    const second = await manager.routeVoiceInput("default", "是的，确认，但是不要保存", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
    expect(received).toHaveLength(0);
    expect(seen).toContain("是的，确认，但是不要保存");
    expect(second.kind).toBe("clarify");
  });

  it.each(["确认吧", "好的，可以啊", "没问题，照做"])(
    "自然肯定尾词“%s”接住待确认：送达原要求、不回退分类器、不再复述",
    async reply => {
      const {manager, dispatcher, received, setClassifier} = setup();
      await manager.ensureDefault();
      const {runId, controlVersion} = await runningTask(manager);
      const seen: string[] = [];
      setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });

      const originalContext = context(101, "纠正时所指页面", "https://example.invalid/a");
      const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {
        requestId: "voice-1", turn: 1, input: {context: originalContext},
      }));
      expect(first.kind).toBe("clarify");

      const second = await manager.routeVoiceInput("default", reply, null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
      expect(done(second).ok).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("改看这个页面");
      expect(received[0]!.context).toEqual(originalContext);
      expect(dispatcher.requests.filter((request) => request.action === "steer")).toHaveLength(1);
      // 纯肯定不进分类器，也不会被再复述一遍。
      expect(seen).not.toContain(reply);
      expect((second as {message?: string}).message ?? "").not.toContain("你是说");
    },
  );

  it.each(["确认吧，但不要保存", "没问题，改成南京", "是的确认但是不要保存"])(
    "自然尾词的肯定里夹了新要求或否定“%s”仍不是纯肯定：交给分类器并重新复述",
    async revision => {
      const {manager, received, setClassifier} = setup();
      await manager.ensureDefault();
      const {runId, controlVersion} = await runningTask(manager);
      const seen: string[] = [];
      setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });

      const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-1", turn: 1}));
      expect(first.kind).toBe("clarify");

      const second = await manager.routeVoiceInput("default", revision, null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
      expect(seen).toContain(revision);
      expect(second.kind).toBe("clarify");
      expect((second as {message?: string}).message).toContain("你是说");
      expect(received).toHaveLength(0);
    },
  );

  it.each(["不，不用了", "算了，取消", "不用了，谢谢", "不对，取消"])(
    "待确认时的纯否定组合“%s”直接撤回：不进分类器、不落旧修订、不再自我确认",
    async reply => {
      const {manager, dispatcher, received, setClassifier} = setup();
      await manager.ensureDefault();
      const {runId, controlVersion} = await runningTask(manager);
      const seen: string[] = [];
      setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });

      // turn1：纠正正在跑的任务，形成待确认。
      const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {
        requestId: "voice-1", turn: 1, input: {context: context(101, "A", "https://example.invalid/a")},
      }));
      expect(first.kind).toBe("clarify");
      expect(seen).toContain("改看这个页面");

      // turn2：口语里连着说的纯否定，直接撤回，不交给分类器再问一遍。
      const second = await manager.routeVoiceInput("default", reply, null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
      expect(second.kind).toBe("clarify");
      expect((second as {message?: string}).message).toBe("好，那我不动它。");
      expect((second as {message?: string}).message ?? "").not.toContain("你是说");
      expect(received).toHaveLength(0);
      expect(dispatcher.requests.filter((request) => request.action === "steer")).toHaveLength(0);
      expect(seen).not.toContain(reply);

      // 待确认已消费：下一轮的“对”不会替旧修订落地。
      await manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-3", turn: 3}));
      expect(received).toHaveLength(0);
    },
  );

  it.each(["不要保存，改成南京", "不是上海，是苏州"])(
    "待确认时带新要求的修订“%s”不是纯否定：仍交给分类器，不吞成撤销",
    async revision => {
      const {manager, received, setClassifier} = setup();
      await manager.ensureDefault();
      const {runId, controlVersion} = await runningTask(manager);
      const seen: string[] = [];
      setClassifier((text) => { seen.push(text); return {steps: [{action: "steer", text, target: null}]}; });

      const first = await manager.routeVoiceInput("default", "改看这个页面", null, () => true, routeFor(manager, runId, controlVersion, {
        requestId: "voice-1", turn: 1, input: {context: context(101, "A", "https://example.invalid/a")},
      }));
      expect(first.kind).toBe("clarify");

      const second = await manager.routeVoiceInput("default", revision, null, () => true, routeFor(manager, runId, controlVersion, {requestId: "voice-2", turn: 2}));
      // 带新要求：照常走分类器，形成新的待确认，而不是被当成撤销。
      expect(seen).toContain(revision);
      expect(second.kind).toBe("clarify");
      expect((second as {message?: string}).message).toContain("你是说");
      expect(received).toHaveLength(0);
    },
  );
});

it("无待确认时的继续仍走正常任务路由", async () => {
  const {manager, setClassifier} = setup();
  await manager.ensureDefault();
  const {runId, controlVersion} = await runningTask(manager);
  const seen: string[] = [];
  setClassifier(text => { seen.push(text); return {steps:[{action:"chat",text,target:null}]}; });
  await manager.routeVoiceInput("default", "继续", null, () => true, routeFor(manager, runId, controlVersion));
  expect(seen).toEqual(["继续"]);
});


describe("另开会话的自然确认和拒绝", () => {
  it.each(["好的，另开会话", "算了，不用了", "不用了，谢谢"])("接住 %s，不再分类这句回应", async reply => {
    const {manager, dispatcher, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const seen: string[] = [];
    setClassifier(text => { seen.push(text); return {steps:[{action:"start",text,target:null}]}; });
    const first = await manager.routeVoiceInput("default", "查另一个问题", null, () => true, routeFor(manager, runId, controlVersion));
    expect(first).toMatchObject({kind:"clarify",message:expect.stringContaining("另开会话")});
    const second = await manager.routeVoiceInput("default", reply, null, () => true, routeFor(manager, runId, controlVersion,{requestId:"voice-2",turn:2}));
    expect(seen).toEqual(["查另一个问题"]);
    const newStarts=dispatcher.requests.filter(r=>r.action==="start"&&r.conversationId!=="default");
    if(reply.startsWith("好的")) {
      expect(newStarts).toHaveLength(1);
      expect(newStarts[0]!.text).toBe("查另一个问题");
    } else {
      expect(newStarts).toHaveLength(0);
      expect(second).toMatchObject({kind:"clarify",message:"没有另开会话，原任务保持原状。"});
    }
  });
});

it.each(["不是不行", "不是不可以", "谢谢", "好了", "不对，城市改为南京"])("不把双重否定或新要求误作撤销：%s", text => {
  expect(isControlReject(text)).toBe(false);
});

it.each(["不行", "不是不行", "对了", "没问题，改成南京", "确认吧，但不要保存"])("不把否定或带新要求的回应当纯肯定：%s", text => {
  expect(isControlConfirm(text)).toBe(false);
});


it.each(["status", "resume-status", "empty-turn"])("待确认跨越 %s 后仍送达原要求", async mode => {
  const {manager, received, setClassifier} = setup();
  await manager.ensureDefault();
  const {runId, controlVersion}=await runningTask(manager);
  const original=context(101,"原页面","https://example.invalid/a");
  await manager.routeVoiceInput("default","改成苏州，不保存",null,()=>true,routeFor(manager,runId,controlVersion,{input:{context:original}}));
  if(mode!=="empty-turn") {
    setClassifier(text=>({steps:[{action:"status",text,target:null}]}));
    await manager.routeVoiceInput("default","进度怎么样",null,()=>true,routeFor(manager,runId,controlVersion,{requestId:"voice-status",turn:2,...(mode==="resume-status"?{resumeReadOnly:"status"}:{})}));
  }
  const result=await manager.routeVoiceInput("default","是的，确认",null,()=>true,routeFor(manager,runId,controlVersion,{requestId:"voice-confirm",turn:3}));
  expect(result).toMatchObject({kind:"steer",ok:true});
  expect(received).toEqual([{text:"改成苏州，不保存",context:original,attachments:undefined}]);
});


it.each(["是的，确认", "不用了，谢谢"])("迟到的旧连接 %s 不能消费新待办", async reply=>{
  const {manager,received}=setup(); await manager.ensureDefault();
  const {runId,controlVersion}=await runningTask(manager);
  await manager.routeVoiceInput("default","改为苏州，不保存",null,()=>true,routeFor(manager,runId,controlVersion));
  await expect(manager.routeVoiceInput("default",reply,null,()=>false,routeFor(manager,runId,controlVersion,{voiceId:"old-voice",requestId:"old-response",turn:9}))).rejects.toThrow();
  await manager.routeVoiceInput("default","是的，确认",null,()=>true,routeFor(manager,runId,controlVersion,{requestId:"fresh-confirm",turn:2}));
  expect(received.map(r=>r.text)).toEqual(["改为苏州，不保存"]);
});
