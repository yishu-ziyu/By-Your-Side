/**
 * 会话循环走 pi-durable 的 Harness：每一轮、每一次工具调用、插话和后续都先写入存储，再交给界面。
 * 扩展重载后保留对话与宿主检查点；旧调度任务先取消，用户继续时重新读取页面。
 * 会改页面的工具不标成可重做：执行到一半被打断时，模型只看到「被打断」，不会自动再点一次。
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, isContextOverflow, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type ImageContent, type Message, type Model, type Models, type TextContent, type ToolResultMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { isTransientModelError } from "../../shared/provider-busy.js";
import { isModelTimeoutError } from "../../shared/user-facing.js";
import { createRegistry, defineExtension, defineTool, Harness, hook, MemoryStorage, ProviderDoc, watchEvents, GenerationTask, type AgentEvent as DurableEvent, type Conversation, type EntryRecord, type Storage, type SubmissionId, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentSessionEvent, AgentSessionEventListener, PromptOptions, SessionEntry, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RunNotStarted, type AgentLoop } from "./agent-loop.js";
import { ExtensionHost, OBSERVED_EVENTS, type HookArgs, type HookMessage } from "./extension-host.js";
import type { ModelRequestObservation } from "./model-request-trace.js";
import { ELIDE_MIN_CHARS, PAGE_OBSERVATION_MARK, streamThrough, type PiAgentLoopOptions } from "./pi-agent-loop.js";
import type { PiSessionPersistence } from "./pi-session-persistence.js";
import { composeSystemPrompt } from "./system-prompt.js";

const ctx: Context = BACKGROUND_CONTEXT;

/** 只读工具可以重做：重开后页面没有被它们改过，再读一次结果仍然成立。 */
const REPLAY_SAFE = new Set(["snapshot", "screenshot", "read_element", "read_elements", "scroll", "hover", "tabs", "fetch"]);

const REPEAT_NOTE_AT = 3;
const REPEAT_TRACKED_TOOLS = new Set(["tabs", "snapshot", "read_element", "read_elements", "browser_run"]);
const RUN_CONTEXT_HEADER = "本次运行的上下文，不是用户消息，无需回应这段数据。之前消息前的同类段落只是历史，现状以这一段为准。";
const CONTINUE_TEXT = `${RUN_CONTEXT_HEADER}\n\n上一次模型调用没有完成。接着做同一件事，已经做完的工具不要再执行。`;
const MAX_RETRIES = 2;
/** 服务商的前缀缓存闲置几分钟就清掉（OpenAI、Anthropic 约 5 分钟）；这么久内发过请求，开头还在缓存里，不必再预热。 */
const PROMPT_WARM_FRESH_MS = 4 * 60_000;
const PROMPT_WARM_TEXT = "Reply with OK.";
/** 预热挂住时不能一直占着服务商的并发位子（Kimi 只有 1 个）。 */
const PROMPT_WARM_TIMEOUT_MS = 15_000;
/** pi-durable 认得的说法，只在它判断要不要重试时用；进入记录和界面前去掉。 */
const RETRY_MARK = " (network error)";

interface DurableLoopOptions extends PiAgentLoopOptions {
  /** 每个会话一个存储目录。不给时只放在内存里，重载后接不上。 */
  openStorage?: (conversationId: string) => Promise<Storage>;
}

type CustomAppMessage = Extract<AgentMessage, { role: "custom" }>;

class MemoryEntries {
  private readonly entries: SessionEntry[] = [];
  appendCustomEntry(customType: string, data?: Parameters<SessionManager["appendCustomEntry"]>[1]): string {
    const entry: SessionEntry = { type: "custom", customType, data, id: crypto.randomUUID(), parentId: this.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString() };
    this.entries.push(entry);
    return entry.id;
  }
  getBranch(): SessionEntry[] { return [...this.entries]; }
}

export class DurableAgentLoop implements AgentLoop {
  readonly keepsRunAfterDisconnect = true;
  readonly sessionManager: MemoryEntries | PiSessionPersistence;
  systemPrompt = "";
  retryGate: ((message: AssistantMessage) => boolean) | undefined;
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly definitions: Map<string, ToolDefinition>;
  private readonly hooks: ExtensionHost;
  private readonly durableTools: ToolRegistration[];
  private messages: AgentMessage[] = [];
  private tools: AgentTool[] = [];
  private active: string[];
  private base = "";
  private modelRef: Model<Api>;
  private harness: Harness | undefined;
  private conversation: Conversation | undefined;
  private busy = false;
  private prompts = 0;
  private partial: AssistantMessage | undefined;
  private lastAssistant: AssistantMessage | undefined;
  private retryLimit = MAX_RETRIES;
  private retryAttempt: number | undefined;
  /** 已经送到界面的正文。短回答往往一次写完，没有逐字增量，收尾时要把没送出的部分补上。 */
  private streamedText = "";
  private streamedThinking = "";
  private hookChain: Promise<void> = Promise.resolve();
  private pendingNext: CustomAppMessage[] = [];
  private queued: Array<{ id: SubmissionId; kind: "steer" | "followUp"; text: string }> = [];
  private repeat = { call: "", result: "", count: 0 };
  private abortVersion = 0;
  private warming: AbortController | undefined;
  private modelCalledAt = 0;
  private lastWarm: { startedAt: number; endedAt?: number; outcome: string } | undefined;
  private ready: Promise<void>;
  private markRunEnd: (() => void) | undefined;
  private runEnd: Promise<void> = Promise.resolve();
  /** 这一轮用户输入的原文：模型请求里它和紧挨在前面的运行上下文之前，是可以省略的旧内容。接着做（CONTINUE_TEXT）不换起点。 */
  private runInput: string | undefined;
  /** 超过一次窗口之后，后面的请求都先省略旧内容；没超过时不删，删会改历史前缀、丢掉缓存。 */
  private elide = false;
  /** 这一轮的消息从 messages 的哪一位开始；agent_end 只带这一轮的，和 pi-agent-core 一样。 */
  private runStart = 0;
  private cutText: (() => boolean) | null = null;
  /**
   * 截断后 pi-durable 把这一轮当作答完，排着的插话另起一轮。对界面它们是同一轮（旧核心就是这样）：
   * 中间不发 agent_end，否则半句会被当成最终回答交付。
   */
  private cutForSteer = false;
  /** 截断后跳过了 run_end，还没等到下一轮；停下或超时时要补上这次收尾。 */
  private endSkipped = false;
  private skippedEndTimer: ReturnType<typeof setTimeout> | undefined;
  /** 正在执行的工具。停下时先当场取消它们，再等 pi-durable 把停下写进存储，免得填表之类的动作在这段时间里接着写页面。 */
  private readonly runningTools = new Set<AbortController>();

  readonly agent: AgentLoop["agent"];

  constructor(private readonly options: DurableLoopOptions) {
    const loop = this;
    this.agent = {
      state: {
        get messages() { return loop.messages; },
        set messages(value: AgentMessage[]) { loop.messages = value; },
        get tools() { return loop.tools; },
        set tools(value: AgentTool[]) { loop.tools = value; },
      },
      continue: () => loop.resume(),
      waitForIdle: () => loop.waitForIdle(),
    };
    this.sessionManager = options.persistence ?? new MemoryEntries();
    this.definitions = new Map(options.tools.map(tool => [tool.name, tool]));
    this.active = options.tools.map(tool => tool.name);
    this.modelRef = options.model;
    this.hooks = new ExtensionHost({
      factories: options.extensionFactories,
      allTools: () => options.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines })),
      activeToolNames: () => this.active,
      abort: () => { void this.abort(); },
      onError: options.onHookError,
    });
    this.durableTools = options.tools.map(tool => this.wrapTool(tool));
    this.rebuildPrompt();
    this.syncTools();
    this.ready = this.open();
  }

  static async open(options: DurableLoopOptions): Promise<DurableAgentLoop> {
    const loop = new DurableAgentLoop(options);
    await loop.ready;
    return loop;
  }

  get model(): Model<Api> | undefined { return this.modelRef; }
  get isStreaming(): boolean { return this.busy; }
  get sessionId(): string { return this.options.sessionId ?? ""; }

  async setModel(model: Model<Api>): Promise<void> {
    this.modelRef = model;
    await this.ready;
    await this.configure();
  }

  getActiveToolNames(): string[] { return [...this.active]; }
  getToolDefinition(name: string): ToolDefinition | undefined { return this.definitions.get(name); }

  setActiveToolsByName(toolNames: string[]): void {
    this.active = toolNames.filter(name => this.definitions.has(name));
    this.rebuildPrompt();
    this.syncTools();
    void this.ready.then(() => this.configure());
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async flushPersistence(): Promise<void> { await this.options.persistence?.flush(); }

  /** 插话改方向时截断正在写的这次回答（见 AgentLoop.interruptText）；插话已经先排进队，截断后的结束点会接着读它。 */
  interruptText(): boolean {
    const cut = this.cutText?.() ?? false;
    if (cut) this.cutForSteer = true;
    return cut;
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const version = this.abortVersion;
    await this.ready;
    await this.flushPersistence();
    if (version !== this.abortVersion) throw new RunNotStarted();
    if (this.busy) {
      if (!options?.streamingBehavior) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      await this.queue(options.streamingBehavior === "followUp" ? "followUp" : "steer", text, options.images);
      return;
    }
    await this.submitInput(text, options?.images, version);
  }

  async steer(text: string, images?: ImageContent[]): Promise<"queued"> {
    await this.queue("steer", text, images);
    return "queued";
  }

  async sendCustomMessage(message: Pick<CustomAppMessage, "customType" | "content" | "display" | "details">, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
    await this.ready;
    const appMessage: CustomAppMessage = { role: "custom", customType: message.customType, content: message.content ?? [], display: message.display, details: message.details, timestamp: Date.now() };
    if (options?.deliverAs === "nextTurn") { this.pendingNext.push(appMessage); return; }
    const text = customText(appMessage.content);
    if (this.busy && options?.triggerTurn !== false && options?.triggerTurn !== undefined) {
      await this.queue(options.deliverAs === "followUp" ? "followUp" : "steer", text);
      return;
    }
    if (options?.triggerTurn) { await this.submitInput(text); return; }
    this.messages.push(appMessage);
    await this.writeUser(text);
  }

  clearQueue() {
    const cleared = { steering: this.queued.filter(item => item.kind === "steer").map(item => item.text), followUp: this.queued.filter(item => item.kind === "followUp").map(item => item.text) };
    const ids = this.queued.splice(0).map(item => item.id);
    for (const id of ids) void this.harness?.abortSubmission(id, ctx);
    return cleared;
  }

  async abort(): Promise<void> {
    this.abortVersion += 1;
    this.warming?.abort();
    for (const running of this.runningTools) running.abort();
    const skipped = this.endSkipped;
    this.clearSkippedEnd();
    await this.conversation?.abort(ctx);
    await this.conversation?.waitForIdle(ctx);
    // 截断后跳过的收尾，在下一轮开始前被停下：底层已空闲，不会再有 run_end。
    if (skipped && this.busy) await this.onRunEnd();
    this.busy = false;
  }

  private clearSkippedEnd(): void {
    this.cutForSteer = false;
    this.endSkipped = false;
    clearTimeout(this.skippedEndTimer);
  }

  /**
   * 新对话的第一次模型请求整段不命中服务商的前缀缓存，首字比之后的请求慢一两秒。用户点进输入框时，
   * 用这个对话的服务商会话号、和 pi-durable 写法一样的系统消息（见 systemFirst）先发一个很短的请求，让服务商把这段开头缓存好。
   * 系统提示词和工具要和下一次运行的一字不差，由会话层按运行开始时的规则给出（next）；对不上只是白发一次。
   * 会话号必须和真请求一样：ChatGPT 登录的服务按它分配缓存，换了号就命中不了。
   * 真任务一开始就取消它，有并发上限的服务商（Kimi）不能让它占着位子。
   */
  async warmPromptCache(next: { toolNames: readonly string[]; systemPrompt: (base: string) => string }): Promise<"sent" | "skipped" | "aborted" | "error"> {
    await this.ready;
    const harness = this.harness, conversation = this.conversation, model = this.modelRef;
    if (!harness || !conversation || !model || model.provider !== "openai-codex" || this.busy || this.warming || Date.now() - this.modelCalledAt < PROMPT_WARM_FRESH_MS) return "skipped";
    const warming = new AbortController();
    const warm: { startedAt: number; endedAt?: number; outcome: string } = { startedAt: Date.now(), outcome: "running" };
    this.warming = warming;
    this.lastWarm = warm;
    this.modelCalledAt = warm.startedAt;
    const settle = (outcome: "sent" | "aborted" | "error") => { warm.endedAt = Date.now(); warm.outcome = outcome; return outcome; };
    try {
      const sessionId = await harness.commit(async tx => (await tx.doc(ProviderDoc, conversation.id)).sessionId, ctx);
      const system = { role: "system" as const, content: "", sections: { instructions: `<instructions>\n${next.systemPrompt(this.base)}\n</instructions>` }, toolsAdded: this.durableTools.filter(tool => next.toolNames.includes(tool.name)).map(toToolDeclaration), timestamp: Date.now() };
      const level = this.options.effort?.(model) ?? "off";
      const stream = this.options.models.streamSimple(model, {
        messages: [system, { role: "user", content: PROMPT_WARM_TEXT, timestamp: Date.now() }],
      }, { sessionId, maxTokens: 16, signal: AbortSignal.any([warming.signal, AbortSignal.timeout(PROMPT_WARM_TIMEOUT_MS)]), ...(level === "off" ? {} : { reasoning: level }) });
      let failed = false;
      for await (const event of stream) if (event.type === "error") failed = true;
      return settle(warming.signal.aborted ? "aborted" : failed ? "error" : "sent");
    } catch {
      return settle(warming.signal.aborted ? "aborted" : "error");
    } finally {
      if (this.warming === warming) this.warming = undefined;
    }
  }

  dispose(): void {
    this.warming?.abort();
    this.listeners.clear();
    void this.harness?.close(ctx);
  }

  resume(): Promise<void> { return this.submitInput(CONTINUE_TEXT); }

  private async waitForIdle(): Promise<void> {
    await this.conversation?.waitForIdle(ctx);
  }

  /**
   * 模型报超窗口：把这一轮之前的大段内容（读页结果、页面快照、运行上下文）各换成一行占位，同一次调用里再请求一次。
   * 只改发出的请求，存储里的记录不变。pi-durable 认不出的暂时错误补上它认得的说法，交给它的自动重试。
   */
  private request(send: (messages: Message[]) => AssistantMessageEventStream, model: Model<Api>, messages: Message[]): AssistantMessageEventStream {
    const observed = (stream: AssistantMessageEventStream) => retryable(stream, message => {
      this.retryLimit = isModelTimeoutError(message.errorMessage ?? "") ? 1 : MAX_RETRIES;
    });
    const earlier = elideBefore(messages, runFloor(messages, this.runInput));
    if (this.elide) return observed(send(earlier ?? messages));
    const out = createAssistantMessageEventStream();
    void (async () => {
      const held: AssistantMessageEvent[] = [];
      let first = true;
      for await (const event of send(messages)) {
        if (first && event.type === "start") { held.push(event); continue; }
        if (first && earlier && event.type === "error" && isContextOverflow(event.error, model.contextWindow ?? 0)) {
          this.elide = true;
          this.emit({ type: "compaction_start", reason: "overflow" });
          this.emit({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true });
          for await (const retried of observed(send(earlier))) out.push(retried);
          out.end();
          return;
        }
        first = false;
        for (const start of held.splice(0)) out.push(start);
        out.push(event);
      }
      for (const start of held) out.push(start);
      out.end();
    })();
    return observed(out);
  }

  /** 和外层换备用模型用同一个判断：拿一条典型的暂时错误问它这次能不能换。 */
  private transientProbe(): AssistantMessage {
    return { ...this.blankAssistant(), stopReason: "error", errorMessage: "timeout" };
  }

  private rebuildPrompt(): void {
    this.base = composeSystemPrompt(this.options.systemPrompt, this.options.appendPrompt(), this.options.cwd);
    this.systemPrompt = this.base;
  }

  private syncTools(): void {
    this.tools = this.active.flatMap(name => {
      const tool = this.definitions.get(name);
      return tool ? [tool as unknown as AgentTool] : [];
    });
  }

  private wrapTool(tool: ToolDefinition): ToolRegistration {
    return defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(REPLAY_SAFE.has(tool.name) ? { replay: "safe" as const } : {}),
      execute: async (args, api, context) => {
        await this.flushPersistence();
        const blocked = this.hooks.has("tool_call") ? await this.hooks.toolCall(tool.name, api.callId, args as HookArgs) : undefined;
        if (blocked?.block) {
          const content = [{ type: "text" as const, text: blocked.reason ?? "已阻止" }];
          // Refusals still count toward the existing no-progress budget, even though the tool did not run.
          const hooked = this.hooks.has("tool_result") ? await this.hooks.toolResult({ toolName: tool.name, toolCallId: api.callId, input: args as HookArgs, content, details: blocked.details, isError: true }) : undefined;
          return { content: [...(hooked?.content ?? content)], details: (hooked?.details ?? blocked.details) as never, isError: hooked?.isError ?? true };
        }
        // 抛出的错误要留在结果正文里。pi-durable 会把异常收成诊断，模型看到的就变成带外壳的一段，认不出原来的那句。
        const running = new AbortController();
        const stop = () => running.abort();
        if (context.abortSignal?.aborted) running.abort(); else context.abortSignal?.addEventListener("abort", stop, { once: true });
        this.runningTools.add(running);
        const result = await tool.execute(api.callId, args as never, running.signal, async (partial) => {
          const details = (partial as { details?: unknown }).details;
          if (details !== undefined) await api.details(details as never, context);
        }, undefined as never).catch((error: unknown) => ({
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true as const,
        })).finally(() => {
          this.runningTools.delete(running);
          context.abortSignal?.removeEventListener("abort", stop);
        });
        const repeated = this.noteRepeat(tool.name, args, result.content);
        const hooked = this.hooks.has("tool_result") ? await this.hooks.toolResult({ toolName: tool.name, toolCallId: api.callId, input: args as HookArgs, content: result.content, details: result.details as never, isError: result.isError === true }) : undefined;
        const content = [...(hooked?.content ?? result.content), ...(repeated ? [{ type: "text" as const, text: repeated }] : [])];
        // pi-agent-core 的 terminate 在 pi-durable 里叫 control.terminate；不转过去，交付结论后会多问模型一轮、侧栏出现两遍。
        const terminate = "terminate" in result && result.terminate === true;
        return { content, details: (hooked?.details ?? result.details) as never, isError: hooked?.isError ?? result.isError === true, ...(terminate ? { control: { terminate: true as const } } : {}) };
      },
    });
  }

  private async open(): Promise<void> {
    const pi = this.options.models.pi;
    if (!pi) throw new Error("模型目录没有接上，pi-durable 无法调用模型。");
    const stream = streamThrough(this.options.models, context => this.observe(context), this.options.onModelResponse, this.options.effort, this.options.firstEventTimeoutMs, (cut, live) => { if (live) this.cutText = cut; else if (this.cutText === cut) this.cutText = null; }, this.options.onModelHedge);
    const models = withStream(pi, (model, context, streamOptions) => this.request(messages => stream(model, { ...context, messages } as never, streamOptions) as AssistantMessageEventStream, model, forModel(context.messages)), () => this.modelRef);
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "sideagent",
      tools: this.durableTools,
      hooks: [hook(GenerationTask, { beforeRequest: async (request) => this.beforeRequest(request.messages) })],
    }));
    const loop = this;
    const storage = this.options.openStorage ? await this.options.openStorage(this.sessionId || "default") : new MemoryStorage();
    this.harness = await Harness.open(storage, {
      models,
      registry,
      settings: {
        // 每次决定重试时现读：能换备用模型时不在原模型上重试，交给外层去换。
        get retry() { return { maxRetries: loop.retryGate?.(loop.transientProbe()) === false ? 0 : loop.retryLimit, baseDelayMs: 500 }; },
        compaction: { enabled: false },
        steeringMode: "all",
        followUpMode: "all",
      },
    }, ctx);
    this.conversation = await this.harness.root(ctx);
    // Mark every recovered task before enabling the scheduler: even a passive write or wait can resume stale work.
    // The host checkpoint remains available for an explicit continuation with a fresh page observation.
    const recovered = await this.harness.inspect(ctx);
    for (const task of recovered.tasks) await this.harness.abortTask(task.record.id, ctx);
    for (const submission of recovered.submissions) await this.harness.abortSubmission(submission.id, ctx);
    if (recovered.tasks.length) await this.harness.waitForIdle(ctx);
    await this.configure();
    await this.loadTranscript();
    const watch = await watchEvents(this.harness, this.conversation.id, ctx);
    watch.start(async (events) => { for (const event of events) await this.onDurable(event); });
  }

  private async beforeRequest(messages: readonly Message[]): Promise<{ messages: readonly Message[] } | undefined> {
    const next = this.hooks.has("context") ? [...await this.hooks.context(messages as readonly HookMessage[])] as Message[] : [...messages];
    return { messages: systemFirst(next) };
  }

  private async configure(): Promise<void> {
    const level = this.options.effort?.(this.modelRef) ?? "off";
    const offered = this.durableTools.filter(tool => this.active.includes(tool.name));
    await this.conversation?.configure({
      model: { provider: this.modelRef.provider, modelId: this.modelRef.id },
      thinkingLevel: level,
      instructions: this.systemPrompt,
      tools: offered,
    }, ctx);
  }

  private async loadTranscript(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    const loaded: Array<{ id: number; message: AgentMessage }> = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    for (let page = 0; page < 20; page += 1) {
      const batch = await conversation.entries({}, 200, cursor, ctx);
      for (const entry of batch.items) {
        const message = entry.model?.[0];
        if (message && message.role !== "system") loaded.push({ id: entry.id, message: withoutRetryMark(message) as AgentMessage });
      }
      if (!batch.next) break;
      cursor = batch.next;
    }
    loaded.sort((a, b) => a.id - b.id);
    if (!loaded.length) return;
    this.messages = loaded.map(item => item.message);
    // 重开后从存储接着做的那一轮不会再发 run_start：起点按最后一句用户自己的话算。
    this.runStart = Math.max(0, runFloor(this.messages as Message[], undefined));
  }

  private async submitInput(text: string, images?: ImageContent[], version = this.abortVersion): Promise<void> {
    // 准备阶段（钩子、记忆选择）还没到 busy，期间点进输入框也不该再起一次预热去挡真请求。
    this.modelCalledAt = Date.now();
    this.warming?.abort();
    await this.ready;
    const conversation = this.conversation;
    if (!conversation) return;
    // 准备阶段还没有运行可取消，停止只记在 abortVersion 上：每段等待之后都要看一眼，停了就不再提交。
    const stopped = () => version !== this.abortVersion;
    if (this.hooks.has("input")) await this.hooks.input(text);
    if (this.hooks.has("before_agent_start")) {
      const started = await this.hooks.beforeAgentStart(text, this.base);
      if (stopped()) throw new RunNotStarted();
      this.systemPrompt = started.systemPrompt;
      if (started.context.length) await this.writeUser([RUN_CONTEXT_HEADER, ...started.context].join("\n\n"));
    }
    for (const message of this.pendingNext.splice(0)) await this.writeUser(customText(message.content));
    await this.configure();
    if (stopped()) throw new RunNotStarted();
    if (text !== CONTINUE_TEXT) this.runInput = text;
    const content = images?.length ? [{ type: "text" as const, text }, ...images] : text;
    this.prompts += 1;
    this.busy = true;
    this.runEnd = new Promise(resolve => { this.markRunEnd = resolve; });
    try {
      const submission = await conversation.submit({ type: "input", content, requestId: crypto.randomUUID() }, ctx);
      await submission.wait(ctx);
      await this.runEnd;
    } finally {
      this.prompts -= 1;
      this.markRunEnd?.();
      this.markRunEnd = undefined;
      if (this.prompts === 0 && !this.busy) this.emit({ type: "agent_settled" });
    }
  }

  private async queue(kind: "steer" | "followUp", text: string, images?: ImageContent[]): Promise<void> {
    await this.ready;
    const conversation = this.conversation;
    if (!conversation) return;
    const content = images?.length ? [{ type: "text" as const, text }, ...images] : text;
    const submission = await conversation.submit({ type: "input", content, requestId: crypto.randomUUID(), whenBusy: kind === "steer" ? "steer" : "followUp" }, ctx);
    this.queued.push({ id: submission.id, kind, text });
  }

  private async writeUser(text: string): Promise<void> {
    await this.conversation?.submit({ type: "write", entry: { kind: "pi.user", model: [{ role: "user", content: text, timestamp: Date.now() }] } }, ctx);
  }

  private async onDurable(event: DurableEvent): Promise<void> {
    if (event.type === "run_start") {
      if (this.cutForSteer) { this.clearSkippedEnd(); return; }
      // 这一轮的输入在 run_start 之前已经写进 messages。
      let start = this.messages.length;
      while (start > 0 && (this.messages[start - 1]!.role === "user" || this.messages[start - 1]!.role === "custom")) start -= 1;
      this.runStart = start;
      this.busy = true;
      this.emit({ type: "agent_start" });
      return;
    }
    if (event.type === "turn_start") { this.emit({ type: "turn_start" }); return; }
    if (event.type === "turn_end") {
      const message = this.lastAssistant ?? this.messages.at(-1);
      if (message) this.emit({ type: "turn_end", message, toolResults: [] });
      return;
    }
    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        this.partial = event.message;
        this.streamedText = "";
        this.streamedThinking = "";
        this.emit({ type: "message_start", message: event.message as AgentMessage });
        this.emitUnsent(event.message);
      } else if (event.message.role !== "system") this.emit({ type: "message_start", message: event.message as AgentMessage });
      return;
    }
    if (event.type === "message_update") { this.onUpdate(event); return; }
    if (event.type === "message_end") { await this.onMessageEnd(event.entry); return; }
    if (event.type === "tool_execution_start") {
      this.emit({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      return;
    }
    if (event.type === "tool_execution_update") {
      this.emit({ type: "tool_execution_update", toolCallId: event.toolCallId, toolName: event.toolName, args: {}, partialResult: { details: event.details } });
      return;
    }
    if (event.type === "tool_execution_end") { this.onToolEnd(event.toolCallId, event.toolName, event.entry); return; }
    if (event.type === "auto_retry_start") {
      this.emit({ type: "auto_retry_start", attempt: event.attempt, maxAttempts: this.retryLimit, delayMs: Math.max(0, event.at - Date.now()), errorMessage: event.errorMessage.replace(RETRY_MARK, "") });
      return;
    }
    // durable 的 end 只表示退避结束；下一次模型结果到达后才能判断重试成败。
    if (event.type === "auto_retry_end") { this.retryAttempt = event.attempt; return; }
    if (event.type === "compaction_start") { this.emit({ type: "compaction_start", reason: event.reason === "overflow" ? "overflow" : event.reason === "manual" ? "manual" : "threshold" }); return; }
    if (event.type === "run_end") await this.onRunEnd();
  }

  private onUpdate(event: Extract<DurableEvent, { type: "message_update" }>): void {
    for (const change of event.changes) {
      if (change.type === "message") this.partial = change.message;
      else if (change.type === "text_delta" || change.type === "thinking_delta") this.appendDelta(change.type, change.contentIndex, change.delta);
      else if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start" || change.type === "block") this.ensureBlock(change.contentIndex, change.block);
      if (!this.partial) continue;
      // 整条或整块送来时，块里可能已经带着这一批里出的字（pi-durable：整块发送的块已含本批后续改动），这些字没走增量：
      // 当场补发，界面收到的字始终是全文的开头；不然收尾补发时对不上，会把整句再发一遍（侧栏出现「后半句＋整句」）。
      if (change.type === "message" || change.type === "text_start" || change.type === "thinking_start" || change.type === "block") this.emitUnsent(this.partial);
      const assistantMessageEvent = change.type === "text_delta" || change.type === "thinking_delta"
        ? { type: change.type, contentIndex: change.contentIndex, delta: change.delta, partial: this.partial }
        : { type: "text_delta" as const, contentIndex: 0, delta: "", partial: this.partial };
      if (change.type === "text_delta" || change.type === "thinking_delta" || change.type === "toolcall_delta" || change.type === "block") {
        this.emit({ type: "message_update", message: this.partial, assistantMessageEvent: change.type === "toolcall_delta" || change.type === "block" ? { type: "toolcall_delta", contentIndex: "contentIndex" in change ? change.contentIndex : 0, delta: "", partial: this.partial } : assistantMessageEvent });
      }
    }
  }

  private appendDelta(kind: "text_delta" | "thinking_delta", index: number, delta: string): void {
    const partial = this.partial ?? this.blankAssistant();
    this.partial = partial;
    const block = partial.content[index];
    if (kind === "text_delta" && block?.type === "text") { block.text += delta; this.streamedText += delta; }
    else if (kind === "thinking_delta" && block?.type === "thinking") { block.thinking += delta; this.streamedThinking += delta; }
  }

  private ensureBlock(index: number, block: AssistantMessage["content"][number]): void {
    const partial = this.partial ?? this.blankAssistant();
    this.partial = partial;
    partial.content[index] = block;
  }

  private blankAssistant(): AssistantMessage {
    return {
      role: "assistant", content: [], api: this.modelRef.api, provider: this.modelRef.provider, model: this.modelRef.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
  }

  /** 界面只认逐字增量。整段一次落盘时，把还没出现过的正文和思考补成一次增量。 */
  private emitUnsent(message: AssistantMessage): void {
    let text = "";
    let thinking = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") thinking += block.thinking;
    }
    const textDelta = text.startsWith(this.streamedText) ? text.slice(this.streamedText.length) : text;
    const thinkingDelta = thinking.startsWith(this.streamedThinking) ? thinking.slice(this.streamedThinking.length) : thinking;
    this.streamedText = text;
    this.streamedThinking = thinking;
    if (thinkingDelta) this.emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinkingDelta, partial: message } });
    if (textDelta) this.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: textDelta, partial: message } });
  }

  private async onMessageEnd(entry: EntryRecord): Promise<void> {
    const stored = entry.model?.[0];
    if (!stored || stored.role === "system") return;
    const message = withoutRetryMark(stored);
    if (message.role === "assistant" && this.retryAttempt !== undefined) {
      this.emit({ type: "auto_retry_end", success: message.stopReason !== "error" && message.stopReason !== "aborted", attempt: this.retryAttempt });
      this.retryAttempt = undefined;
    }
    // 自动重试成功后，前一条出错的回复不再算这一轮的结果：旧核心重试前就把它从历史里拿掉了。
    const previous = this.messages.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant" && previous.stopReason === "error") this.messages.pop();
    this.messages.push(message as AgentMessage);
    this.options.persistence?.appendMessage(message as AgentMessage);
    if (message.role === "assistant") this.emitUnsent(message);
    this.emit({ type: "message_end", message: message as AgentMessage });
    if (message.role === "assistant") this.lastAssistant = message;
  }

  private onToolEnd(toolCallId: string, toolName: string, entry: EntryRecord | undefined): void {
    const message = entry?.model?.[0];
    const result = message?.role === "toolResult" ? message : interruptedResult(toolCallId, toolName);
    this.emit({ type: "tool_execution_end", toolCallId, toolName, result, isError: result.isError });
  }

  private async onRunEnd(): Promise<void> {
    await this.flushPersistence();
    if (this.cutForSteer) {
      // 插话已先写进存储，正常情况下下一轮马上开始；没开始就按普通结束收尾，免得界面一直显示在做。
      this.endSkipped = true;
      clearTimeout(this.skippedEndTimer);
      this.skippedEndTimer = setTimeout(() => { if (this.endSkipped) { this.clearSkippedEnd(); void this.onRunEnd(); } }, 3_000);
      return;
    }
    const end: AgentSessionEvent = { type: "agent_end", messages: this.messages.slice(this.runStart), willRetry: false };
    if (this.retryAttempt !== undefined) {
      this.emit({ type: "auto_retry_end", success: false, attempt: this.retryAttempt });
      this.retryAttempt = undefined;
    }
    this.busy = false;
    this.emit(end);
    this.markRunEnd?.();
    this.markRunEnd = undefined;
    if (this.prompts === 0) this.emit({ type: "agent_settled" });
  }

  private noteRepeat(name: string, args: unknown, content: readonly (TextContent | ImageContent)[]): string | null {
    const call = `${name} ${stableJson(args)}`;
    const result = content.map(part => (part.type === "text" ? part.text : "")).join("\n").replace(/\s+/g, " ").trim();
    if (!REPEAT_TRACKED_TOOLS.has(name) || !result) { this.repeat = { call: "", result: "", count: 0 }; return null; }
    const same = call === this.repeat.call && result === this.repeat.result;
    this.repeat = { call, result, count: same ? this.repeat.count + 1 : 1 };
    return this.repeat.count >= REPEAT_NOTE_AT ? `[框架说明] 这是连续第 ${this.repeat.count} 次同样的调用，结果没有变化。如果在等页面变化，先等待再读（例如 browser.sleep 或 wait_for）；否则请换一种做法。` : null;
  }

  private observe(context: Parameters<Parameters<typeof streamThrough>[1]>[0]): void {
    this.modelCalledAt = Date.now();
    if (!this.options.onModelRequest) return;
    try {
      const system = context.messages.find(message => message.role === "system");
      const observation: ModelRequestObservation = {
        systemPrompt: this.systemPrompt,
        tools: (system?.role === "system" ? system.toolsAdded ?? [] : []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        messages: context.messages.filter(message => message.role !== "system"),
        injected: [],
        ...(this.lastWarm ? { promptWarm: { sinceMs: Date.now() - this.lastWarm.startedAt, ms: this.lastWarm.endedAt === undefined ? null : this.lastWarm.endedAt - this.lastWarm.startedAt, outcome: this.lastWarm.outcome } } : {}),
      };
      this.options.onModelRequest(observation);
    } catch { /* 诊断只观察。 */ }
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
    if (OBSERVED_EVENTS.has(event.type)) this.hookChain = this.hookChain.then(() => this.hooks.notify(event));
  }
}

function customText(content: CustomAppMessage["content"]): string {
  return typeof content === "string" ? content : content.map(part => part.type === "text" ? part.text : "").join("");
}

function interruptedResult(toolCallId: string, toolName: string): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: `Tool ${toolName} was interrupted before it finished. Read the page again before doing anything that changes it.` }], isError: true, timestamp: Date.now() };
}

function textOf(message: Message): string {
  if (message.role !== "user" && message.role !== "toolResult") return "";
  return typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
}

/**
 * 这一轮在请求里从哪条开始：用户输入那条，前面紧挨着的运行上下文也算这一轮。
 * 重开后从存储接着做时不知道原文，取最后一条用户自己的话（可能是一句插话，只会多省略这一轮更早的内容）。
 */
function runFloor(messages: readonly Message[], input: string | undefined): number {
  const isInput = (message: Message) => message.role === "user" && (input === undefined ? !textOf(message).startsWith(RUN_CONTEXT_HEADER) : textOf(message) === input);
  let at = messages.length - 1;
  while (at >= 0 && !isInput(messages[at]!)) at -= 1;
  return at > 0 && textOf(messages[at - 1]!).startsWith(RUN_CONTEXT_HEADER) ? at - 1 : at;
}

/** floor 之前的大段内容换成占位后的请求；没有能删的就返回 null。 */
function elideBefore(messages: readonly Message[], floor: number): Message[] | null {
  let elided = 0;
  const stub = (chars: number): TextContent => ({ type: "text", text: `[Earlier content elided to fit the context window: ${chars} chars. The page may have changed since; read it again if needed.]` });
  const trim = (text: string): string | null => {
    if (text.startsWith(RUN_CONTEXT_HEADER)) return text.length >= ELIDE_MIN_CHARS ? stub(text.length).text : null;
    const at = text.indexOf(PAGE_OBSERVATION_MARK);
    return at >= 0 && text.length - at >= ELIDE_MIN_CHARS ? `${text.slice(0, at)}${stub(text.length - at).text}` : null;
  };
  const result = messages.map((message, index): Message => {
    if (index >= floor) return message;
    if (message.role === "toolResult") {
      const chars = message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : ELIDE_MIN_CHARS), 0);
      if (chars < ELIDE_MIN_CHARS) return message;
      elided += 1;
      return { ...message, content: [stub(chars)] };
    }
    if (message.role !== "user") return message;
    if (typeof message.content === "string") {
      const text = trim(message.content);
      if (text === null) return message;
      elided += 1;
      return { ...message, content: text };
    }
    let changed = false;
    const content = message.content.map(part => {
      if (part.type === "image") { changed = true; return stub(ELIDE_MIN_CHARS); }
      const text = trim(part.text);
      if (text === null) return part;
      changed = true;
      return { ...part, text };
    });
    if (!changed) return message;
    elided += 1;
    return { ...message, content };
  });
  return elided ? result : null;
}

/**
 * pi-durable 只按 pi-ai 的说法判断能不能重试。扩展里断网报「Failed to fetch」、服务商用中文说并发满了、工具参数写跑了，
 * 这些我们也当暂时错误，在错误后面补一个它认得的词（RETRY_MARK）。
 */
function retryable(stream: AssistantMessageEventStream, onError?: (message: AssistantMessage) => void): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of stream) {
      if (event.type === "error") onError?.(event.error);
      if (event.type === "error" && event.reason === "error" && isTransientModelError(event.error) && !isRetryableAssistantError(event.error)) {
        out.push({ ...event, error: { ...event.error, errorMessage: `${event.error.errorMessage ?? ""}${RETRY_MARK}` } });
      } else out.push(event);
    }
    out.end();
  })();
  return out;
}

function withoutRetryMark<T extends Message>(message: T): T {
  return message.role === "assistant" && message.errorMessage?.endsWith(RETRY_MARK) ? { ...message, errorMessage: message.errorMessage.slice(0, -RETRY_MARK.length) } : message;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * pi-durable 在每次请求前才把系统提示词和工具清单写进对话，所以新对话里它们排在运行上下文和用户这句话后面，
 * 整段请求从第二条起就和任何缓存过的开头对不上。只在发出的请求里把第一条系统消息挪到最前：
 * pi-ai 把开头的系统消息当成 instructions 和 tools 发，固定的这段成了每次请求的共同开头。存储里的顺序不变。
 */
function systemFirst(messages: Message[]): Message[] {
  const at = messages.findIndex(message => message.role === "system");
  return at <= 0 ? messages : [messages[at]!, ...messages.slice(0, at), ...messages.slice(at + 1)];
}

function forModel(messages: readonly Message[]): Message[] {
  // 宿主插进请求的 custom 消息（状态快照）要变成 user 文本。估算 token 时不认识 custom，会去读不存在的 name。
  return messages.flatMap((message): Message[] => {
    const loose = message as Message | { role: "custom"; content?: string | Array<{ type?: string; text?: string }>; timestamp: number };
    if (loose.role === "custom") {
      const content = loose.content;
      const text = typeof content === "string" ? content : (content ?? []).map(part => part.type === "text" ? part.text ?? "" : "").join("");
      return text ? [{ role: "user", content: text, timestamp: loose.timestamp }] : [];
    }
    return message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : [];
  });
}

function withStream(models: Models, streamSimple: Models["streamSimple"], current: () => Model<Api> | undefined): Models {
  return new Proxy(models, {
    get(target, prop, receiver) {
      if (prop === "streamSimple") return streamSimple;
      // 目录外的模型（自定义地址、服务商还没列进目录的 id）解析时就在手上，getModel 会找不到。
      if (prop === "getModel") return (provider: string, id: string) => target.getModel(provider, id) ?? (current()?.provider === provider && current()?.id === id ? current() : undefined);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
