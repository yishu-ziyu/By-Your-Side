import { isContextOverflow, type Api, type AssistantMessage, type Model, type Models } from "@earendil-works/pi-ai";
import { isTransientModelError } from "../../shared/provider-busy.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

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
  readonly systemPrompt: string;
  retryGate?: (message: AssistantMessage) => boolean;
  resume?(): Promise<void>;
  warmPromptCache?(next: { toolNames: readonly string[]; systemPrompt: (base: string) => string }): Promise<"sent" | "skipped" | "aborted" | "error">;
  readonly keepsRunAfterDisconnect?: boolean;
  interruptText?(): boolean;
}

export type ModelPort = Pick<ModelRuntime, "completeSimple" | "getAvailable" | "getModel" | "streamSimple"> & {
  fastModel?: () => Model<Api> | undefined;
  backupModel?: () => Model<Api> | undefined;
  providerName?: (provider: string) => string | undefined;
  observeQueue?: (onWait: (wait: { provider: string; purpose: "main" | "side"; waitedMs: number }) => void) => ModelPort;
  pi?: Models;
};

export interface ModelQueueOptions {
  userWaiting?: true;
  onQueued?: (sent: Promise<void>) => void;
}

export function userWaiting<T extends object>(options: T): T & ModelQueueOptions {
  return { ...options, userWaiting: true };
}

export class RunNotStarted extends Error {
  constructor() {
    super("本轮已取消，没有启动模型或操作页面。");
    this.name = "RunNotStarted";
  }
}

const MODEL_SWITCH_BACK_AFTER_MS = 5 * 60_000;

export function withModelFailover(
  loop: AgentLoop,
  models: ModelPort,
  backupPattern: string | undefined,
  onSwitch: (from: string, to: string, reason: "fallback" | "restore") => void,
): AgentLoop {
  if (!backupPattern && !models.backupModel) return loop;

  return new FailoverLoop(loop, models, backupPattern, onSwitch);
}

class FailoverLoop implements AgentLoop {
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly unsubscribe: () => void;
  private heldEnd: Extract<AgentSessionEvent, { type: "agent_end" }> | undefined;
  private running = false;
  private stopped = false;
  private switchedThisRun = false;
  private switchedAt: number | undefined;
  private primary: Model<Api> | undefined;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly inner: AgentLoop,
    private readonly models: ModelPort,
    private readonly backupPattern: string | undefined,
    private readonly onSwitch: (from: string, to: string, reason: "fallback" | "restore") => void,
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

  get systemPrompt() { return this.inner.systemPrompt; }
  get sessionId() { return this.inner.sessionId; }
  get isStreaming() { return this.running || this.inner.isStreaming; }

  prompt(...args: Parameters<AgentLoop["prompt"]>): Promise<void> {
    if (this.running && !this.inner.isStreaming) return this.waitForIdle().then(() => this.prompt(...args));

    if (this.inner.isStreaming) return this.inner.prompt(...args);

    return this.run(async () => {
      await this.switchBackIfDue();
      await this.inner.prompt(...args);
    });
  }

  resume(): Promise<void> {
    return this.run(() => this.continueRun());
  }

  sendCustomMessage(...args: Parameters<AgentLoop["sendCustomMessage"]>): Promise<void> {
    if (this.running && !this.inner.isStreaming && args[1]?.triggerTurn) {
      return this.waitForIdle().then(() => this.sendCustomMessage(...args));
    }

    if (!args[1]?.triggerTurn || this.inner.isStreaming) return this.inner.sendCustomMessage(...args);

    return this.run(() => this.inner.sendCustomMessage(...args));
  }

  steer(...args: Parameters<AgentLoop["steer"]>) { return this.inner.steer(...args); }
  warmPromptCache(...args: Parameters<NonNullable<AgentLoop["warmPromptCache"]>>) { return this.inner.warmPromptCache?.(...args) ?? Promise.resolve("skipped" as const); }
  get keepsRunAfterDisconnect() { return this.inner.keepsRunAfterDisconnect === true; }
  interruptText() { return this.inner.interruptText?.() ?? false; }
  clearQueue() { return this.inner.clearQueue(); }
  getActiveToolNames() { return this.inner.getActiveToolNames(); }
  getToolDefinition(name: string) { return this.inner.getToolDefinition(name); }
  setActiveToolsByName(names: string[]) { return this.inner.setActiveToolsByName(names); }
  setModel(model: Model<Api>) {
    this.switchedAt = undefined;
    this.primary = undefined;

    return this.inner.setModel(model);
  }

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

      const failedMessage = lastAssistant(failed.messages);
      const messages = this.inner.agent.state.messages;
      const index = failedMessage ? messages.lastIndexOf(failedMessage) : -1;

      if (index < 0) return;

      this.switchedThisRun = true;
      this.heldEnd = undefined;

      if (!backup || !await this.inner.setModel(backup).then(() => true, () => false)) {
        this.inner.agent.state.messages = [...messages.slice(0, index), ...messages.slice(index + 1)];

        if (this.stopped) return;

        await this.continueRun();

        return;
      }

      const from = `${previous.provider}/${previous.id}`;
      const to = `${backup.provider}/${backup.id}`;
      this.switchedAt = Date.now();
      this.primary = previous;
      await this.inner.sessionManager.appendCustomEntry("sideagent-model-fallback-v1", { from, to });
      this.onSwitch(from, to, "fallback");
      this.inner.agent.state.messages = [...messages.slice(0, index), ...messages.slice(index + 1)];

      if (this.stopped) return;

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

  private async switchBackIfDue(): Promise<void> {
    const primary = this.primary;
    const backup = this.inner.model;

    if (this.switchedAt === undefined || !primary || !backup || Date.now() - this.switchedAt < MODEL_SWITCH_BACK_AFTER_MS) return;

    this.switchedAt = undefined;
    this.primary = undefined;

    if (!await this.inner.setModel(primary).then(() => true, () => false)) return;

    this.onSwitch(`${backup.provider}/${backup.id}`, `${primary.provider}/${primary.id}`, "restore");
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

  private canSwitch(message: AssistantMessage): boolean {
    const model = this.inner.model;
    const backup = this.candidate();

    return !this.stopped && !this.switchedThisRun && !!model && !!backup
      && `${model.provider}/${model.id}` !== `${backup.provider}/${backup.id}`
      && !isContextOverflow(message, model.contextWindow)
      && isTransientModelError(message);
  }

  private candidate(): Model<Api> | undefined {
    if (!this.backupPattern) return this.models.backupModel?.();

    const slash = this.backupPattern.indexOf("/");

    if (slash <= 0 || slash === this.backupPattern.length - 1) return undefined;

    return this.models.getModel(this.backupPattern.slice(0, slash), this.backupPattern.slice(slash + 1));
  }

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
