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
  readonly sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">;
}

/**
 * 任务核心对模型运行时的依赖（TS 检查器统计，2026-09-24）。本机实现是 pi-coding-agent 的 ModelRuntime；
 * 扩展里用 pi-ai 的模型目录包一层。注册验收模型、cliproxy 这类本机专用能力不在这里。
 */
export type ModelPort = Pick<ModelRuntime, "completeSimple" | "getAvailable" | "getModel" | "streamSimple">;

/** A completed provider failure may continue once on an explicitly configured, credentialed backup. */
export function withModelFailover(
  loop: AgentLoop,
  models: ModelPort,
  backupPattern: string | undefined,
  onSwitch: (from: string, to: string) => void,
): AgentLoop {
  if (!backupPattern) return loop;

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
    private readonly backupPattern: string,
    private readonly onSwitch: (from: string, to: string) => void,
  ) {
    this.unsubscribe = inner.subscribe(event => this.onEvent(event));
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
      const slash = this.backupPattern.indexOf("/");

      if (!previous || slash <= 0 || slash === this.backupPattern.length - 1) return;

      const provider = this.backupPattern.slice(0, slash);
      const id = this.backupPattern.slice(slash + 1);
      const available = await this.models.getAvailable(provider);
      const backup = available.find(model => model.provider === provider && model.id === id);

      if (!backup || this.stopped) return;

      // If the failed response is no longer the response in this context, do not
      // guess which message to remove or risk replaying an earlier tool call.
      const failedMessage = lastAssistant(failed.messages);
      const messages = this.inner.agent.state.messages;
      const index = failedMessage ? messages.lastIndexOf(failedMessage) : -1;

      if (index < 0) return;

      try {
        await this.inner.setModel(backup);
      } catch {
        // Credential expiry between listing and switching keeps the original failure.
        return;
      }

      this.switchedThisRun = true;
      this.heldEnd = undefined;
      const from = `${previous.provider}/${previous.id}`;
      const to = `${backup.provider}/${backup.id}`;
      this.inner.sessionManager.appendCustomEntry("sideagent-model-fallback-v1", { from, to });
      this.onSwitch(from, to);
      // Pi's normal retry removes only the failed assistant from model context.
      // Tool results remain, so continuing cannot execute already finished tools again.
      this.inner.agent.state.messages = [...messages.slice(0, index), ...messages.slice(index + 1)];
      await this.inner.agent.continue();
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
    if (event.willRetry || this.stopped || this.switchedThisRun) return false;

    const message = lastAssistant(event.messages);
    const model = this.inner.model;

    return !!message && !!model
      && `${model.provider}/${model.id}` !== this.backupPattern
      && !isContextOverflow(message, model.contextWindow)
      && isRetryableAssistantError(message);
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
