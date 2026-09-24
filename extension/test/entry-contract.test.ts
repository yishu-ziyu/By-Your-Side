/**
 * 入口行为契约：同一组协议消息，分别经过本机伴随进程（ConversationManager）与扩展内 agent（extension/src/inproc/host.ts）。
 *
 * 两边都用同一个脚本化本地模型和同一个假浏览器，只比较协议上看得到的结果：
 * - 等待确认的点击，交给模型的回执不能说已经点了；
 * - 其他会话的消息不能改变正在执行任务的归属；
 * - 同一 requestId 重复投递只启动一次；
 * - 指向过期任务的修订被拒绝，也不进入模型输入。
 *
 * 扩展内入口目前是简化循环，已知不满足的契约用 it.fails 标出（修好后会变红，提醒去掉标记）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { TaskActionRequest } from "../../shared/task-actions.js";

const PROBE = "contract-probe/probe";

const model = {
  id: "probe", name: "Contract probe", api: "contract-probe", provider: "contract-probe",
  baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024,
};

interface StreamEvent { type: string; [key: string]: StreamValue }

type StreamValue = string | number | boolean | null | undefined | StreamValue[] | { [key: string]: StreamValue };

/** 与 pi-ai 的 AssistantMessageEventStream 同形：可迭代事件，result() 给出最终消息。 */
class ManualStream implements AsyncIterable<StreamEvent> {
  private readonly queue: StreamEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  private ended = false;
  private resolveFinal!: (value: StreamValue) => void;
  private readonly finalPromise = new Promise<StreamValue>(resolve => { this.resolveFinal = resolve; });

  push(event: StreamEvent): void {
    const waiter = this.waiters.shift();

    if (waiter) waiter({ done: false, value: event });
    else this.queue.push(event);
  }

  end(value: StreamValue): void {
    if (this.ended) return;
    this.ended = true;
    this.resolveFinal(value);

    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  result(): Promise<StreamValue> { return this.finalPromise; }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: () => {
        const event = this.queue.shift();

        if (event) return Promise.resolve({ done: false, value: event });

        if (this.ended) return Promise.resolve({ done: true, value: undefined });

        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

interface SeenMessage { role: string; text: string }

const isString = (value: StreamValue): value is string => typeof value === "string";

const isTextPart = (value: StreamValue): value is { text: string } => !!value && typeof value === "object" && !Array.isArray(value) && typeof value.text === "string";

function textOf(content: StreamValue): string {
  if (isString(content)) return content;

  if (!Array.isArray(content)) return "";

  return content.map(part => (isTextPart(part) ? part.text : "")).join("\n");
}

function assistant(content: StreamValue[], stopReason: string) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

/**
 * 脚本化模型：新任务的第一轮点 @3；看到工具回执后用一句话收尾。
 * holdNext 让下一次调用挂起，测试调用 release() 才继续。
 */
class ScriptedModel {
  readonly calls: SeenMessage[][] = [];
  holdNext = false;
  private held: (() => void) | null = null;

  readonly stream = (_model: typeof model, context: { messages?: Array<{ role: string; content?: StreamValue }> }) => {
    const messages = (context.messages ?? []).map(m => ({ role: m.role, text: textOf(m.content ?? null) }));
    this.calls.push(messages);
    const pipe = new ManualStream();
    const answered = messages.some(m => m.role === "toolResult");

    const finish = () => {
      const done = answered
        ? assistant([{ type: "text", text: "好了。" }], "stop")
        : assistant([{ type: "toolCall", id: `call-${this.calls.length}`, name: "click", arguments: { target: "@3" } }], "toolUse");

      pipe.push({ type: "start", partial: done });
      pipe.push({ type: "done", reason: done.stopReason, message: done });
      pipe.end(done);
    };

    if (this.holdNext) {
      this.holdNext = false;
      this.held = finish;
    } else finish();

    return pipe;
  };

  release(): void {
    const next = this.held;
    this.held = null;
    next?.();
  }

  get holding(): boolean { return this.held !== null; }
}

/** 假浏览器：click 一律被拦下等确认；其余读操作给一页最小内容。 */
interface BrowserReply { data: StreamValue; executionFact: "executed" | "not_executed" }

function browserReply(name: string): BrowserReply {
  if (name === "click") return { data: { clicked: false, held: true }, executionFact: "not_executed" };

  if (name === "snapshot") return { data: { text: '@3 button "保存"', tabId: 1, url: "http://127.0.0.1/note", title: "备注" }, executionFact: "executed" };

  if (name === "list_tabs") return { data: { tabs: [{ id: 1, title: "备注", url: "http://127.0.0.1/note", active: true }] }, executionFact: "executed" };

  return { data: { tabId: 1, id: 1, url: "http://127.0.0.1/note", title: "备注" }, executionFact: "executed" };
}

interface Entry {
  name: string;
  conversationId: string;
  frames: ServerMessage[];
  send(message: ClientMessage): void;
  cleanup(): void;
}

function answerToolCalls(frames: ServerMessage[], send: (message: ClientMessage) => void, conversationId: () => string): (frame: ServerMessage) => void {
  return frame => {
    frames.push(frame);

    if (frame.type !== "tool_call") return;
    const reply = browserReply(frame.name);
    setTimeout(() => send({ type: "tool_result", conversationId: conversationId(), id: frame.id, ok: true, data: reply.data, executionFact: reply.executionFact }), 0);
  };
}

async function nativeEntry(script: ScriptedModel): Promise<Entry> {
  const dir = mkdtempSync(join(tmpdir(), "bys-entry-contract-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  // SAFETY: 与 pi-coding-agent 的 native provider 同形；本测试只用到 stream。
  runtime.registerNativeProvider({
    id: model.provider, name: model.name,
    auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model], stream: script.stream, streamSimple: script.stream,
  } as never);
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);

  const { ConversationManager } = await import("../../agent/src/conversation-manager.js");
  const { createConversationRuntime } = await import("../../agent/src/conversation-runtime.js");
  const { TaskDispatcher } = await import("../../agent/src/task-dispatcher.js");
  const frames: ServerMessage[] = [];
  let manager: InstanceType<typeof ConversationManager> | null = null;

  const send = (message: ClientMessage) => { void manager?.handleMessage(message); };

  const emit = answerToolCalls(frames, send, () => "default");

  manager = new ConversationManager((id, sink) => createConversationRuntime(id, sink, PROBE, {}), emit, undefined, undefined, undefined, new TaskDispatcher());
  await manager.ensureDefault();
  // 与 main.ts 接入侧栏时一致：有客户端连着，任务队列才会启动任务。
  manager.reconnect();

  return { name: "本机伴随进程", conversationId: "default", frames, send, cleanup: () => { void manager?.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

async function inprocEntry(script: ScriptedModel): Promise<Entry> {
  const { startInprocHost } = await import("../src/inproc/host.js");
  const frames: ServerMessage[] = [];
  let onMessage: ((message: ClientMessage | InprocConfig) => void) | null = null;
  const send = (message: ClientMessage | InprocConfig) => onMessage?.(message);
  const emit = answerToolCalls(frames, send, () => "A");

  const port = {
    name: "inproc-host",
    // 心跳与凭据回写只给 background，不属于侧栏协议。
    postMessage: (frame: ServerMessage | HostOnlyFrame) => { if (!isHostOnly(frame)) emit(frame); },
    onMessage: { addListener: (listener: (message: ClientMessage | InprocConfig) => void) => { onMessage = listener; } },
    onDisconnect: { addListener: () => {} },
  };

  const runtime = {
    sessionId: "contract", resolveModel: () => model, headersFor: () => undefined,
    models: { streamSimple: script.stream }, credentials: { load: async () => {} },
  };

  // SAFETY: host 只用到 runtime 的这几个成员和端口的 name / postMessage / onMessage / onDisconnect。
  startInprocHost({ createRuntime: () => runtime as never, onConnect: (listener) => listener(port as never) });
  send({ type: "inproc_config", config: { provider: model.provider, modelId: model.id }, credentials: {} });

  return { name: "扩展内 agent", conversationId: "A", frames, send, cleanup: () => {} };
}

interface HostOnlyFrame { type: "inproc_keepalive" | "inproc_credential" }

const isHostOnly = (frame: ServerMessage | HostOnlyFrame): frame is HostOnlyFrame => frame.type === "inproc_keepalive" || frame.type === "inproc_credential";

interface InprocConfig { type: "inproc_config"; config: { provider: string; modelId: string }; credentials: Record<string, never> }

async function until<T>(probe: () => T | undefined | false | null, what: string, timeoutMs = 8000): Promise<T> {
  const started = Date.now();

  for (;;) {
    const value = probe();

    if (value) return value;

    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function request(entry: Entry, patch: Partial<TaskActionRequest>): TaskActionRequest {
  return { requestId: "r", conversationId: entry.conversationId, source: "text", action: "start", expectedRunId: null, text: "把保存按钮点一下", ...patch };
}

function receiptOf(entry: Entry, requestId: string) {
  for (const frame of entry.frames) {
    if (frame.type === "agent_event" && frame.event.kind === "notice" && frame.event.receipt?.requestId === requestId) return frame.event.receipt;
  }

  return undefined;
}

const idle = (entry: Entry) => entry.frames.some(f => f.type === "status" && f.state === "idle");

type Build = (script: ScriptedModel) => Promise<Entry>;

/** 扩展内入口已知不满足的契约；④ 把任务核心搬进扩展后应当全部去掉。 */
const INPROC_KNOWN_GAPS = new Set(["heldClick", "ownership", "duplicate", "staleSteer"]);

const entries: Array<[string, Build, Set<string>]> = [
  ["本机伴随进程", nativeEntry, new Set()],
  ["扩展内 agent", inprocEntry, INPROC_KNOWN_GAPS],
];

describe.each(entries)("入口契约：%s", (_name, build, gaps) => {
  let entry: Entry | null = null;
  afterEach(() => {
    entry?.cleanup();
    entry = null;
    vi.restoreAllMocks();
  });

  const contract = (key: string, title: string, body: () => Promise<void>) => (gaps.has(key) ? it.fails : it)(title, body, 20_000);

  contract("heldClick", "等待确认的点击，交给模型的回执不说已经点了", async () => {
    const script = new ScriptedModel();
    entry = await build(script);
    entry.send({ type: "task_action", conversationId: entry.conversationId, request: request(entry, { requestId: "held-1" }) });

    const seen = await until(() => script.calls.flat().find(m => m.role === "toolResult"), "模型收到点击回执");
    const reply = seen.text;
    expect(reply).not.toMatch(/^Clicked/);
    expect(reply).toMatch(/held|wait|confirm|等待|确认/i);
  });

  contract("ownership", "其他会话的消息不改变正在执行任务的归属", async () => {
    const script = new ScriptedModel();
    entry = await build(script);
    script.holdNext = true;
    entry.send({ type: "task_action", conversationId: entry.conversationId, request: request(entry, { requestId: "own-1" }) });
    await until(() => script.holding, "第一轮模型调用挂起");

    entry.send({ type: "conversation_list", conversationId: "B", requestId: "list-b" });
    await new Promise(resolve => setTimeout(resolve, 20));
    script.release();

    const call = await until(() => entry!.frames.find(f => f.type === "tool_call"), "任务发出工具调用");
    expect(call.conversationId).toBe(entry.conversationId);
  });

  contract("duplicate", "同一 requestId 重复投递只启动一次任务", async () => {
    const script = new ScriptedModel();
    entry = await build(script);
    const message: ClientMessage = { type: "task_action", conversationId: entry.conversationId, request: request(entry, { requestId: "dup-1", text: "只做一次" }) };
    entry.send(message);
    await until(() => script.calls.some(call => call.some(m => m.role === "toolResult")) && idle(entry!), "第一次任务结束");

    // 重复投递应当只拿回原回执；任务不再启动，模型也不再被调用。
    const callsBefore = script.calls.length;
    entry.send(message);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(script.calls.length).toBe(callsBefore);
  });

  contract("staleSteer", "指向过期任务的修订被拒绝，也不进入模型输入", async () => {
    const script = new ScriptedModel();
    entry = await build(script);
    script.holdNext = true;
    entry.send({ type: "task_action", conversationId: entry.conversationId, request: request(entry, { requestId: "run-1" }) });
    await until(() => script.holding, "第一轮模型调用挂起");

    entry.send({ type: "task_action", conversationId: entry.conversationId, request: request(entry, { requestId: "steer-old", action: "steer", expectedRunId: "obsolete-run", text: "改成取消按钮" }) });
    const receipt = await until(() => receiptOf(entry!, "steer-old"), "过期修订的回执");
    script.release();
    await until(() => idle(entry!) && !script.holding, "任务结束");

    expect(receipt.status).toBe("rejected");
    expect(script.calls.flat().some(m => m.text.includes("改成取消按钮"))).toBe(false);
  });
});
