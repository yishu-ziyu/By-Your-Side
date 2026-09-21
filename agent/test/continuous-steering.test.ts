/**
 * 连续插话：三条补充必须完整到达同一次后续模型输入，未读到的补充要有真实结局。
 *
 * 这里分两层证据：
 * - 真实 Pi AgentSession（脚本化本地模型，不读用户凭据）：验证队列语义——同一轮 drain 交付几条插话。
 *   基线 out/acceptance/continuous-steering-2026-09-15T15-32-14-585Z/result.json 已实测
 *   "all queued edits consumed before next model response" 为 false。
 * - 合成会话：验证页面预观察 await 期间的控制闸门、停止竞态与未消费指令的收尾。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BrowserAgentSession, STEER_CONTRACT_NOTE } from "../src/session.js";
import { TaskActionRejected } from "../src/task-dispatcher.js";
import type { AgentUiEvent, PageContext } from "../../shared/protocol.js";

// 合成/脚本会话不进用户保留的 trace。
vi.mock("../src/run-trace.js", () => ({ RunTrace: class {
  begin() {}
  correlate() {}
  record() {}
  event() {}
  stage() { return { end() {} }; }
} }));

async function until<T>(probe: () => T | undefined | false, timeoutMs = 5000, what = "condition"): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function pageContext(): PageContext {
  return { tabId: 1, title: "本地表单", url: "http://127.0.0.1/form" };
}

type StreamEvent = Record<string, unknown>;

/** 手动流：模型第一轮挂起，测试释放后才结束该轮。 */
class ManualStream implements AsyncIterable<StreamEvent> {
  private readonly queue: StreamEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  private ended = false;
  private finalValue: unknown;
  private readonly finalPromise: Promise<unknown>;
  private resolveFinal!: (value: unknown) => void;
  constructor() { this.finalPromise = new Promise(resolve => { this.resolveFinal = resolve; }); }
  push(event: StreamEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.queue.push(event);
  }
  end(value?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.finalValue = value;
    this.resolveFinal(value);
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  result(): Promise<unknown> { return this.finalPromise; }
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: () => { this.end(this.finalValue); return Promise.resolve({ done: true, value: undefined }); },
    };
  }
}

const PROBE_MODEL = "steering-probe/probe";
const model = {
  id: "probe", name: "Steering probe", api: "steering-probe", provider: "steering-probe",
  baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024,
};

type ProbePart = { type: string; text?: string };

function assistant(content: ProbePart[], stopReason: string) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function textOf(message: { content?: unknown }): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { text?: string }) => part?.text ?? "").join("\n");
}

/**
 * 真实 Pi 会话：第一轮挂在模型流上，释放后交回控制权。
 * 记录每次模型调用的消息快照，用来判断"下一轮模型输入"里到底带了哪几条插话。
 */
async function realSteeringSession() {
  const dir = mkdtempSync(join(tmpdir(), "sideagent-steering-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const calls: Array<{ messages: Array<{ role: string; text: string }> }> = [];
  const held: ManualStream[] = [];
  const stream = (_model: unknown, context: { messages?: Array<{ role: string }> }) => {
    calls.push({ messages: (context.messages ?? []).map(message => ({ role: message.role, text: textOf(message as { content?: unknown }) })) });
    const pipe = new ManualStream();
    if (calls.length === 1) {
      const partial = assistant([{ type: "text", text: "" }], "pending");
      pipe.push({ type: "start", partial });
      pipe.push({ type: "text_start", contentIndex: 0, partial });
      partial.content[0]!.text = "等待资料";
      pipe.push({ type: "text_delta", contentIndex: 0, delta: "等待资料", partial });
      pipe.push({ type: "text_end", contentIndex: 0, content: "等待资料", partial });
      held.push(pipe);
    } else {
      const done = assistant([{ type: "text", text: "已按最新要求处理" }], "stop");
      pipe.push({ type: "start", partial: done });
      pipe.push({ type: "done", reason: "stop", message: done });
      pipe.end(done);
    }
    return pipe;
  };
  runtime.registerNativeProvider({
    id: model.provider, name: "Steering probe",
    auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model], stream, streamSimple: stream,
  } as never);
  const rpc = {
    call: vi.fn(async () => ({ text: "本地表单内容" })),
    resolvePageParams: (_name: string, params: Record<string, unknown>) => params,
    getPageTarget: () => null,
    setPageTarget: vi.fn(),
  };
  const emitted: AgentUiEvent[] = [];
  const session = await BrowserAgentSession.create(rpc as never, {
    emit: event => emitted.push(event),
    setStatus: vi.fn(),
  }, { modelRuntime: runtime, modelPattern: PROBE_MODEL } as never);
  return {
    session, calls, emitted, held,
    releaseHeldTurn: () => {
      const pipe = held[0];
      if (!pipe) throw new Error("第一轮模型调用没有挂起");
      const done = assistant([{ type: "text", text: "资料到了" }], "stop");
      pipe.push({ type: "done", reason: "stop", message: done });
      pipe.end(done);
    },
    cleanup: () => { session.abort(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("连续插话进入同一轮模型输入（真实 Pi 队列语义）", () => {
  it("模型处理期间连续三条补充，都在下一次模型输入之前到达", async () => {
    const harness = await realSteeringSession();
    try {
      expect(harness.session.available).toBe(true);
      harness.session.startTask("先等待资料，之后填写本地表单。", pageContext());
      await until(() => harness.calls.length === 1, 10_000, "第一次模型调用");
      const edits = ["姓名改成李四。保留邮箱。", "城市改成上海。", "备注填写地铁附近。不要提交。"];
      for (const text of edits) await harness.session.steerCurrentTask(text, pageContext());
      harness.releaseHeldTurn();
      await until(() => harness.calls.length >= 2, 10_000, "下一次模型调用");

      const messages = harness.calls[1]!.messages;
      const firstAssistant = messages.findIndex(message => message.role === "assistant");
      const inputs = messages.slice(firstAssistant + 1).filter(message => message.role === "user").map(message => message.text);
      for (const text of edits) expect(inputs.some(input => input.includes(text))).toBe(true);
      expect(inputs.findIndex(input => input.includes(edits[0]!)))
        .toBeLessThan(inputs.findIndex(input => input.includes(edits[1]!)));
      // 三条补充必须在同一次模型输入里，而不是等到各自下一轮。
      expect(inputs.filter(input => edits.some(text => input.includes(text)))).toHaveLength(3);
      // 回退路径的每条插话载荷都要携带「补充而非替换」契约：实测反例是模型把最新输入当成全部目标，
      // 只交付修改报告，原任务的答案再也不会被交付（docs/evals/20260918-prompt-budget-and-steer-contract.md）。
      for (const input of inputs.filter(input => edits.some(text => input.includes(text)))) {
        expect(input).toContain(STEER_CONTRACT_NOTE);
      }
    } finally {
      harness.cleanup();
    }
  }, 30_000);
});

type SyntheticRpc = { call: (name: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown> };

/** 生产事件的合成会话：预观察由测试控制释放时机。 */
function syntheticSession(options?: { observation?: Promise<unknown>; rpc?: SyntheticRpc }) {
  let streaming = true;
  let subscriber: ((event: unknown) => void) | null = null;
  let settlePrompt!: () => void;
  const promptPending = new Promise<void>(resolve => { settlePrompt = resolve; });
  const raw = {
    get isStreaming() { return streaming; },
    model: { id: "test" },
    agent: { state: { messages: [] as unknown[] } },
    abort: vi.fn(async () => { streaming = false; }),
    prompt: vi.fn(async (_text?: string) => { await promptPending; }),
    steer: vi.fn(async (_text: string) => {}),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    subscribe: vi.fn((fn: (event: unknown) => void) => { subscriber = fn; return () => {}; }),
  };
  const emitted: AgentUiEvent[] = [];
  const callbacks = { emit: (event: AgentUiEvent) => emitted.push(event), setStatus: vi.fn() };
  const rpc: SyntheticRpc = options?.rpc ?? {
    call: vi.fn(async () => (options?.observation ? await options.observation : { text: "本地表单内容" })),
  };
  const Session = BrowserAgentSession as unknown as new (...args: unknown[]) => BrowserAgentSession;
  const wrapped = new Session(raw, null, callbacks, null, null, undefined, null, rpc);
  (wrapped as unknown as { subscribeEvents: () => void }).subscribeEvents();
  return {
    wrapped, raw, emitted, callbacks, rpc,
    setStreaming: (value: boolean) => { streaming = value; },
    settlePrompt: () => settlePrompt(),
    agentEnd: (extra?: Record<string, unknown>) => subscriber?.({ type: "agent_end", messages: [], ...extra }),
    agentStart: () => subscriber?.({ type: "agent_start" }),
    messageStart: (text: string) => subscriber?.({ type: "message_start", message: { role: "user", content: text } }),
  };
}

describe("页面预观察与停止竞态", () => {
  it("预观察还没回来时，插话已经挡住在途写入并推进控制轮次", async () => {
    let release!: (value: unknown) => void;
    const observation = new Promise(resolve => { release = resolve; });
    const harness = syntheticSession({ observation });
    const epochBefore = harness.wrapped.executionEpoch();

    const steering = harness.wrapped.steerCurrentTask("改成看这个页面上的邮箱字段。", pageContext());
    await Promise.resolve();
    expect(harness.wrapped.canWriteCurrentInput()).toBe(false);
    expect(harness.wrapped.executionEpoch()).toBe(epochBefore + 1);

    release({ text: "本地表单内容" });
    await steering;
    expect(harness.wrapped.executionEpoch()).toBe(epochBefore + 1);
  });

  it("预观察期间被接管：旧插话不再落进 Pi 队列", async () => {
    let release!: (value: unknown) => void;
    const observation = new Promise(resolve => { release = resolve; });
    const harness = syntheticSession({ observation });

    const steering = harness.wrapped.steerCurrentTask("改成看这个页面上的邮箱字段。", pageContext());
    await Promise.resolve();
    harness.wrapped.holdForUser();
    release({ text: "本地表单内容" });
    await steering.catch(() => {});

    expect(harness.raw.steer).not.toHaveBeenCalled();
    expect(harness.wrapped.isHeld()).toBe(true);
  });

  it("预观察期间中止后即使流又变成 running，也只按原记录放行", async () => {
    let release!: (value: unknown) => void;
    const observation = new Promise(resolve => { release = resolve; });
    const harness = syntheticSession({ observation });

    const steering = harness.wrapped.steerCurrentTask("改成看这个页面上的邮箱字段。", pageContext());
    await Promise.resolve();
    harness.wrapped.abort();
    // 用户随后开了新任务：会话又在跑，但这不等于原来那条补充还算数。
    harness.setStreaming(true);
    release({ text: "本地表单内容" });
    await expect(steering).rejects.toThrow(/原任务已停止或发生变化/);
    // 明确没送进 Pi 的纠正要能被回执写成 rejected，不能退化成"结果不明"。
    await expect(steering).rejects.toBeInstanceOf(TaskActionRejected);
    expect(harness.raw.steer).not.toHaveBeenCalled();
  });

  it("暂停时预观察还没回来的补充不算已接受，交还 prompt 也不带它", async () => {
    let release!: (value: unknown) => void;
    const observation = new Promise(resolve => { release = resolve; });
    const harness = syntheticSession({ observation });

    const preparing = harness.wrapped.steerCurrentTask("改成看这个页面上的邮箱字段。", pageContext());
    await Promise.resolve();
    harness.wrapped.holdForUser({ abortStream: false });
    harness.agentEnd();
    // 暂停后马上交还：迟到的观察回来时不能把这条补充重新塞进队列。
    const started = harness.wrapped.continueAfterHandback(pageContext(), "交还后的页面");
    await vi.waitFor(() => expect(harness.raw.prompt).toHaveBeenCalledTimes(1));
    const handback = harness.raw.prompt.mock.calls[0]![0] as string;
    expect(handback).not.toContain("邮箱字段");

    release({ text: "本地表单内容" });
    await expect(preparing).rejects.toBeInstanceOf(TaskActionRejected);
    expect(harness.raw.steer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(harness.wrapped.isHeld()).toBe(false));
    harness.messageStart(handback);
    harness.agentStart();
    harness.settlePrompt();
    await started;
  });

  it("暂停后交还：已排队未消费补充的图片随文字一起带回", async () => {
    const image = { id: "img1", type: "image" as const, name: "a.png", dataBase64: "AAAA", mimeType: "image/png" as const };
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask("邮箱改成 new@example.com。", pageContext(), [image]);
    expect(harness.raw.steer).toHaveBeenCalledTimes(1);
    harness.wrapped.holdForUser({ abortStream: false });
    harness.agentEnd();

    const started = harness.wrapped.continueAfterHandback(pageContext(), "交还后的页面");
    await vi.waitFor(() => expect(harness.raw.prompt).toHaveBeenCalledTimes(1));
    const [handback, options] = harness.raw.prompt.mock.calls[0] as unknown as [string, { images?: unknown[] }];
    expect(handback).toContain("new@example.com");
    expect(options?.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    await vi.waitFor(() => expect(harness.wrapped.isHeld()).toBe(false));
    harness.messageStart(handback);
    harness.agentStart();
    harness.settlePrompt();
    await started;
  });

  it("暂停期间未读补充在 agent_end 后仍保留给交还续跑", async () => {
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask("邮箱改成 new@example.com。", pageContext());
    harness.wrapped.holdForUser({ abortStream: false });
    harness.agentEnd();

    expect(harness.emitted.find(event => event.kind === "notice" && event.message.includes("没有执行"))).toBeUndefined();
    const started = harness.wrapped.continueAfterHandback(pageContext(), "交还后的页面");
    await vi.waitFor(() => expect(harness.raw.prompt).toHaveBeenCalledTimes(1));
    const handback = harness.raw.prompt.mock.calls[0]![0] as string;
    expect(handback).toContain("new@example.com");
    expect(harness.wrapped.canWriteCurrentInput()).toBe(false);
    // 交还 prompt 真的作为 user 消息回到模型后才放行写入。
    await vi.waitFor(() => expect(harness.wrapped.isHeld()).toBe(false));
    harness.messageStart(handback);
    harness.agentStart();
    expect(harness.wrapped.canWriteCurrentInput()).toBe(true);
    harness.settlePrompt();
    await started;
  });
});

describe("已接受但这一轮没读到的补充", () => {
  it("队列清理失败仍会停止，并阻止带着旧队列启动新任务", async () => {
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask('旧要求');
    harness.raw.clearQueue.mockImplementation(() => { throw new Error('queue unavailable'); });
    harness.wrapped.abort();
    await vi.waitFor(() => expect(harness.raw.abort).toHaveBeenCalled());
    expect(harness.wrapped.canWriteCurrentInput()).toBe(false);
    expect(() => harness.wrapped.startTask('新任务')).toThrow('未读补充');
    expect(harness.raw.prompt).not.toHaveBeenCalled();
    harness.raw.clearQueue.mockReturnValue({ steering: [], followUp: [] });
    harness.wrapped.abort();
  });

  it("队列清理失败时交还保持暂停，不重复送入未读要求", async () => {
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask('旧要求');
    harness.raw.clearQueue.mockImplementation(() => { throw new Error('queue unavailable'); });
    harness.wrapped.holdForUser({ abortStream: false });
    const resumed = harness.wrapped.continueAfterHandback(pageContext(), '页面');
    expect(harness.raw.prompt).not.toHaveBeenCalled();
    // The production guard must reject without starting a pending handback prompt.
    const immediate = await Promise.race([resumed, new Promise(resolve => setTimeout(() => resolve('pending'), 30))]);
    expect(immediate).toBe(false);
    expect(harness.wrapped.isHeld()).toBe(true);
    harness.raw.clearQueue.mockReturnValue({ steering: [], followUp: [] });
    harness.wrapped.abort();
  });

  it("运行结束前未消费的补充给出明确回执，且不会永久挡住后续写入", async () => {
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask("邮箱改成 new@example.com。", pageContext());
    expect(harness.raw.steer).toHaveBeenCalledTimes(1);
    expect(harness.wrapped.canWriteCurrentInput()).toBe(false);

    // 这一轮结束，模型从未读到这条插话（没有对应 message_start）。
    harness.agentEnd();
    const notice = harness.emitted.find(event => event.kind === "notice" && event.message.includes("邮箱改成 new@example.com"));
    expect(notice, "未消费的补充需要真实回执").toBeDefined();
    expect(harness.raw.clearQueue).toHaveBeenCalled();
    expect(harness.wrapped.canWriteCurrentInput()).toBe(true);
  });

  it("重复文字的补充各自记账，一条被读到不会替另一条销账", async () => {
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask("备注改成终稿。", pageContext());
    await harness.wrapped.steerCurrentTask("备注改成终稿。", pageContext());
    expect(harness.raw.steer).toHaveBeenCalledTimes(2);

    harness.messageStart(harness.raw.steer.mock.calls[0]![0]);
    expect(harness.wrapped.canWriteCurrentInput()).toBe(false);
    harness.messageStart(harness.raw.steer.mock.calls[1]![0]);
    expect(harness.wrapped.canWriteCurrentInput()).toBe(true);
  });

  it("另一条消息只是包含某条补充的文字时，不替那条销账", async () => {
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask("备注改成终稿。", pageContext());
    // 模型收到的是另一段恰好包含同样字样的输入（例如别处引用了它）。
    harness.messageStart(`引用：备注改成终稿。但这条不是原样输入`);
    expect(harness.wrapped.canWriteCurrentInput()).toBe(false);
  });
});

describe("运行中插话的原任务契约（回退路径）", () => {
  it("插话载荷带契约与页面上下文；Pi 原样回显后按整条载荷销账，契约不进用户面事件", async () => {
    const harness = syntheticSession();
    await harness.wrapped.steerCurrentTask("把已有译文改成宋体。", pageContext());
    expect(harness.raw.steer).toHaveBeenCalledTimes(1);
    const payload = harness.raw.steer.mock.calls[0]![0] as string;
    expect(payload).toContain("把已有译文改成宋体。");
    expect(payload).toContain("本地表单");
    expect(payload).toContain(STEER_CONTRACT_NOTE);
    // 契约只进模型载荷，不进任何用户面事件。
    expect(harness.emitted.filter(event => JSON.stringify(event).includes(STEER_CONTRACT_NOTE))).toEqual([]);
    // Pi 把整条载荷原样回显为 user 消息后，销账仍精确匹配，写入放行。
    harness.messageStart(payload);
    expect(harness.wrapped.canWriteCurrentInput()).toBe(true);
  });
});
