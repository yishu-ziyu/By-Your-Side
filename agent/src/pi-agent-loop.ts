/**
 * AgentLoop 的浏览器实现：pi-agent-core 的 Agent 加上 session.ts 依赖的那部分 AgentSession 行为。
 *
 * pi-coding-agent 的 AgentSession 打进扩展要 7.8 MB 并拉入终端界面、undici、30 多个 Node 内置模块，所以这里
 * 按 0.84.4 源码（dist/core/agent-session.js）复刻 session.ts 实际用到的行为：
 * - prompt：input 钩子 → 运行中按 streamingBehavior 排队 → 组装用户消息与「下一轮」消息 →
 *   before_agent_start 钩子只对本轮替换系统提示词 → 运行；
 * - 运行：每轮结束后可重试的错误按 3 次、2 秒起翻倍重试，再 continue；结束时写入暂存的自定义消息；
 * - sendCustomMessage 的五个分支、插话记账、agent_end 的 willRetry、auto_retry_start/end 事件；
 * - 切换工具时用 composeSystemPrompt 重建系统提示词（与 Pi 逐字一致，见 system-prompt.test.ts）。
 * 不做：上下文压缩、扩展命令、提示词模板、技能命令（我们都没用）。
 */
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRetryableAssistantError, type Api, type AssistantMessage, type ImageContent, type Model, type TextContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, AgentSessionEventListener, CustomEntry, ExtensionFactory, PromptOptions, SessionEntry, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentLoop, ModelPort } from "./agent-loop.js";
import { ExtensionHost, type HookArgs, type HookMessage } from "./extension-host.js";
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
  retry?: { maxRetries: number; baseDelayMs: number };
  onHookError?: (event: string, message: string) => void;
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
  readonly sessionManager = new MemoryEntries();
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
  private retryAbort: AbortController | undefined;
  private runActive = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: PiAgentLoopOptions) {
    // 1、2、4 秒三次重试：服务真坏了约 7 秒就告诉用户，而不是让人干等半分钟。
    this.retry = options.retry ?? { maxRetries: 3, baseDelayMs: 1000 };
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
      initialState: { model: options.model, systemPrompt: "", tools: [], messages: [] },
      streamFn: streamThrough(options.models),
      // 与 Pi 的 convertToLlm 相同；我们不产生 bash、分支摘要、压缩摘要消息，遇到就丢弃。
      convertToLlm: messages => messages.flatMap(message => {
        if (message.role === "custom") return [{ role: "user" as const, content: userContent(message.content), timestamp: message.timestamp }];

        return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : [];
      }),
      transformContext: async messages => (this.hooks.has("context") ? this.contextThroughHooks(messages) : messages),
      beforeToolCall: async ({ toolCall, args }) => (this.hooks.has("tool_call") ? this.hooks.toolCall(toolCall.name, toolCall.id, hookArgs(args)) : undefined),
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

  async prompt(text: string, options?: PromptOptions): Promise<void> {
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

  private async run(messages: AgentMessage[]): Promise<void> {
    this.runActive = true;

    try {
      await this.agent.prompt(messages);

      while (await this.afterRun()) await this.agent.continue();
    } finally {
      this.override = undefined;
      this.flushCustom();
      this.runActive = false;
      this.emit({ type: "agent_settled" });

      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private async afterRun(): Promise<boolean> {
    const message = this.lastAssistant;
    this.lastAssistant = undefined;

    if (!message) return false;

    if (this.retryable(message) && await this.prepareRetry(message)) return true;

    if (message.stopReason === "error" && this.retryAttempt > 0) {
      this.emit({ type: "auto_retry_end", success: false, attempt: this.retryAttempt, finalError: message.errorMessage });
      this.retryAttempt = 0;
    }

    return this.agent.hasQueuedMessages();
  }

  private retryable(message: AssistantMessage): boolean {
    if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;

    return isRetryableAssistantError(message);
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

    this.emit(event.type === "agent_end" ? { ...event, willRetry: this.willRetry(event.messages) } : event);

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

      if (message.role === "assistant") return this.retryable(message);
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

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** 工具参数已按工具的 TypeBox 参数表校验过，是普通 JSON 对象。 */
function hookArgs(args: Parameters<NonNullable<ConstructorParameters<typeof Agent>[0]["beforeToolCall"]>>[0]["args"]): HookArgs {
  // SAFETY: 见上；钩子只读取参数值做比较与序列化。
  return args as HookArgs;
}

function streamThrough(models: ModelPort): StreamFn {
  // SAFETY: ModelPort.streamSimple 与 Agent 期望的 streamFn 同签名；两边是同一 pi-ai 版本的类型。
  return ((model, context, streamOptions) => models.streamSimple(model as never, context as never, streamOptions as never)) as StreamFn;
}

/** 与 pi-coding-agent 的 wrapToolDefinition 相同（dist/core/tools/tool-definition-wrapper.js）。 */
function toAgentTool(definition: ToolDefinition): AgentTool {
  // SAFETY: 字段一一对应；我们的工具不读取第五个 ctx 参数。
  return {
    name: definition.name, label: definition.label, description: definition.description, parameters: definition.parameters,
    prepareArguments: definition.prepareArguments, executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) => definition.execute(toolCallId, params as never, signal, onUpdate as never, undefined as never),
  } as AgentTool;
}
