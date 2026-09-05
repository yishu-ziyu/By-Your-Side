/**
 * Pi SDK 会话的创建与包装：
 * - ModelRuntime → createAgentSession（禁用内置工具，仅注册 16 个浏览器工具）
 * - subscribe SDK 事件并映射为协议 AgentUiEvent 吐出
 * - sendUserMessage / steer / abort 均异步不阻塞调用方，错误转成 error 事件
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentToolResult,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMode, AgentRunState, AgentUiEvent, ModelOption, PageContext } from "../../shared/protocol.js";
import { SessionHold, handbackContinueText } from "../../shared/control.js";
import { registerCliproxyProvider } from "./cliproxy.js";
import { SYSTEM_PROMPT, appendPromptForMode } from "./prompt.js";
import { getMode, setMode as setModeRef } from "./mode.js";
import { createBrowserTools } from "./tools.js";
import type { ToolRpc } from "./rpc.js";

export interface SessionAcceptanceContinuityEvidence {
  instanceId: string;
  taskId: string;
  step: "before" | "continued";
  active: boolean;
  expectedSnapshotMarker: string;
  resumedTabId?: number;
  snapshotMarkerFound?: boolean;
  preTaskPrompted: boolean;
  preTaskAgentStarted: boolean;
  contextTaskFound: boolean;
  resumeRequested: boolean;
  resumeAgentStarted: boolean;
  resumeSnapshotToolCalled: boolean;
  resumeSnapshotMarkerFound: boolean;
  resumeContinuationMarkerFound: boolean;
}

/** @deprecated 旧的纯状态测试夹具；生产验收不再调用，续跑必须经过底层 AgentSession。 */
export class AcceptanceContinuity {
  private task: Omit<SessionAcceptanceContinuityEvidence, "preTaskPrompted" | "preTaskAgentStarted" | "contextTaskFound" | "resumeRequested" | "resumeAgentStarted" | "resumeSnapshotToolCalled" | "resumeSnapshotMarkerFound" | "resumeContinuationMarkerFound"> | null = null;

  constructor(private readonly instanceId: string) {}

  seed(taskId: string, expectedSnapshotMarker: string) {
    this.task = { instanceId: this.instanceId, taskId, step: "before", active: true, expectedSnapshotMarker };
    return { ...this.task };
  }

  continue(context: PageContext, snapshot: string) {
    if (!this.task) return null;
    this.task.resumedTabId = context.tabId;
    this.task.snapshotMarkerFound = snapshot.includes(this.task.expectedSnapshotMarker);
    if (this.task.snapshotMarkerFound) this.task.step = "continued";
    return { ...this.task };
  }
}

export interface SessionCreateOptions {
  modelPattern?: string;
  /** 复用 Lead 的 runtime，工人不再 create/注册 cliproxy。 */
  modelRuntime?: ModelRuntime;
  customTools?: ToolDefinition[];
  systemPrompt?: string;
  appendPrompt?: (base: string[]) => string[];
}

const RESULT_TEXT_MAX = 500;

const SETUP_GUIDANCE =
  "Agent 会话不可用：未找到可用的模型凭据。请运行 `npx @earendil-works/pi-coding-agent` 并执行 /login 完成登录，" +
  "或设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量后重启伴随进程。";

export interface SessionCallbacks {
  /** 映射后的 UI 事件（对应 WS agent_event 帧的 event 负载）。 */
  emit(event: AgentUiEvent): void;
  /** 运行状态变化（对应 WS status 帧）。idle / running / user（现在归你）。 */
  setStatus(state: AgentRunState): void;
}

export class BrowserAgentSession {
  private constructor(
    private readonly session: AgentSession | null,
    private readonly initError: string | null,
    private readonly callbacks: SessionCallbacks,
    private readonly resourceLoader: DefaultResourceLoader | null,
    private readonly modelRuntime: ModelRuntime | null,
  ) {}

  private readonly hold = new SessionHold();
  private readonly instanceId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private acceptanceTrace: SessionAcceptanceContinuityEvidence | null = null;
  private controlEpoch = 0;
  private pendingStop: Promise<void> | null = null;
  private pendingHandback: { epoch: number; promise: Promise<boolean>; resolve: (started: boolean) => void } | null = null;
  private handbackPromptEpoch: number | null = null;
  /** 用户主动停止的那一轮仍会收到 agent_end；只吞掉这一轮的 abort/空响应尾声。 */
  private expectedStoppedAgentEnd = false;

  isHeld(): boolean {
    return this.hold.isHeld();
  }

  get runtime(): ModelRuntime | null {
    return this.modelRuntime;
  }

  static async create(
    rpc: ToolRpc,
    callbacks: SessionCallbacks,
    options?: SessionCreateOptions,
  ): Promise<BrowserAgentSession> {
    try {
      let modelRuntime = options?.modelRuntime ?? null;
      if (!modelRuntime) {
        modelRuntime = await ModelRuntime.create();
        // 本地 CLIProxyAPI 池：key 运行时从 client.env 读取，端口不通时自动跳过，不影响启动
        await registerCliproxyProvider(modelRuntime);
      }
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
      const systemPrompt = options?.systemPrompt ?? SYSTEM_PROMPT;
      const appendPrompt = options?.appendPrompt ?? ((base: string[]) => appendPromptForMode(getMode(), base));
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        settingsManager,
        noExtensions: true,
        systemPromptOverride: () => systemPrompt,
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        // 闭包读 mode ref；注意 SDK 只在 reload() 时求值并缓存（见 setMode 注释）
        appendSystemPromptOverride: (base) => appendPrompt(base),
      });
      await resourceLoader.reload();
      const createOptions: CreateAgentSessionOptions = {
        modelRuntime,
        noTools: "builtin",
        customTools: options?.customTools ?? createBrowserTools(rpc),
        resourceLoader,
        sessionManager: SessionManager.inMemory(process.cwd()),
        settingsManager,
      };
      if (options?.modelPattern) {
        const slash = options.modelPattern.indexOf("/");
        const resolved = resolveCliModel({
          cliProvider: slash > 0 ? options.modelPattern.slice(0, slash) : undefined,
          cliModel: slash > 0 ? options.modelPattern.slice(slash + 1) : options.modelPattern,
          modelRuntime,
        });
        if (resolved.error || !resolved.model) {
          throw new Error(resolved.error ?? `模型不可用：${options.modelPattern}`);
        }
        if (resolved.warning) console.error(`[sideagent] ${resolved.warning}`);
        createOptions.model = resolved.model;
        if (resolved.thinkingLevel) createOptions.thinkingLevel = resolved.thinkingLevel;
      }
      const { session } = await createAgentSession(createOptions);
      const wrapper = new BrowserAgentSession(session, null, callbacks, resourceLoader, modelRuntime);
      wrapper.subscribeEvents();
      return wrapper;
    } catch (err) {
      return new BrowserAgentSession(null, err instanceof Error ? err.message : String(err), callbacks, null, null);
    }
  }

  get available(): boolean {
    return this.session !== null && this.session.model !== undefined;
  }

  modelName(): string | undefined {
    const model = this.session?.model;
    return model ? `${model.provider}/${model.id}` : undefined;
  }

  /** 已配置凭据的 provider 下的可选模型（SDK ModelRuntime.getAvailable，含 OAuth 自动刷新）。 */
  async availableModels(): Promise<ModelOption[]> {
    if (!this.modelRuntime) return [];
    try {
      const models = await this.modelRuntime.getAvailable();
      return models.map((m) => ({
        id: `${m.provider}/${m.id}`,
        provider: m.provider,
        modelId: m.id,
        name: m.name,
      }));
    } catch (err) {
      console.error(`[sideagent] 枚举可用模型失败：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 切换会话模型（"provider/id" 格式）。SDK 0.84.4 的 AgentSession.setModel 支持
   * 热切换（不重建会话，校验凭据后换 model 引用），失败抛错由调用方转成 error 事件。
   */
  async setModel(modelId: string): Promise<void> {
    if (!this.session || !this.modelRuntime) {
      throw new Error("会话不可用（模型凭据未配置），无法切换模型");
    }
    const slash = modelId.indexOf("/");
    if (slash <= 0 || slash === modelId.length - 1) {
      throw new Error(`模型标识无效：${modelId}（需要 provider/id 格式）`);
    }
    const model = this.modelRuntime.getModel(modelId.slice(0, slash), modelId.slice(slash + 1));
    if (!model) {
      throw new Error(`模型不存在或未配置凭据：${modelId}`);
    }
    await this.session.setModel(model);
  }

  isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  /** 空闲时发起新任务；运行中自动转为插话。异步不阻塞，错误捕获为 error 事件。 */
  sendUserMessage(text: string, context?: PageContext): void {
    if (this.hold.isHeld()) {
      this.callbacks.emit({ kind: "notice", message: "现在页面归你。要让 Agent 继续，请交还。" });
      return;
    }
    const session = this.session;
    if (!session) {
      this.callbacks.emit({ kind: "error", message: this.guidanceMessage() });
      return;
    }
    if (!session.model) {
      this.callbacks.emit({ kind: "error", message: SETUP_GUIDANCE });
      return;
    }
    const finalText = withPageContext(text, context);
    if (session.isStreaming) {
      this.callbacks.emit({ kind: "notice", message: "运行中，已转为插话" });
      void session.steer(finalText).catch((err: unknown) => this.emitError(err));
      return;
    }
    void session.prompt(finalText).catch((err: unknown) => this.emitError(err));
  }

  /** 运行中插话；若空闲则按普通消息处理。与 prompt 一样带上当前页锚点，避免打断后丢工作标签。 */
  steer(text: string, context?: PageContext): void {
    if (this.hold.isHeld()) {
      this.callbacks.emit({ kind: "notice", message: "现在页面归你。要让 Agent 继续，请交还。" });
      return;
    }
    const session = this.session;
    if (!session) {
      this.callbacks.emit({ kind: "error", message: this.guidanceMessage() });
      return;
    }
    if (session.isStreaming) {
      const finalText = withPageContext(text, context);
      void session.steer(finalText).catch((err: unknown) => this.emitError(err));
    } else {
      this.sendUserMessage(text, context);
    }
  }

  abort(): void {
    this.controlEpoch += 1;
    this.cancelPendingHandback();
    this.hold.abort();
    this.acceptanceTrace = null;
    void this.stopCurrentRun().catch(() => {});
  }

  /**
   * 用户拿回页面：停当前生成，但会话、对话、工作标签都还在。
   * 不把 status 打成 idle（那是中止）。
   */
  holdForUser(opts?: { abortStream?: boolean }): AgentRunState {
    this.controlEpoch += 1;
    this.cancelPendingHandback();
    const state = this.hold.holdForUser();
    if (opts?.abortStream ?? true) void this.stopCurrentRun().catch(() => {});
    return state;
  }

  /**
   * 交还：同一会话继续，带上用户当前页的 snapshot。不是新开一轮任务。
   */
  continueAfterHandback(context: PageContext, snapshot: string): Promise<boolean> {
    if (!this.hold.isHeld()) {
      this.callbacks.emit({ kind: "notice", message: "现在不是你在操作页面，不用交还。" });
      return Promise.resolve(false);
    }
    const text = handbackContinueText(context, snapshot);
    const session = this.session;
    if (!session || !session.model) {
      this.callbacks.emit({ kind: "error", message: this.guidanceMessage() });
      return Promise.resolve(false);
    }
    if (this.pendingHandback) {
      this.callbacks.emit({ kind: "notice", message: "正在恢复原任务，请稍候。" });
      return Promise.resolve(false);
    }
    if (this.acceptanceTrace) {
      this.acceptanceTrace.resumeRequested = true;
      this.acceptanceTrace.resumedTabId = context.tabId;
      this.acceptanceTrace.snapshotMarkerFound = snapshot.includes(this.acceptanceTrace.expectedSnapshotMarker);
    }
    const epoch = ++this.controlEpoch;
    let resolveStarted!: (started: boolean) => void;
    const started = new Promise<boolean>((resolve) => {
      resolveStarted = resolve;
    });
    this.pendingHandback = { epoch, promise: started, resolve: resolveStarted };
    const finalText = withPageContext(text, context);
    void this.promptHandbackAfterStop(epoch, finalText);
    return started;
  }

  async beginAcceptanceTask(taskId: string, expectedSnapshotMarker: string): Promise<SessionAcceptanceContinuityEvidence> {
    const session = this.session;
    if (!session?.model) throw new Error("验收会话不可用");
    await session.agent.waitForIdle();
    this.acceptanceTrace = {
      instanceId: this.instanceId,
      taskId,
      step: "before",
      active: false,
      expectedSnapshotMarker,
      preTaskPrompted: true,
      preTaskAgentStarted: false,
      contextTaskFound: false,
      resumeRequested: false,
      resumeAgentStarted: false,
      resumeSnapshotToolCalled: false,
      resumeSnapshotMarkerFound: false,
      resumeContinuationMarkerFound: false,
    };
    void session
      .prompt(
        [
          "[SIDEAGENT ACCEPTANCE ORIGINAL TASK]",
          `SIDEAGENT_ACCEPTANCE_TASK:${taskId}`,
          "Keep this original task active until the user takes over. Resume it only after handback.",
        ].join("\n"),
      )
      .catch((err: unknown) => this.emitError(err));
    await this.waitForAcceptance((trace) => trace.preTaskAgentStarted && trace.contextTaskFound && trace.active);
    return this.acceptanceContinuityEvidence()!;
  }

  acceptanceContinuityEvidence(): SessionAcceptanceContinuityEvidence | null {
    if (!this.acceptanceTrace) return null;
    this.acceptanceTrace.contextTaskFound = this.acceptanceContextContainsTask();
    return { ...this.acceptanceTrace };
  }

  async waitForAcceptanceResume(timeoutMs = 15_000): Promise<SessionAcceptanceContinuityEvidence | null> {
    if (!this.acceptanceTrace) return null;
    await this.waitForAcceptance(
      (trace) =>
        trace.step === "continued" &&
        trace.resumeAgentStarted &&
        trace.resumeSnapshotToolCalled &&
        trace.resumeSnapshotMarkerFound &&
        trace.resumeContinuationMarkerFound &&
        trace.contextTaskFound,
      timeoutMs,
    );
    return this.acceptanceContinuityEvidence();
  }

  /**
   * 页面事件通知（扩展侦到 working tab URL 变化）：仅 teach 模式注入会话，
   * 走现有 steer/prompt 通道（运行中插话、空闲则发起新一轮），不发明新协议层。
   * 会话不可用（无模型凭据）时静默丢弃，避免面板刷错误提示。
   */
  notifyPageEvent(url: string): void {
    if (getMode() !== "teach") return;
    if (!this.session || !this.session.model) return;
    this.steer(`[页面事件] URL 已变为 ${url}，用户可能已完成上一步，请 snapshot 确认后自动推进下一步`);
  }

  /**
   * 切换运行模式（act/teach）：写 mode ref 并重建系统 prompt。
   * Pi SDK 事实（0.84.4，dist/core/resource-loader.js + agent-session.js）：
   * appendSystemPromptOverride 只在 resourceLoader.reload() 时求值并缓存结果数组，
   * 系统 prompt 在 AgentSession._rebuildSystemPrompt 时组装（会话创建 / setActiveToolsByName /
   * reload），不是每次请求都重评。因此切模式必须 reload() 让闭包重评，
   * 再借 setActiveToolsByName(同名集合)（工具不变）触发 prompt 重建并写入 agent.state.systemPrompt。
   */
  async setMode(mode: AgentMode): Promise<void> {
    setModeRef(mode);
    if (!this.session || !this.resourceLoader) return;
    try {
      await this.resourceLoader.reload();
      this.session.setActiveToolsByName(this.session.getActiveToolNames());
    } catch (err) {
      console.error(`[sideagent] 切换模式后重建系统 prompt 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.session?.dispose();
  }

  private guidanceMessage(): string {
    return this.initError ? `${SETUP_GUIDANCE}\n（初始化错误：${this.initError}）` : SETUP_GUIDANCE;
  }

  private emitError(err: unknown): void {
    if ((this.hold.isHeld() || this.expectedStoppedAgentEnd) && isAbortLike(err)) return;
    this.callbacks.emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }

  /** 同一次 stop 只调用一次 SDK abort；其 Promise resolve 即 SDK 已 waitForIdle。 */
  private stopCurrentRun(): Promise<void> {
    if (this.pendingStop) return this.pendingStop;
    const session = this.session;
    if (!session?.isStreaming) return Promise.resolve();
    this.expectedStoppedAgentEnd = true;
    let stopping: Promise<void>;
    try {
      stopping = session.abort();
    } catch (err) {
      stopping = Promise.reject(err);
    }
    const tracked = stopping.finally(() => {
      if (this.pendingStop === tracked) this.pendingStop = null;
    });
    this.pendingStop = tracked;
    return tracked;
  }

  private async promptHandbackAfterStop(epoch: number, text: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      await this.stopCurrentRun();
      if (epoch !== this.controlEpoch || this.pendingHandback?.epoch !== epoch) return;
      this.hold.releaseToAgent();
      this.handbackPromptEpoch = epoch;
      await session.prompt(text);
      if (this.handbackPromptEpoch === epoch) this.failPendingHandback(epoch);
    } catch (err) {
      this.failPendingHandback(epoch);
      this.emitError(err);
    } finally {
      if (this.handbackPromptEpoch === epoch) this.handbackPromptEpoch = null;
    }
  }

  private settlePendingHandback(epoch: number, started: boolean): void {
    const pending = this.pendingHandback;
    if (!pending || pending.epoch !== epoch) return;
    this.pendingHandback = null;
    pending.resolve(started);
  }

  private cancelPendingHandback(): void {
    const pending = this.pendingHandback;
    if (!pending) return;
    this.pendingHandback = null;
    pending.resolve(false);
  }

  private failPendingHandback(epoch: number): void {
    if (epoch === this.controlEpoch) this.hold.holdForUser();
    this.settlePendingHandback(epoch, false);
  }

  private acceptanceContextContainsTask(): boolean {
    const taskId = this.acceptanceTrace?.taskId;
    if (!taskId || !this.session) return false;
    return JSON.stringify(this.session.agent.state.messages).includes(`SIDEAGENT_ACCEPTANCE_TASK:${taskId}`);
  }

  private async waitForAcceptance(
    predicate: (trace: SessionAcceptanceContinuityEvidence) => boolean,
    timeoutMs = 10_000,
  ): Promise<void> {
    const started = Date.now();
    while (this.acceptanceTrace) {
      this.acceptanceTrace.contextTaskFound = this.acceptanceContextContainsTask();
      if (predicate(this.acceptanceTrace)) return;
      if (Date.now() - started >= timeoutMs) throw new Error(`等待真实 AgentSession 验收事件超时 task=${this.acceptanceTrace.taskId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("验收任务已被中止");
  }

  private subscribeEvents(): void {
    const session = this.session;
    if (!session) return;
    const { emit, setStatus } = this.callbacks;
    session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const ev = event.assistantMessageEvent;
          if (ev.type === "text_delta") {
            if (
              this.acceptanceTrace?.resumeRequested &&
              ev.delta.includes(`SIDEAGENT_ACCEPTANCE_CONTINUED:${this.acceptanceTrace.taskId}`)
            ) {
              this.acceptanceTrace.resumeContinuationMarkerFound = true;
            }
            emit({ kind: "text_delta", delta: ev.delta });
          }
          else if (ev.type === "thinking_delta") emit({ kind: "thinking_delta", delta: ev.delta });
          break;
        }
        case "tool_execution_start":
          if (this.acceptanceTrace?.resumeRequested && event.toolName === "snapshot") {
            this.acceptanceTrace.resumeSnapshotToolCalled = true;
          }
          emit({
            kind: "tool_start",
            toolCallId: event.toolCallId,
            name: event.toolName,
            params: asParams(event.args),
          });
          break;
        case "tool_execution_end":
          if (this.acceptanceTrace?.resumeRequested && event.toolName === "snapshot" && !event.isError) {
            this.acceptanceTrace.resumeSnapshotMarkerFound = firstText(event.result).includes(
              this.acceptanceTrace.expectedSnapshotMarker,
            );
            this.acceptanceTrace.contextTaskFound = this.acceptanceContextContainsTask();
            if (this.acceptanceTrace.resumeSnapshotMarkerFound && this.acceptanceTrace.contextTaskFound) {
              this.acceptanceTrace.step = "continued";
              this.acceptanceTrace.active = true;
            }
          }
          emit({
            kind: "tool_end",
            toolCallId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            resultText: firstText(event.result),
          });
          break;
        case "turn_start":
          emit({ kind: "turn_start" });
          break;
        case "turn_end":
          emit({ kind: "turn_end" });
          break;
        case "agent_start":
          if (
            this.handbackPromptEpoch !== null &&
            (this.handbackPromptEpoch !== this.controlEpoch || this.pendingHandback?.epoch !== this.handbackPromptEpoch)
          ) {
            this.handbackPromptEpoch = null;
            void this.stopCurrentRun().catch(() => {});
            setStatus(this.hold.isHeld() ? "user" : "idle");
            emit({ kind: "agent_start" });
            break;
          }
          if (this.handbackPromptEpoch !== null) {
            const epoch = this.handbackPromptEpoch;
            this.handbackPromptEpoch = null;
            this.settlePendingHandback(epoch, true);
          }
          if (this.acceptanceTrace) {
            if (this.acceptanceTrace.resumeRequested) this.acceptanceTrace.resumeAgentStarted = true;
            else this.acceptanceTrace.preTaskAgentStarted = true;
            this.acceptanceTrace.active = true;
            this.acceptanceTrace.contextTaskFound = this.acceptanceContextContainsTask();
          }
          setStatus(this.hold.statusAfterAgentStart());
          emit({ kind: "agent_start" });
          break;
        case "agent_end": {
          const stoppedByUser = this.expectedStoppedAgentEnd;
          this.expectedStoppedAgentEnd = false;
          // willRetry=true 时自动重试紧随其后，状态保持 running
          // 接管期间 agent_end 不得变成 idle（那会和中止/完成混淆）
          const next = this.hold.statusAfterAgentEnd(event.willRetry);
          if (next) setStatus(next);
          emit({ kind: "agent_end" });
          if (shouldSurfaceAgentEndIssue(this.hold.isHeld(), event.willRetry, stoppedByUser)) {
            const errText = lastAssistantError(event.messages);
            if (errText) {
              console.error(`[sideagent] 模型请求最终失败：${errText}`);
              emit({ kind: "error", message: `模型请求最终失败：${errText}` });
            } else if (runProducedNothing(event.messages)) {
              // 模型 200 但空响应（实测见于 kimi-coding/k3 被限流时），面板不能装死
              emit({
                kind: "notice",
                message: "模型返回了空响应：可能触发了限流或该模型当前不可用，建议在面板顶栏切换模型（如 kimi-coding/kimi-for-coding）后重试",
              });
            }
          }
          break;
        }
        case "compaction_start":
          emit({ kind: "notice", message: "正在压缩上下文…" });
          break;
        case "auto_retry_start":
          emit({ kind: "notice", message: `请求失败，正在重试（${event.attempt}/${event.maxAttempts}）…` });
          break;
        default:
          break;
      }
    });
  }
}

function asParams(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

/**
 * 把页面上下文（发送那一刻用户正在看的标签页）拼到用户消息前，
 * 作为"这页面"类指代的锚点；无上下文时原文返回。
 */
export function withPageContext(text: string, context?: PageContext): string {
  if (!context) return text;
  const title = (context.title || "(untitled)").replace(/\s+/g, " ");
  return `[User's current page: tab ${context.tabId} "${title}" — ${context.url}]\n${text}`;
}

export function lastAssistantError(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; errorMessage?: unknown };
    if (m && m.role === "assistant" && typeof m.errorMessage === "string" && m.errorMessage) {
      return m.errorMessage;
    }
  }
  return null;
}

/** 接管/中止会主动 abort 当前生成；这不是模型失败，也不该在面板留下错误或空响应提示。 */
export function shouldSurfaceAgentEndIssue(
  isHeld: boolean,
  willRetry: boolean,
  stoppedByUser = false,
): boolean {
  return !isHeld && !willRetry && !stoppedByUser;
}

function isAbortLike(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /abort/i.test(message);
}

/** 整轮运行没有任何可见输出（无文本、无工具调用）时视为空响应。 */
export function runProducedNothing(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown; toolCalls?: unknown };
    if (!m || m.role !== "assistant") continue;
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) return false;
    if (Array.isArray(m.content)) {
      for (const c of m.content as Array<{ type?: string; text?: unknown }>) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) return false;
      }
    }
  }
  return true;
}

function firstText(result: unknown): string {
  if (result && typeof result === "object" && Array.isArray((result as AgentToolResult<unknown>).content)) {
    for (const block of (result as AgentToolResult<unknown>).content) {
      if (block.type === "text") return block.text.slice(0, RESULT_TEXT_MAX);
    }
  }
  return "";
}
