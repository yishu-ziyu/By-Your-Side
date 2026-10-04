/**
 * AgentLoop 的浏览器实现：pi-agent-core 的 Agent 加上 session.ts 依赖的那部分 AgentSession 行为。
 *
 * pi-coding-agent 的 AgentSession 打进扩展要 7.8 MB 并拉入终端界面、undici、30 多个 Node 内置模块，所以这里
 * 按 0.84.4 源码（dist/core/agent-session.js）复刻 session.ts 实际用到的行为：
 * - prompt：input 钩子 → 运行中按 streamingBehavior 排队 → 组装用户消息与「下一轮」消息 →
 *   before_agent_start 钩子只对本轮替换系统提示词 → 运行；
 * - 运行：每轮结束后可重试的错误按 2 次、0.5 秒起翻倍重试，再 continue；结束时写入暂存的自定义消息；
 * - sendCustomMessage 的五个分支、插话记账、agent_end 的 willRetry、auto_retry_start/end 事件；
 * - 切换工具时用 composeSystemPrompt 重建系统提示词（与 Pi 逐字一致，见 system-prompt.test.ts）。
 * 会话消息和任务检查点可交给Pi原生Session；扩展提供持久存储。
 */
import { Agent, convertToLlm, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { isProviderBusyError } from "../../shared/provider-busy.js";
import { createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError, type Api, type AssistantMessage, type AssistantMessageEventStream, type ImageContent, type Model, type ModelThinkingLevel, type TextContent } from "@earendil-works/pi-ai";
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
  /** 模型多久不出第一个事件就取消这次调用、按可重试错误处理；默认 MODEL_FIRST_EVENT_TIMEOUT_MS。 */
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
      streamFn: streamThrough(options.models, context => this.observeRequest(context), options.effort, options.firstEventTimeoutMs ?? MODEL_FIRST_EVENT_TIMEOUT_MS),
      // Pi原生转换保留自定义消息、压缩摘要与分支摘要。
      convertToLlm: messages => {
        this.injected = messages.flatMap(message => (message.role === "custom" ? [{ customType: message.customType, text: customText(message.content) }] : []));

        return convertToLlm(messages);
      },
      transformContext: async messages => (this.hooks.has("context") ? this.contextThroughHooks(messages) : messages),
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
    this.agent.state.systemPrompt = this.override ?? this.base;
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
    this.agent.state.systemPrompt = systemPrompt;
    await this.run(messages);
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    this.queue("steer", text, images);
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

    return isRetryableAssistantError(message) || (message.stopReason === "error" && isProviderBusyError(message.errorMessage));
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

    if (event.type === "message_end") this.options.persistence?.appendMessage(event.message);

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
  private async contextThroughHooks(messages: AgentMessage[]): Promise<AgentMessage[]> {
    // SAFETY: HookMessage 是 AgentMessage 的结构子集；钩子返回的仍是 Agent 消息（原对象或新的 custom 消息）。
    return [...await this.hooks.context(messages as readonly HookMessage[])] as AgentMessage[];
  }

  private observeRequest(context: Parameters<StreamFn>[1]): void {
    if (!this.options.onModelRequest) return;

    try {
      this.options.onModelRequest({
        systemPrompt: context.systemPrompt ?? "",
        tools: (context.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: this.definitions.get(tool.name)?.promptGuidelines })),
        messages: context.messages,
        injected: this.injected,
      });
    } catch { /* Diagnostics only. */ }
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

function streamThrough(models: ModelPort, observe: (context: Parameters<StreamFn>[1]) => void, effort: ((model: Model<Api>) => ModelThinkingLevel) | undefined, firstEventTimeoutMs: number): StreamFn {
  // SAFETY: ModelPort.streamSimple 与 Agent 期望的 streamFn 同签名；两边是同一 pi-ai 版本的类型。
  return ((model, context, streamOptions) => {
    observe(context);
    // 档位按每次调用取：同一轮里升档信号出现后，下一次调用就用新档。
    const level = effort?.(model);
    const options = level === undefined ? streamOptions : { ...streamOptions, reasoning: level === "off" ? undefined : level };

    // SAFETY: 同上，参数原样转交。
    return withFirstEventDeadline(model, options?.signal, firstEventTimeoutMs, signal => models.streamSimple(model as never, context as never, { ...options, signal } as never));
  }) as StreamFn;
}

/**
 * 第一个事件（start 只表示连上，不算）迟迟不来：取消这次请求，交出一条可重试的超时错误，写明是哪个模型。
 * 用户取消照常走原来的 aborted 结局。
 */
function withFirstEventDeadline(model: Model<Api>, outer: AbortSignal | undefined, timeoutMs: number, start: (signal: AbortSignal) => AssistantMessageEventStream): AssistantMessageEventStream {
  const controller = new AbortController();
  const cancel = () => controller.abort();

  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", cancel, { once: true });

  // 同步抛出的错误（如缺 key）照旧交给 Agent 处理。
  let source: AssistantMessageEventStream;

  try { source = start(controller.signal); } catch (error) {
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

  const timer = setTimeout(() => {
    fail(`first response timeout: ${model.provider}/${model.id} sent nothing within ${Math.round(timeoutMs / 1000)} s`);
    controller.abort();
  }, timeoutMs);

  void (async () => {
    try {
      for await (const event of source) {
        if (event.type !== "start") clearTimeout(timer);
        out.push(event);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", cancel);
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
