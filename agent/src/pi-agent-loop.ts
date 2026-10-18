/**
 * AgentLoop 的浏览器实现：pi-agent-core 的 Agent 加上 session.ts 依赖的那部分 AgentSession 行为。
 *
 * pi-coding-agent 的 AgentSession 打进扩展要 7.8 MB 并拉入终端界面、undici、30 多个 Node 内置模块，所以这里
 * 按 0.84.4 源码（dist/core/agent-session.js）复刻 session.ts 实际用到的行为：
 * - prompt：input 钩子 → 运行中按 streamingBehavior 排队 → 组装用户消息与「下一轮」消息 →
 *   before_agent_start 钩子只对本轮替换系统提示词、给出本次运行的上下文（和用户消息一起留在历史里）→ 运行；
 * - 运行：每轮结束后可重试的错误按 2 次、0.5 秒起翻倍重试，再 continue；结束时写入暂存的自定义消息；
 * - sendCustomMessage 的五个分支、插话记账、agent_end 的 willRetry、auto_retry_start/end 事件；
 * - 切换工具时用 composeSystemPrompt 重建系统提示词；Pi 1.0 起每次请求开头拼一条 system 消息带上它和工具清单。
 * 会话消息和任务检查点可交给Pi原生Session；扩展提供持久存储。
 */
// Pi 1.0 删掉了 convertToLlm（custom 消息转 user）；沿用 0.84.4 的实现。
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { firstEventTimeout, hedgeAfter } from "../../shared/model-capabilities.js";
import { isTransientModelError } from "../../shared/provider-busy.js";
import { createAssistantMessageEventStream, isContextOverflow, type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type ImageContent, type Message, type Model, type ModelThinkingLevel, type StreamOptions, type TextContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, AgentSessionEventListener, CustomEntry, ExtensionFactory, PromptOptions, SessionEntry, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentLoop, ModelPort, ModelQueueOptions } from "./agent-loop.js";
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
  /** 模型调用的响应头到了（服务商适配层报告时才有）；只读，抛错被吞掉。 */
  onModelResponse?: (status: number) => void;
  /** 发出对冲请求、以及有对冲的调用结束时各报一次（诊断记录用）；只读，抛错被吞掉。 */
  onModelHedge?: (record: ModelHedgeRecord) => void;
  /** 每次模型调用前取这次的思考档（见 main-effort.ts）；"off" 表示不发思考参数。不给时沿用 Agent 的设置。 */
  effort?: (model: Model<Api>) => ModelThinkingLevel;
}

/** 宿主插入的消息：pi-coding-agent 已给 Agent 的消息联合加上 custom 角色（core/messages.d.ts）；convertToLlm 把它转成 user 消息。 */
type CustomAppMessage = Extract<AgentMessage, { role: "custom" }>;

/** 同名、同参数、同结果的工具调用连续到第几次时提醒模型换做法。 */
const REPEAT_NOTE_AT = 3;

/**
 * 只有这些只读工具的结果文字代表页面状态，结果不变才说明页面没变。scroll、click、fill、press_key、hover 等写操作
 * 每次回的是固定格式的回执、screenshot 的内容在图里，文字不随页面变化，计数会把正常操作误报成原地打转。
 */
const REPEAT_TRACKED_TOOLS: ReadonlySet<string> = new Set(["tabs", "snapshot", "read_element", "read_elements", "browser_run"]);

/** 读页结果或页面快照短于这个字数就不删：省下的不够，还丢了信息。 */
export const ELIDE_MIN_CHARS = 1000;

/** 用户消息里页面快照的开头（session.ts 的 freshPageObservationText）；超窗口时从这里删到消息末尾。 */
export const PAGE_OBSERVATION_MARK = "[FRESH PAGE OBSERVATION";

/** 本次运行上下文消息的开头：告诉模型这是数据，不是用户说的话；历史里每条消息前都有一段，只有最后一段是现状。 */
const RUN_CONTEXT_HEADER = "本次运行的上下文，不是用户消息，无需回应这段数据。之前消息前的同类段落只是历史，现状以这一段为准。";

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

/** 能力表没有登记 hedgeMs 的模型：发出后这么久还没有第一个事件（且未受理），就再发一份相同的请求。 */
export const MODEL_HEDGE_MS = 8_000;

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
  /** 这一轮从历史的第几条开始：超窗口时只删它之前的旧内容。 */
  private runStart = 0;
  /** 这一轮已经因超窗口删过一次：再超就照常报错。 */
  private elided = false;
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
  /** 本次任务里最近一串完全相同的工具调用（同名、同参数、同结果）有几次；新任务清零。 */
  private repeat = { call: "", result: "", count: 0 };

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
      streamFn: streamThrough(options.models, context => this.observeRequest(context), options.onModelResponse, options.effort, options.firstEventTimeoutMs, (cut, live) => { if (live) this.cutText = cut; else if (this.cutText === cut) this.cutText = null; }, options.onModelHedge),
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
        const repeated = this.noteRepeat(toolCall.name, args, result.content);
        const hookResult = this.hooks.has("tool_result") ? await this.hooks.toolResult({ toolName: toolCall.name, toolCallId: toolCall.id, input: hookArgs(args), content: result.content, details: result.details, isError }) : undefined;
        const content = hookResult?.content ? [...hookResult.content] : undefined;

        // 提醒放最后单独一段：侧栏的结果摘要和失败原因只读第一段，放前面会被当成工具的结果或失败原因显示。
        if (repeated) return { content: [...(content ?? result.content), { type: "text", text: repeated }], details: hookResult?.details, isError: hookResult?.isError };

        return hookResult ? { content, details: hookResult.details, isError: hookResult.isError } : undefined;
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

    const user: AgentMessage = { role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() };
    const next = this.pendingNextTurn;
    this.pendingNextTurn = [];

    const { systemPrompt, context } = this.hooks.has("before_agent_start") ? await this.hooks.beforeAgentStart(text, this.base) : { systemPrompt: this.base, context: [] };
    this.override = systemPrompt === this.base ? undefined : systemPrompt;
    this.systemPrompt = systemPrompt;
    // 上下文和用户消息一起写进历史、不再拿掉：下一条消息的请求是这一条的前缀延伸，整段历史都命中缓存（#271）。
    const runContext: CustomAppMessage[] = context.length ? [{ role: "custom", customType: "run-context", content: [RUN_CONTEXT_HEADER, ...context].join("\n\n"), display: false, timestamp: user.timestamp }] : [];
    this.runStart = this.agent.state.messages.length;
    this.elided = false;
    this.repeat = { call: "", result: "", count: 0 };
    await this.run([...runContext, user, ...next]);
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

  /**
   * 模型连续发同一个调用、拿到同一个结果时，它自己往往看不出在原地打转，会一直重复到任务超时。
   * 到第 REPEAT_NOTE_AT 次起在结果末尾写明；只加框架固定文字，不带页面内容，也不拦下执行。不计数的工具打断连续。
   */
  private noteRepeat(name: string, args: unknown, content: readonly (TextContent | ImageContent)[]): string | null {
    const call = `${name} ${stableJson(args)}`;
    const result = content.map(part => (part.type === "text" ? part.text : "")).join("\n").replace(/\s+/g, " ").trim();

    if (!REPEAT_TRACKED_TOOLS.has(name) || !result) {
      this.repeat = { call: "", result: "", count: 0 };

      return null;
    }

    const same = call === this.repeat.call && result === this.repeat.result;
    this.repeat = { call, result, count: same ? this.repeat.count + 1 : 1 };

    return this.repeat.count >= REPEAT_NOTE_AT ? `[框架说明] 这是连续第 ${this.repeat.count} 次同样的调用，结果没有变化。如果在等页面变化，先等待再读（例如 browser.sleep 或 wait_for）；否则请换一种做法。` : null;
  }

  private async afterRun(): Promise<boolean> {
    const message = this.lastAssistant;
    this.lastAssistant = undefined;

    if (!message) return false;

    if (this.willElide(message)) {
      this.elideEarlierContent();

      return true;
    }

    if (this.retryable(message) && this.retryGate?.(message) !== false && await this.prepareRetry(message)) return true;

    if (message.stopReason === "error" && this.retryAttempt > 0) {
      this.emit({ type: "auto_retry_end", success: false, attempt: this.retryAttempt, finalError: message.errorMessage });
      this.retryAttempt = 0;
    }

    return this.agent.hasQueuedMessages();
  }

  /**
   * 模型报超窗口错误、这一轮还没删过、而且之前有能删的内容：删完再请求一次。
   * 只看报错：pi-ai 把「成功回答但输入超过配置的窗口」也算超窗口，那条回答已经给了用户，不能删掉重问。
   */
  private willElide(message: AssistantMessage): boolean {
    return message.stopReason === "error" && !this.elided && isContextOverflow(message, this.model?.contextWindow ?? 0) && this.elidedEarlier() !== null;
  }

  /**
   * 超窗口时把这一轮之前的大段内容（读页结果、页面快照、运行上下文）各换成一行占位，去掉出错的回复，再请求一次。
   * 平时不删：删会改历史前缀、丢掉缓存（#271）。只改内存里的历史，会话记录不变。
   */
  private elideEarlierContent(): void {
    const earlier = this.elidedEarlier();

    if (!earlier) return;
    this.elided = true;
    this.emit({ type: "compaction_start", reason: "overflow" });
    // 出错的那条回复不留在历史里，重试的请求以删过的历史加这一轮的内容结尾。
    const current = this.agent.state.messages.slice(this.runStart);
    this.agent.state.messages = [...earlier, ...(current.at(-1)?.role === "assistant" ? current.slice(0, -1) : current)];
    this.emit({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true });
  }

  /** 这一轮之前的历史删掉大段内容后的样子；没有能删的就返回 null。 */
  private elidedEarlier(): AgentMessage[] | null {
    const messages = this.agent.state.messages;
    let elided = 0;
    const stub = (chars: number): TextContent => ({ type: "text", text: `[Earlier content elided to fit the context window: ${chars} chars. The page may have changed since; read it again if needed.]` });
    const earlier = messages.slice(0, this.runStart).map(message => {
      if (message.role === "toolResult") {
        const chars = message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : ELIDE_MIN_CHARS), 0);

        if (chars < ELIDE_MIN_CHARS) return message;
        elided += 1;

        return { ...message, content: [stub(chars)] };
      }

      if (message.role === "user" && Array.isArray(message.content)) {
        let changed = false;
        const content = message.content.flatMap(part => {
          if (part.type === "image") { changed = true;

            return [stub(ELIDE_MIN_CHARS)]; }
          const at = part.text.indexOf(PAGE_OBSERVATION_MARK);

          if (at < 0 || part.text.length - at < ELIDE_MIN_CHARS) return [part];
          changed = true;

          return [{ ...part, text: `${part.text.slice(0, at)}${stub(part.text.length - at).text}` }];
        });

        if (!changed) return message;
        elided += 1;

        return { ...message, content };
      }

      if (message.role === "custom" && message.customType === "run-context" && typeof message.content === "string" && message.content.length >= ELIDE_MIN_CHARS) {
        elided += 1;

        return { ...message, content: stub(message.content.length).text };
      }

      return message;
    });

    return elided ? earlier : null;
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
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;

      if (message.role === "assistant") return this.willElide(message) || (this.retryAttempt < this.retry.maxRetries && this.retryable(message) && this.retryGate?.(message) !== false);
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

/** 键按字母序排好的 JSON：模型换了参数顺序也算同一个调用。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;

  return JSON.stringify(value) ?? "null";
}

/** 工具参数已按工具的 TypeBox 参数表校验过，是普通 JSON 对象。 */
function hookArgs(args: Parameters<NonNullable<ConstructorParameters<typeof Agent>[0]["beforeToolCall"]>>[0]["args"]): HookArgs {
  // SAFETY: 见上；钩子只读取参数值做比较与序列化。
  return args as HookArgs;
}

export function streamThrough(models: ModelPort, observe: (context: Parameters<StreamFn>[1]) => void, observeResponse: ((status: number) => void) | undefined, effort: ((model: Model<Api>) => ModelThinkingLevel) | undefined, firstEventTimeoutMs: number | undefined, onCut: (cut: () => boolean, live: boolean) => void, onHedge: ((record: ModelHedgeRecord) => void) | undefined): StreamFn {
  // SAFETY: ModelPort.streamSimple 与 Agent 期望的 streamFn 同签名；两边是同一 pi-ai 版本的类型。
  return ((model, context, streamOptions) => {
    observe(context);
    // 档位按每次调用取：同一轮里升档信号出现后，下一次调用就用新档。
    const level = effort?.(model);
    const options = level === undefined ? streamOptions : { ...streamOptions, reasoning: level === "off" ? undefined : level };

    // 服务端原始事件先告诉超时计时「已受理」，再转给调用方原有的钩子。
    const withAccepted = (accepted: () => void): StreamOptions["onProviderStreamEvent"] => async (event, eventModel) => {
      accepted();
      await options?.onProviderStreamEvent?.(event, eventModel);
    };

    // 响应头的诊断只记原请求，sinceRequestMs 才对得上那条 model_request；对冲那份的结局记在 model_hedge_winner 里。
    const withResponse = (observed: boolean): StreamOptions["onResponse"] => async (response, responseModel) => {
      if (observed) try { observeResponse?.(response.status); } catch { /* Diagnostics only. */ }
      await options?.onResponse?.(response, responseModel);
    };

    // SAFETY: 同上，参数原样转交；对冲那份与原请求的 context 和参数完全相同。
    return withFirstEventDeadline(model, options?.signal, firstEventTimeoutMs ?? firstEventTimeout(model) ?? MODEL_FIRST_EVENT_TIMEOUT_MS, hedgeAfter(model) ?? MODEL_HEDGE_MS, (signal, accepted, hedge, onQueued) => models.streamSimple(model as never, context as never, { ...options, signal, onProviderStreamEvent: withAccepted(accepted), onResponse: withResponse(!hedge), ...(onQueued ? { onQueued } : {}) } as never), onCut, onHedge);
  }) as StreamFn;
}

/** 对冲请求的诊断记录：发出对冲时一条，这次调用结束时一条（哪份胜出、胜出时离发出原请求多久）。 */
export type ModelHedgeRecord =
  | { type: "model_hedge"; model: string; hedgeMs: number }
  | { type: "model_hedge_winner"; model: string; winner: "first" | "hedge" | "none"; firstEventMs: number | null; hedgeError?: string };

/**
 * 第一个事件（start 只表示连上，不算）迟迟不来：取消这次请求，交出一条可重试的超时错误，写明是哪个模型。
 * 服务端一旦发出原始事件（已受理），剩余等待缩短到 MODEL_STALL_AFTER_START_MS：受理后迟迟不出内容就是挂住了。
 * 到 hedgeMs 原请求既没有第一个事件、也没被受理，就再发一份相同的请求，原请求不取消（对冲请求，Dean & Barroso《The Tail at Scale》）：
 * 先出第一个事件的那份胜出，另一份立即取消、晚到的事件丢弃。整次调用在原请求的期限（上面两条）报超时错误；
 * 只有对冲那份已被受理（服务还活着）时，才放宽到它受理后再等 MODEL_STALL_AFTER_START_MS，取两者中较晚的；
 * 它随后出错被丢掉，就退回原请求的期限。原请求已受理时不对冲：受理后的短等待已经管住挂起，再发一份只会给长前缀、慢思考多付一份。
 * 供应商整段挂住时两份都不会被受理，用户等的时间和没有对冲时一样。
 * 某份在出第一个事件前就出错（并发上限、429 等），而另一份还在等：只丢掉出错的这份，不让整次调用失败。
 * 用户取消照常走原来的 aborted 结局。
 * 服务商有并发上限时原请求可能先在扩展里排队（见 ModelQueueOptions.onQueued）：两项计时都从它真正发出时算起，排队再久也不算挂起。
 */
function withFirstEventDeadline(model: Model<Api>, outer: AbortSignal | undefined, timeoutMs: number, hedgeMs: number, start: (signal: AbortSignal, onProviderStreamEvent: () => void, hedge: boolean, onQueued?: ModelQueueOptions["onQueued"]) => AssistantMessageEventStream, onCut?: (cut: () => boolean, live: boolean) => void, onHedge?: (record: ModelHedgeRecord) => void): AssistantMessageEventStream {
  /** live：还在等它出第一个事件；超时、出错、输给另一份或流结束后为 false。held：胜出前收到的 start 事件，胜出时补发。 */
  type Attempt = { controller: AbortController; started: boolean; live: boolean; hedge: boolean; held: AssistantMessageEvent[] };

  const name = `${model.provider}/${model.id}`;
  let sentAt = Date.now();
  const attempts: Attempt[] = [];
  const out = createAssistantMessageEventStream();
  let winner: Attempt | null = null;
  let wonAt: number | null = null;
  let hedgeError: string | undefined;
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const acceptedMessage = `first response timeout: ${name} accepted the request but sent nothing within ${Math.round(MODEL_STALL_AFTER_START_MS / 1000)} s`;
  /** 原请求的期限；原请求被受理后缩短。 */
  let deadline = { at: sentAt + timeoutMs, message: `first response timeout: ${name} sent nothing within ${Math.round(timeoutMs / 1000)} s` };
  /** 对冲那份被受理后的期限；没被受理为 null。 */
  let hedgeDeadline: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 已交出结局（超时错误或截断），之后两份的事件都丢弃。 */
  let closed = false;
  let finished = false;
  let partial: AssistantMessage | null = null;
  const blanks = new Map<number, number>();

  const cancel = () => { for (const attempt of attempts) attempt.controller.abort(); };

  if (!outer?.aborted) outer?.addEventListener("abort", cancel, { once: true });

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(hedgeTimer);
    clearTimeout(timer);
    outer?.removeEventListener("abort", cancel);
    onCut?.(cutText, false);
    out.end();

    if (attempts.length > 1) {
      try {
        onHedge?.({ type: "model_hedge_winner", model: name, winner: winner ? (winner.hedge ? "hedge" : "first") : "none", firstEventMs: wonAt === null ? null : wonAt - sentAt, ...(hedgeError === undefined ? {} : { hedgeError }) });
      } catch { /* Diagnostics only. */ }
    }
  };

  const fail = (errorMessage: string) => {
    if (closed) return;
    closed = true;
    out.push({ type: "error", reason: "error", error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage, timestamp: Date.now(),
    } });
    cancel();
    finish();
  };

  const othersLive = (attempt: Attempt) => attempts.some(other => other !== attempt && other.live);

  const drop = (attempt: Attempt) => {
    attempt.live = false;
    attempt.controller.abort();
  };

  const arm = () => {
    const { at, message } = hedgeDeadline !== null && hedgeDeadline > deadline.at ? { at: hedgeDeadline, message: acceptedMessage } : deadline;
    clearTimeout(timer);
    timer = setTimeout(() => fail(message), Math.max(0, at - Date.now()));
  };

  const win = (attempt: Attempt) => {
    winner = attempt;
    wonAt = Date.now();
    clearTimeout(hedgeTimer);
    clearTimeout(timer);

    for (const other of attempts) if (other !== attempt) drop(other);
  };

  const launch = (hedge: boolean, onQueued?: ModelQueueOptions["onQueued"]) => {
    const attempt: Attempt = { controller: new AbortController(), started: false, live: true, hedge, held: [] };

    if (outer?.aborted) attempt.controller.abort();
    attempts.push(attempt);

    // 服务端第一个原始事件到来时，若内容还没来：原请求改成受理后的短等待，对冲那份把期限放宽到受理后的短等待。
    const accepted = () => {
      if (attempt.started || winner || closed) return;
      attempt.started = true;

      if (hedge) hedgeDeadline = Date.now() + MODEL_STALL_AFTER_START_MS;
      else deadline = { at: Date.now() + Math.min(timeoutMs, MODEL_STALL_AFTER_START_MS), message: acceptedMessage };
      arm();
    };

    let source: AssistantMessageEventStream;

    try { source = start(attempt.controller.signal, accepted, hedge, onQueued); } catch (error) {
      attempt.live = false;

      // 原请求同步抛出的错误（如缺 key）照旧交给 Agent 处理；对冲那份只丢掉。
      if (!hedge) {
        clearTimeout(timer);
        outer?.removeEventListener("abort", cancel);
        throw error;
      }

      hedgeError = errorText(error);

      return;
    }

    void consume(attempt, source);
  };

  // 用户改方向：正在写的正文按「写完了」收下（stopReason stop），旧请求取消、晚到的字丢弃；
  // 循环随即读排队的插话，同一轮里重写。还没写出正文和工具调用时（多半在思考），丢掉整条，收下空回复：
  // 否则要等它按旧方向写完、旧步骤被挡下才轮到插话，多等 3–5 秒（#285）。没写完的思考不留，供应商不认残缺的思考。
  // 已开始写工具调用时不截断。
  const cutText = (): boolean => {
    if (closed || partial?.content.some(part => part.type === "toolCall")) return false;
    const written = !!partial?.content.some(part => part.type === "text" && part.text.trim());
    closed = true;
    // 深拷贝：取消请求后供应商还会就地改它的流式对象，收下的这条消息不能跟着变。
    const message: AssistantMessage = written ? { ...structuredClone(partial!), stopReason: "stop" } : {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: partial ? structuredClone(partial.usage) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    out.push({ type: "done", reason: "stop", message });
    cancel();
    finish();

    return true;
  };

  const consume = async (attempt: Attempt, source: AssistantMessageEventStream) => {
    try {
      for await (const event of source) {
        if (closed || (winner !== attempt && !attempt.live)) break;

        if (winner !== attempt) {
          if (event.type === "start") {
            attempt.held.push(event);
            continue;
          }

          if (event.type === "error" && othersLive(attempt)) {
            if (attempt.hedge) hedgeError = event.error.errorMessage;
            drop(attempt);
            break;
          }

          win(attempt);

          for (const held of attempt.held.splice(0)) out.push(held);
        }

        if ("partial" in event) partial = event.partial;

        if (event.type === "toolcall_delta") {
          const run = /^\s*$/.test(event.delta) ? (blanks.get(event.contentIndex) ?? 0) + event.delta.length : event.delta.length - event.delta.trimEnd().length;
          blanks.set(event.contentIndex, run);

          if (run >= RUNAWAY_TOOL_ARGS_BLANKS) {
            fail(`runaway tool call: ${name} kept writing blank tool arguments`);
            break;
          }
        }

        out.push(event);
      }
    } catch (error) {
      if (winner === attempt || (!winner && !othersLive(attempt))) fail(errorText(error));
      else if (attempt.hedge && attempt.live) hedgeError = errorText(error);
    } finally {
      // 已受理的对冲那份没胜出就结束了：它不再证明服务活着，放弃时间退回原请求的期限。
      if (attempt.hedge && !winner && hedgeDeadline !== null && !closed) {
        hedgeDeadline = null;
        arm();
      }

      if (winner === attempt) finish();
      else if (attempt.live) {
        attempt.live = false;

        // 流没出内容就结束、又没有别的份在等：照原来那样收尾。
        if (!winner && !othersLive(attempt)) {
          for (const held of attempt.held.splice(0)) out.push(held);
          finish();
        }
      }
    }
  };

  const begin = () => {
    if (closed || finished) return;
    sentAt = Date.now();
    deadline = { at: sentAt + timeoutMs, message: deadline.message };
    arm();

    hedgeTimer = hedgeMs > 0 ? setTimeout(() => {
      if (winner || closed || outer?.aborted || !attempts[0]!.live || attempts[0]!.started) return;

      try { onHedge?.({ type: "model_hedge", model: name, hedgeMs }); } catch { /* Diagnostics only. */ }
      launch(true);
    }, hedgeMs) : undefined;
  };

  const queue: { sent?: Promise<void> } = {};
  launch(false, sent => { queue.sent = sent; });
  onCut?.(cutText, true);

  if (queue.sent) void queue.sent.then(begin);
  else begin();

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
