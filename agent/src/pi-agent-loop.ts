/**
 * AgentLoop 的浏览器实现：pi-agent-core 的 Agent 加上 session.ts 依赖的那部分 AgentSession 行为。
 *
 * pi-coding-agent 的 AgentSession 打进扩展要 7.8 MB 并拉入终端界面、undici、30 多个 Node 内置模块，所以这里
 * 按 0.84.4 源码（dist/core/agent-session.js）复刻 session.ts 实际用到的行为：
 * - prompt：input 钩子 → 运行中按 streamingBehavior 排队 → 组装用户消息与「下一轮」消息 →
 *   before_agent_start 钩子只对本轮替换系统提示词 → 运行；
 * - 运行：每轮结束后可重试的错误按 2 次、0.5 秒起翻倍重试，再 continue；结束时写入暂存的自定义消息；
 * - sendCustomMessage 的五个分支、插话记账、agent_end 的 willRetry、auto_retry_start/end 事件；
 * - 切换工具时用 composeSystemPrompt 重建系统提示词；Pi 1.0 起每次请求开头拼一条 system 消息带上它和工具清单。
 * 会话消息和任务检查点可交给Pi原生Session；扩展提供持久存储。
 */
// Pi 1.0 删掉了 convertToLlm（custom 消息转 user）；沿用 0.84.4 的实现。
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { firstEventTimeout } from "../../shared/model-capabilities.js";
import { isTransientModelError } from "../../shared/provider-busy.js";
import { createAssistantMessageEventStream, isContextOverflow, type Api, type AssistantMessage, type AssistantMessageEventStream, type ImageContent, type Message, type Model, type ModelThinkingLevel, type StreamOptions, type TextContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, AgentSessionEventListener, CustomEntry, ExtensionFactory, PromptOptions, SessionEntry, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentLoop, ModelPort } from "./agent-loop.js";
import { ExtensionHost, OBSERVED_EVENTS, type HookArgs, type HookMessage } from "./extension-host.js";
import type { ModelRequestObservation } from "./model-request-trace.js";
import { PiSessionPersistence } from "./pi-session-persistence.js";
import { composeSystemPrompt } from "./system-prompt.js";

export interface PiAgentLoopOptions {
  models: ModelPort;
  model: Model<Api>;
  tools: readonly ToolDefinition[];
  systemPrompt: string;
  /** 模式附加段；每次重建系统提示词时重新求值（对应 Pi 的 appendSystemPromptOverride）。 */
  appendPrompt: () => string[];
  cwd: string;
  extensionFactories: readonly ExtensionFactory[];
  sessionId?: string;
  persistence?: PiSessionPersistence;
  messages?: AgentMessage[];
  retry?: { maxRetries: number; baseDelayMs: number };
  /** 模型多久不出第一个事件就取消这次调用、按可重试错误处理；默认取能力表登记值，再退到 MODEL_FIRST_EVENT_TIMEOUT_MS。 */
  firstEventTimeoutMs?: number;
  onHookError?: (event: string, message: string) => void;
  /** 每次模型调用前观察实际请求（诊断记录用）；只读，抛错被吞掉。 */
  onModelRequest?: (request: ModelRequestObservation) => void;
  /** 每次模型调用前取这次的思考档（见 main-effort.ts）；"off" 表示不发思考参数。不给时沿用 Agent 的设置。 */
  effort?: (model: Model<Api>) => ModelThinkingLevel;
}

/** 宿主插入的消息：pi-coding-agent 已给 Agent 的消息联合加上 custom 角色（core/messages.d.ts）；convertToLlm 把它转成 user 消息。 */
type CustomAppMessage = Extract<AgentMessage, { role: "custom" }>;

type CustomDetails = Parameters<SessionManager["appendCustomEntry"]>[1];

/** session.ts 只写、只读 custom 条目（appendCustomEntry / getBranch）。 */
class MemoryEntries {
  private readonly entries: SessionEntry[] = [];

  appendCustomEntry(customType: string, data?: CustomDetails): string {
    const entry: CustomEntry = { type: "custom", customType, data, id: crypto.randomUUID(), parentId: this.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString() };
    this.entries.push(entry);

    return entry.id;
  }

  getBranch(): SessionEntry[] {
    return [...this.entries];
  }
}

/**
 * 模型调用发出后多久还没有第一个事件（文字、思考、工具调用或结束）就算挂起。
 * 依据 2026-10-01 日常记录：首个回应 p90 约 4.7 s，长提示词最慢约 12 s；挂起的服务要 30 s 才报 Connection error。
 * 见 docs/evals/20261004-model-failover.md。
 */
export const MODEL_FIRST_EVENT_TIMEOUT_MS = 15_000;

/**
 * 服务端已发出原始事件（如 response.created）后，等第一个内容事件的上限。排队发生在这之前，不受这条限制；
 * 10-07 实测 gpt-6-luna 39 次正常请求「已创建」到开始输出最长 1.8 秒，挂住的 2 次之后再无下文。
 */
export const MODEL_STALL_AFTER_START_MS = 10_000;

/**
 * 工具调用参数里连续这么多空白，就算模型写跑了：取消这次请求，按可重试错误重来。
 * 10-07 实测 gpt-6-luna 在 user_memory 参数里先自言自语、再无休止地输出空白，60 秒写了上万字也不收尾（YIS-92）；正常参数里不会有这么长的空白。
 */
export const RUNAWAY_TOOL_ARGS_BLANKS = 512;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
});

const isTextPart = (part: { type: string }): part is TextContent => part.type === "text";

const textOf = (message: AgentMessage): string => {
  if (message.role !== "user" || !Array.isArray(message.content)) return "";

  return message.content.filter(isTextPart).map(part => part.text).join("");
};

const userContent = (content: CustomAppMessage["content"]): (TextContent | ImageContent)[] => (Array.isArray(content) ? content : [{ type: "text", text: content }]);

export class PiAgentLoop implements AgentLoop {
  readonly agent: Agent;
  readonly sessionManager: MemoryEntries | PiSessionPersistence;
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly definitions: Map<string, ToolDefinition>;
  private readonly hooks: ExtensionHost;
  private readonly unsubscribe: () => void;
  private readonly retry: { maxRetries: number; baseDelayMs: number };
  private active: string[];
  private base = "";
  private override: string | undefined;
  /** 这一轮的系统提示词。Pi 1.0 把提示词放进消息里的 system 消息；我们每次请求前重新拼一条，不写进会话记录。 */
  systemPrompt = "";
  private steering: string[] = [];
  private followUps: string[] = [];
  private pendingCustom: CustomAppMessage[] = [];
  private pendingNextTurn: CustomAppMessage[] = [];
  private lastAssistant: AssistantMessage | undefined;
  private retryAttempt = 0;
  /** 见 AgentLoop.retryGate：返回 false 时这次失败不在同一模型上重试（由外层换备用模型）。 */
  retryGate: ((message: AssistantMessage) => boolean) | undefined;
  private retryAbort: AbortController | undefined;
  private runActive = false;
  private abortVersion = 0;
  private hookChain: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  /** 本次调用里宿主插入的上下文消息：convertToLlm 把 custom 转成 user 前记下，紧接着的模型调用读取。 */
  private injected: ModelRequestObservation["injected"] = [];
  /** 当前这次模型调用的截断入口（见 AgentLoop.interruptText）；调用结束后清空。 */
  private cutText: (() => boolean) | null = null;

  constructor(private readonly options: PiAgentLoopOptions) {
    // 0.5、1 秒两次重试：服务挂起时最坏 15 s × 3 + 1.5 s 就告诉用户，而不是让人干等几分钟。
    this.sessionManager = options.persistence ?? new MemoryEntries();
    this.retry = options.retry ?? { maxRetries: 2, baseDelayMs: 500 };
    this.definitions = new Map(options.tools.map(tool => [tool.name, tool]));
    this.active = options.tools.map(tool => tool.name);

    this.hooks = new ExtensionHost({
      factories: options.extensionFactories,
      allTools: () => options.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines })),
      activeToolNames: () => this.active,
      abort: () => { void this.abort(); },
      onError: options.onHookError,
    });

    this.agent = new Agent({
      initialState: { model: options.model, systemPrompt: "", tools: [], messages: options.messages ?? [] },
      streamFn: streamThrough(options.models, context => this.observeRequest(context), options.effort, options.firstEventTimeoutMs, (cut, live) => { if (live) this.cutText = cut; else if (this.cutText === cut) this.cutText = null; }),
      // 自定义消息转成 user 消息后送给模型。
      convertToLlm: messages => {
        this.injected = messages.flatMap(message => (message.role === "custom" ? [{ customType: message.customType, text: customText(message.content) }] : []));

        return [this.systemMessage(), ...legacyMessages(messages.filter(message => message.role !== "system"))];
      },
      transformContext: async messages => {
        const explained = this.explainUnknownTools(messages);

        return this.hooks.has("context") ? this.contextThroughHooks(explained) : explained;
      },
      beforeToolCall: async ({ toolCall, args }) => {
        await this.flushPersistence();

        return this.hooks.has("tool_call") ? this.hooks.toolCall(toolCall.name, toolCall.id, hookArgs(args)) : undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        if (!this.hooks.has("tool_result")) return undefined;

        const hookResult = await this.hooks.toolResult({ toolName: toolCall.name, toolCallId: toolCall.id, input: hookArgs(args), content: result.content, details: result.details, isError });

        return hookResult ? { content: hookResult.content ? [...hookResult.content] : undefined, details: hookResult.details, isError: hookResult.isError } : undefined;
      },
      steeringMode: "all",
      sessionId: options.sessionId ?? crypto.randomUUID(),
    });

    this.unsubscribe = this.agent.subscribe(event => this.onAgentEvent(event));
    this.setActiveToolsByName(this.active);
  }

  get model(): Model<Api> | undefined {
    return this.agent.state.model;
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  get sessionId(): string {
    return this.agent.sessionId ?? "";
  }

  async setModel(model: Model<Api>): Promise<void> {
    this.agent.state.model = model;
  }

  getActiveToolNames(): string[] {
    return [...this.active];
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.active = toolNames.filter(name => this.definitions.has(name));
    this.agent.state.tools = this.active.map(name => toAgentTool(this.definitions.get(name)!));
    this.base = composeSystemPrompt(this.options.systemPrompt, this.options.appendPrompt(), this.options.cwd);
    this.systemPrompt = this.override ?? this.base;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);

    return () => { this.listeners.delete(listener); };
  }

  async flushPersistence(): Promise<void> { await this.options.persistence?.flush(); }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    if (this.options.persistence) {
      const version = this.abortVersion;
      await this.flushPersistence();

      if(version !== this.abortVersion)throw new Error("本轮已取消，没有启动模型或操作页面。");
    }

    const images = options?.images;

    if (this.hooks.has("input")) await this.hooks.input(text);

    if (this.isStreaming) {
      if (!options?.streamingBehavior) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");

      if (options.streamingBehavior === "followUp") this.queue("followUp", text, images);
      else this.queue("steer", text, images);

      return;
    }

    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() }, ...this.pendingNextTurn];
    this.pendingNextTurn = [];

    const systemPrompt = this.hooks.has("before_agent_start") ? await this.hooks.beforeAgentStart(text, this.base) : this.base;
    this.override = systemPrompt === this.base ? undefined : systemPrompt;
    this.systemPrompt = systemPrompt;
    await this.run(messages);
  }

  async steer(text: string, images?: ImageContent[]): Promise<"queued"> {
    this.queue("steer", text, images);

    return "queued";
  }

  interruptText(): boolean {
    return this.cutText?.() ?? false;
  }

  async sendCustomMessage(message: Pick<CustomAppMessage, "customType" | "content" | "display" | "details">, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
    const appMessage: CustomAppMessage = { role: "custom", customType: message.customType, content: message.content ?? [], display: message.display, details: message.details, timestamp: Date.now() };

    if (options?.deliverAs === "nextTurn") this.pendingNextTurn.push(appMessage);
    else if (this.isStreaming && options?.triggerTurn !== false) {
      if (options?.deliverAs === "followUp") this.agent.followUp(appMessage);
      else this.agent.steer(appMessage);
    } else if (options?.triggerTurn) await this.run([appMessage]);
    else if (this.isStreaming) this.pendingCustom.push(appMessage);
    else this.appendCustom(appMessage);
  }

  clearQueue() {
    const cleared = { steering: [...this.steering], followUp: [...this.followUps] };
    this.steering = [];
    this.followUps = [];
    this.agent.clearAllQueues();

    return cleared;
  }

  async abort(): Promise<void> {
    this.abortVersion += 1;
    this.retryAbort?.abort();
    this.agent.abort();
    await this.waitForIdle();
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.retryAbort?.abort();
    this.agent.abort();
  }

  private waitForIdle(): Promise<void> {
    if (!this.runActive) return this.agent.waitForIdle();

    return new Promise(resolve => { this.idleWaiters.push(resolve); });
  }

  private queue(kind: "steer" | "followUp", text: string, images?: ImageContent[]): void {
    (kind === "steer" ? this.steering : this.followUps).push(text);
    const message: AgentMessage = { role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() };

    if (kind === "steer") this.agent.steer(message);
    else this.agent.followUp(message);
  }

  /** 接着当前上下文再跑一轮，同样带自动重试（换备用模型后用）。 */
  resume(): Promise<void> {
    return this.run(() => this.agent.continue());
  }

  private async run(start: AgentMessage[] | (() => Promise<void>)): Promise<void> {
    this.runActive = true;

    try {
      await (Array.isArray(start) ? this.agent.prompt(start) : start());

      while (await this.afterRun()) await this.agent.continue();
    } finally {
      this.override = undefined;
      this.flushCustom();

      try { await this.flushPersistence(); } finally {
        this.runActive = false;
        this.emit({ type: "agent_settled" });

        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  private async afterRun(): Promise<boolean> {
    const message = this.lastAssistant;
    this.lastAssistant = undefined;

    if (!message) return false;

    if (this.retryable(message) && this.retryGate?.(message) !== false && await this.prepareRetry(message)) return true;

    if (message.stopReason === "error" && this.retryAttempt > 0) {
      this.emit({ type: "auto_retry_end", success: false, attempt: this.retryAttempt, finalError: message.errorMessage });
      this.retryAttempt = 0;
    }

    return this.agent.hasQueuedMessages();
  }

  private retryable(message: AssistantMessage): boolean {
    if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;

    return isTransientModelError(message);
  }

  private async prepareRetry(message: AssistantMessage): Promise<boolean> {
    this.retryAttempt += 1;

    if (this.retryAttempt > this.retry.maxRetries) {
      this.retryAttempt -= 1;

      return false;
    }

    const delayMs = this.retry.baseDelayMs * 2 ** (this.retryAttempt - 1);
    this.emit({ type: "auto_retry_start", attempt: this.retryAttempt, maxAttempts: this.retry.maxRetries, delayMs, errorMessage: message.errorMessage || "Unknown error" });
    const messages = this.agent.state.messages;

    if (messages.length > 0 && messages.at(-1)?.role === "assistant") this.agent.state.messages = messages.slice(0, -1);
    this.retryAbort = new AbortController();

    try {
      await sleep(delayMs, this.retryAbort.signal);
    } catch {
      const attempt = this.retryAttempt;
      this.retryAttempt = 0;
      this.emit({ type: "auto_retry_end", success: false, attempt, finalError: "Retry cancelled" });

      return false;
    } finally {
      this.retryAbort = undefined;
    }

    return true;
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === "message_start" && event.message.role === "user") {
      const text = textOf(event.message);
      const steeringIndex = text ? this.steering.indexOf(text) : -1;

      if (steeringIndex !== -1) this.steering.splice(steeringIndex, 1);
      else if (text) {
        const followUpIndex = this.followUps.indexOf(text);

        if (followUpIndex !== -1) this.followUps.splice(followUpIndex, 1);
      }
    }

    // Pi 1.0 自己会往记录里加 system 消息（宣告工具变化）；提示词每次请求重拼，不存。
    if (event.type === "message_end" && event.message.role !== "system") this.options.persistence?.appendMessage(event.message);

    if(event.type === "agent_end" && this.options.persistence) {
      const end = {...event,willRetry:this.willRetry(event.messages)};
      void this.flushPersistence().then(() => this.emit(end)).catch(() => {});
    } else this.emit(event.type === "agent_end" ? { ...event, willRetry: this.willRetry(event.messages) } : event);

    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      this.lastAssistant = message;

      if (message.stopReason !== "error" && this.retryAttempt > 0) {
        this.emit({ type: "auto_retry_end", success: true, attempt: this.retryAttempt });
        this.retryAttempt = 0;
      }
    }

    if (event.type === "turn_end") this.flushCustom();
  }

  private willRetry(messages: AgentMessage[]): boolean {
    if (this.retryAttempt >= this.retry.maxRetries) return false;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;

      if (message.role === "assistant") return this.retryable(message) && this.retryGate?.(message) !== false;
    }

    return false;
  }

  private flushCustom(): void {
    for (const message of this.pendingCustom.splice(0)) this.appendCustom(message);
  }

  private appendCustom(message: CustomAppMessage): void {
    this.agent.state.messages.push(message);
    this.emit({ type: "message_start", message });
    this.emit({ type: "message_end", message });
  }

  /** context 钩子按 Pi 的规则接力改写消息；钩子只增删 custom 消息，不改动其他消息对象。 */
  /** pi-agent-core 对未知工具直接回 "Tool X not found"，不经 afterToolCall；这里在下一次模型调用前改写成可行动的说明。 */
  private explainUnknownTools(messages: AgentMessage[]): AgentMessage[] {
    return messages.map(message => {
      if (message.role !== "toolResult" || !message.isError || this.active.includes(message.toolName)) return message;

      const first = message.content[0];

      if (first?.type !== "text" || first.text !== `Tool ${message.toolName} not found`) return message;

      return { ...message, content: [{ type: "text", text: `工具 ${message.toolName} 不存在，没有执行。可用工具：${this.active.join("、")}。操作页面请用 browser_run。` }] };
    });
  }

  private async contextThroughHooks(messages: AgentMessage[]): Promise<AgentMessage[]> {
    // SAFETY: HookMessage 是 AgentMessage 的结构子集；钩子返回的仍是 Agent 消息（原对象或新的 custom 消息）。
    return [...await this.hooks.context(messages as readonly HookMessage[])] as AgentMessage[];
  }

  private observeRequest(context: Parameters<StreamFn>[1]): void {
    if (!this.options.onModelRequest) return;

    try {
      const system = context.messages.find(message => message.role === "system");

      this.options.onModelRequest({
        systemPrompt: this.systemPrompt,
        tools: (system?.role === "system" ? system.toolsAdded ?? [] : []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: this.definitions.get(tool.name)?.promptGuidelines })),
        messages: context.messages.filter(message => message.role !== "system"),
        injected: this.injected,
      });
    } catch { /* Diagnostics only. */ }
  }

  /** 每次请求开头的那条 system 消息：当前提示词加当前可用工具（与 0.84 每次请求带 systemPrompt、tools 一致）。 */
  private systemMessage(): Message {
    return { role: "system", timestamp: 0, content: this.systemPrompt, toolsAdded: this.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);

    // 同名事件交给扩展钩子（如 agent_settled）；钩子之间串行保持先后；循环的完成、空闲与中止不等钩子（慢钩子只拖后面的钩子投递）。
    if (OBSERVED_EVENTS.has(event.type)) this.hookChain = this.hookChain.then(() => this.hooks.notify(event));
  }
}

/** 工具参数已按工具的 TypeBox 参数表校验过，是普通 JSON 对象。 */
function hookArgs(args: Parameters<NonNullable<ConstructorParameters<typeof Agent>[0]["beforeToolCall"]>>[0]["args"]): HookArgs {
  // SAFETY: 见上；钩子只读取参数值做比较与序列化。
  return args as HookArgs;
}

function streamThrough(models: ModelPort, observe: (context: Parameters<StreamFn>[1]) => void, effort: ((model: Model<Api>) => ModelThinkingLevel) | undefined, firstEventTimeoutMs: number | undefined, onCut: (cut: () => boolean, live: boolean) => void): StreamFn {
  // SAFETY: ModelPort.streamSimple 与 Agent 期望的 streamFn 同签名；两边是同一 pi-ai 版本的类型。
  return ((model, context, streamOptions) => {
    observe(context);
    // 档位按每次调用取：同一轮里升档信号出现后，下一次调用就用新档。
    const level = effort?.(model);
    const leveled = level === undefined ? streamOptions : { ...streamOptions, reasoning: level === "off" ? undefined : level };

    // 浏览器的 WebSocket 不能带请求头，ChatGPT 登录的模型默认先试 WebSocket 必失败；直接用 SSE，免得每次会话留下假的传输故障。
    const options = model.api === "openai-codex-responses" ? { ...leveled, transport: "sse" as const } : leveled;

    // 服务端原始事件先告诉超时计时「已受理」，再转给调用方原有的钩子。
    const withAccepted = (accepted: () => void): StreamOptions["onProviderStreamEvent"] => async (event, eventModel) => {
      accepted();
      await options?.onProviderStreamEvent?.(event, eventModel);
    };

    // SAFETY: 同上，参数原样转交。
    return withFirstEventDeadline(model, options?.signal, firstEventTimeoutMs ?? firstEventTimeout(model) ?? MODEL_FIRST_EVENT_TIMEOUT_MS, (signal, accepted) => models.streamSimple(model as never, context as never, { ...options, signal, onProviderStreamEvent: withAccepted(accepted) } as never), onCut);
  }) as StreamFn;
}

/**
 * 第一个事件（start 只表示连上，不算）迟迟不来：取消这次请求，交出一条可重试的超时错误，写明是哪个模型。
 * 服务端一旦发出原始事件（已受理），剩余等待缩短到 MODEL_STALL_AFTER_START_MS：受理后迟迟不出内容就是挂住了。
 * 用户取消照常走原来的 aborted 结局。
 */
function withFirstEventDeadline(model: Model<Api>, outer: AbortSignal | undefined, timeoutMs: number, start: (signal: AbortSignal, onProviderStreamEvent: () => void) => AssistantMessageEventStream, onCut?: (cut: () => boolean, live: boolean) => void): AssistantMessageEventStream {
  const controller = new AbortController();
  const cancel = () => controller.abort();

  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", cancel, { once: true });

  // 同步抛出的错误（如缺 key）照旧交给 Agent 处理。
  let source: AssistantMessageEventStream;

  // 计时器在下面建立；服务端第一个原始事件到来时，若内容还没来，就改成受理后的短等待。
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let content = false;

  const arm = (ms: number, message: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fail(message);
      controller.abort();
    }, ms);
  };

  const onProviderStreamEvent = () => {
    if (started || content) return;
    started = true;
    arm(Math.min(timeoutMs, MODEL_STALL_AFTER_START_MS), `first response timeout: ${model.provider}/${model.id} accepted the request but sent nothing within ${Math.round(MODEL_STALL_AFTER_START_MS / 1000)} s`);
  };

  try { source = start(controller.signal, onProviderStreamEvent); } catch (error) {
    outer?.removeEventListener("abort", cancel);
    throw error;
  }

  const out = createAssistantMessageEventStream();

  const fail = (errorMessage: string) => {
    out.push({ type: "error", reason: "error", error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage, timestamp: Date.now(),
    } });
    out.end();
  };

  if (!started) arm(timeoutMs, `first response timeout: ${model.provider}/${model.id} sent nothing within ${Math.round(timeoutMs / 1000)} s`);

  // 用户改方向：正在写的正文按「写完了」收下（stopReason stop），旧请求取消、晚到的字丢弃；
  // 循环随即读排队的插话，同一轮里重写。已开始写工具调用、还没写出正文时不截断。
  let partial: AssistantMessage | null = null;
  let cut = false;
  const blanks = new Map<number, number>();

  const cutText = (): boolean => {
    if (cut || !partial || partial.content.some(part => part.type === "toolCall")
      || !partial.content.some(part => part.type === "text" && part.text.trim())) return false;
    cut = true;
    clearTimeout(timer);
    // 深拷贝：取消请求后供应商还会就地改它的流式对象，收下的这条消息不能跟着变。
    out.push({ type: "done", reason: "stop", message: { ...structuredClone(partial), stopReason: "stop" } });
    out.end();
    controller.abort();

    return true;
  };

  onCut?.(cutText, true);

  void (async () => {
    try {
      for await (const event of source) {
        if (cut) break;

        if (event.type !== "start") {
          content = true;
          clearTimeout(timer);
        }

        if ("partial" in event) partial = event.partial;

        if (event.type === "toolcall_delta") {
          const run = /^\s*$/.test(event.delta) ? (blanks.get(event.contentIndex) ?? 0) + event.delta.length : event.delta.length - event.delta.trimEnd().length;
          blanks.set(event.contentIndex, run);

          if (run >= RUNAWAY_TOOL_ARGS_BLANKS) {
            cut = true;
            fail(`runaway tool call: ${model.provider}/${model.id} kept writing blank tool arguments`);
            controller.abort();
            break;
          }
        }

        out.push(event);
      }
    } catch (error) {
      if (!cut) fail(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", cancel);
      onCut?.(cutText, false);
      out.end();
    }
  })();

  return out;
}

const customText = (content: CustomAppMessage["content"]): string => userContent(content).filter(isTextPart).map(part => part.text).join("");

/** 与 pi-coding-agent 的 wrapToolDefinition 相同（dist/core/tools/tool-definition-wrapper.js）。 */
function toAgentTool(definition: ToolDefinition): AgentTool {
  // SAFETY: 字段一一对应；我们的工具不读取第五个 ctx 参数。
  return {
    name: definition.name, label: definition.label, description: definition.description, parameters: definition.parameters,
    prepareArguments: definition.prepareArguments, executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) => definition.execute(toolCallId, params as never, signal, onUpdate as never, undefined as never),
  } as AgentTool;
}

/** 取自 Pi 0.84.4 的 convertToLlm：custom 消息转成 user 消息，模型消息原样保留，其余角色不送给模型。我们不产生 bashExecution 与摘要消息，所以不转换它们。 */
function legacyMessages(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role === "custom") return [{ role: "user", content: userContent(message.content), timestamp: message.timestamp }];

    return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : [];
  });
}
