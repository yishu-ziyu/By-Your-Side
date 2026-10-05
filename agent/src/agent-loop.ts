import { isContextOverflow, isRetryableAssistantError, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * 会话层（session.ts）对底层 agent 循环的全部依赖，按实际访问的成员列出。
 * 本机实现就是 pi-coding-agent 的 AgentSession；扩展里另给一个基于 pi-agent-core Agent 的实现，
 * 这样同一份会话代码能在两处运行。加成员前先确认两边都能提供。
 */
export interface AgentLoop extends Pick<
  AgentSession,
  | "abort" | "clearQueue" | "dispose" | "getActiveToolNames" | "getToolDefinition" | "isStreaming"
  | "model" | "prompt" | "sendCustomMessage" | "sessionId" | "setActiveToolsByName" | "setModel" | "steer" | "subscribe"
> {
  readonly agent: {
    readonly state: Pick<AgentSession["agent"]["state"], "tools" | "messages">;
    continue(): Promise<void>;
    waitForIdle(): Promise<void>;
  };
  readonly sessionManager: {
    appendCustomEntry(customType: string, data?: Parameters<SessionManager["appendCustomEntry"]>[1]): string | Promise<string>;
    getBranch(): ReturnType<SessionManager["getBranch"]>;
  };
  flushPersistence?(): Promise<void>;
  /**
   * 可重试的模型错误要不要在同一模型上重试；返回 false 时这一轮直接结束（willRetry=false），由外层换备用模型。
   * 只有扩展里的循环支持；本机 AgentSession 照旧按自己的重试设置。
   */
  retryGate?: (message: AssistantMessage) => boolean;
  /** 接着当前上下文再跑一轮，并带自动重试；没有时退回 agent.continue()（不带重试）。 */
  resume?(): Promise<void>;
  /**
   * 模型正在写正文（还没开始写工具调用）时，把已写的部分当成这次调用的完整回复收下，让循环立刻读排队的插话。
   * 截断了返回 true；没有正在写的正文时返回 false，插话照旧等这一步结束。
   */
  interruptText?(): boolean;
}

/**
 * 任务核心对模型运行时的依赖（TS 检查器统计，2026-09-24）。本机实现是 pi-coding-agent 的 ModelRuntime；
 * 扩展里用 pi-ai 的模型目录包一层。注册验收模型、cliproxy 这类本机专用能力不在这里。
 */
export type ModelPort = Pick<ModelRuntime, "completeSimple" | "getAvailable" | "getModel" | "streamSimple"> & {
  /** 即时动作（划词解释、网页翻译批次）用的快速模型，调用时不开思考；没有设置时返回 undefined，沿用会话主模型。 */
  fastModel?: () => Model<Api> | undefined;
};

/**
 * 模型服务出错（挂起超时、连接错误、429、5xx、流提前结束）时，第一次失败就换备用模型接着做，每轮最多换一次。
 * 备用模型：显式给的 provider/id（须有凭据）；没给时用设置里的快速模型。和当前模型相同时不换。
 * 能换时不在原模型上重试（retryGate）；换过之后，备用模型照常自动重试。
 */
export function withModelFailover(
  loop: AgentLoop,
  models: ModelPort,
  backupPattern: string | undefined,
  onSwitch: (from: string, to: string) => void,
): AgentLoop {
  if (!backupPattern && !models.fastModel) return loop;

  return new FailoverLoop(loop, models, backupPattern, onSwitch);
}

class FailoverLoop implements AgentLoop {
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly unsubscribe: () => void;
  private heldEnd: Extract<AgentSessionEvent, { type: "agent_end" }> | undefined;
  private running = false;
  private stopped = false;
  private switchedThisRun = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly inner: AgentLoop,
    private readonly models: ModelPort,
    private readonly backupPattern: string | undefined,
    private readonly onSwitch: (from: string, to: string) => void,
  ) {
    this.unsubscribe = inner.subscribe(event => this.onEvent(event));
    inner.retryGate = message => !this.canSwitch(message);
  }

  get agent(): AgentLoop["agent"] {
    const inner = this.inner.agent;

    return {
      get state() { return inner.state; },
      continue: () => inner.continue(),
      waitForIdle: () => this.waitForIdle(),
    };
  }
  get sessionManager() { return this.inner.sessionManager; }
  flushPersistence() { return this.inner.flushPersistence?.() ?? Promise.resolve(); }
  get model() { return this.inner.model; }
  get sessionId() { return this.inner.sessionId; }
  get isStreaming() { return this.running || this.inner.isStreaming; }

  prompt(...args: Parameters<AgentLoop["prompt"]>): Promise<void> {
    // The underlying Agent is briefly idle while credentials are checked and the
    // backup model is selected. A new prompt must not overtake that continuation.
    if (this.running && !this.inner.isStreaming) return this.waitForIdle().then(() => this.prompt(...args));

    if (this.inner.isStreaming) return this.inner.prompt(...args);

    return this.run(() => this.inner.prompt(...args));
  }

  sendCustomMessage(...args: Parameters<AgentLoop["sendCustomMessage"]>): Promise<void> {
    if (this.running && !this.inner.isStreaming && args[1]?.triggerTurn) {
      return this.waitForIdle().then(() => this.sendCustomMessage(...args));
    }

    if (!args[1]?.triggerTurn || this.inner.isStreaming) return this.inner.sendCustomMessage(...args);

    return this.run(() => this.inner.sendCustomMessage(...args));
  }

  steer(...args: Parameters<AgentLoop["steer"]>) { return this.inner.steer(...args); }
  interruptText() { return this.inner.interruptText?.() ?? false; }
  clearQueue() { return this.inner.clearQueue(); }
  getActiveToolNames() { return this.inner.getActiveToolNames(); }
  getToolDefinition(name: string) { return this.inner.getToolDefinition(name); }
  setActiveToolsByName(names: string[]) { return this.inner.setActiveToolsByName(names); }
  setModel(model: Model<Api>) { return this.inner.setModel(model); }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);

    return () => { this.listeners.delete(listener); };
  }

  async abort(): Promise<void> {
    this.stopped = true;
    await this.inner.abort();
    await this.waitForIdle();
  }

  dispose(): void {
    this.stopped = true;
    this.unsubscribe();
    this.listeners.clear();
    this.inner.dispose();
  }

  private async run(start: () => Promise<void>): Promise<void> {
    this.running = true;
    this.stopped = false;
    this.switchedThisRun = false;

    try {
      await start();
      const failed = this.heldEnd;

      if (!failed || this.stopped) return;

      const previous = this.inner.model;
      const backup = await this.usableBackup();

      if (!previous || this.stopped) return;

      // If the failed response is no longer the response in this context, do not
      // guess which message to remove or risk replaying an earlier tool call.
      const failedMessage = lastAssistant(failed.messages);
      const messages = this.inner.agent.state.messages;
      const index = failedMessage ? messages.lastIndexOf(failedMessage) : -1;

      if (index < 0) return;

      this.switchedThisRun = true;
      this.heldEnd = undefined;

      if (!backup || !await this.inner.setModel(backup).then(() => true, () => false)) {
        // 备用模型没有凭据或换不过去：回到原模型的自动重试，不因为没换成就少试。
        this.inner.agent.state.messages = [...messages.slice(0, index), ...messages.slice(index + 1)];
        await this.continueRun();

        return;
      }

      const from = `${previous.provider}/${previous.id}`;
      const to = `${backup.provider}/${backup.id}`;
      await this.inner.sessionManager.appendCustomEntry("sideagent-model-fallback-v1", { from, to });
      this.onSwitch(from, to);
      // Pi's normal retry removes only the failed assistant from model context.
      // Tool results remain, so continuing cannot execute already finished tools again.
      this.inner.agent.state.messages = [...messages.slice(0, index), ...messages.slice(index + 1)];
      await this.continueRun();
    } catch (error) {
      if (this.heldEnd) return;

      throw error;
    } finally {
      if (this.heldEnd) this.emit(this.heldEnd);

      this.heldEnd = undefined;
      this.running = false;
      this.emit({ type: "agent_settled" });

      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private onEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_end" && this.shouldSwitch(event)) {
      this.heldEnd = event;

      return;
    }

    if (event.type === "agent_settled" && this.running) return;

    this.emit(event);
  }

  private shouldSwitch(event: Extract<AgentSessionEvent, { type: "agent_end" }>): boolean {
    if (event.willRetry) return false;

    const message = lastAssistant(event.messages);

    return !!message && this.canSwitch(message);
  }

  /** 这次失败能不能换备用模型：本轮没换过、有和当前不同的备用模型、错误属于服务暂时不可用。 */
  private canSwitch(message: AssistantMessage): boolean {
    const model = this.inner.model;
    const backup = this.candidate();

    return !this.stopped && !this.switchedThisRun && !!model && !!backup
      && `${model.provider}/${model.id}` !== `${backup.provider}/${backup.id}`
      && !isContextOverflow(message, model.contextWindow)
      && isRetryableAssistantError(message);
  }

  private candidate(): Model<Api> | undefined {
    if (!this.backupPattern) return this.models.fastModel?.();

    const slash = this.backupPattern.indexOf("/");

    if (slash <= 0 || slash === this.backupPattern.length - 1) return undefined;

    return this.models.getModel(this.backupPattern.slice(0, slash), this.backupPattern.slice(slash + 1));
  }

  /** 显式指定的备用模型要有凭据；快速模型是用户在设置里选的，划词、翻译也在用，直接用。 */
  private async usableBackup(): Promise<Model<Api> | undefined> {
    const candidate = this.candidate();

    if (!candidate || !this.backupPattern) return candidate;

    const available = await this.models.getAvailable(candidate.provider);

    return available.find(model => model.provider === candidate.provider && model.id === candidate.id);
  }

  private continueRun(): Promise<void> {
    return this.inner.resume ? this.inner.resume() : this.inner.agent.continue();
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private waitForIdle(): Promise<void> {
    if (!this.running) return this.inner.agent.waitForIdle();

    return new Promise(resolve => { this.idleWaiters.push(resolve); });
  }
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];

    if (message?.role === "assistant") return message;
  }

  return undefined;
}
