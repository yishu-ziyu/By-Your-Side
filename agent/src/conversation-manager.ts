import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONVERSATION_ID, normalizeConversationId,
  type ClientMessage, type ConversationSummary, type ServerMessage,
} from "../../shared/protocol.js";
import type { ConversationStore } from "./conversation-store.js";
import type { createConversationRuntime } from "./conversation-runtime.js";
import type { MemoryStore } from "./memory-store.js";
import { TaskProgress } from "./task-progress.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";

type Runtime = Awaited<ReturnType<typeof createConversationRuntime>>;
export interface ConversationEntry { summary: ConversationSummary; runtime: Runtime }

/** Identity is captured by each runtime's emitter, never read from the selected panel. */
export class ConversationManager {
  private readonly entries = new Map<string, ConversationEntry>();
  private readonly pending = new Map<string, Promise<ConversationEntry>>();
  private readonly requests = new Map<string, Promise<ConversationEntry>>();
  private readonly progress = new Map<string, TaskProgress>();
  constructor(
    private readonly factory: (id: string, emit: (message: ServerMessage) => void, summary?: ConversationSummary) => Promise<Runtime>,
    private readonly emit: (message: ServerMessage) => void,
    private readonly store?: ConversationStore,
    private readonly memoryStore?: MemoryStore,
  ) {}

  async ensureDefault(): Promise<ConversationEntry> {
    for (const summary of this.store?.load() ?? []) await this.create(summary.id, summary.title, summary);
    return this.create(DEFAULT_CONVERSATION_ID, "新会话");
  }
  get(id: string): ConversationEntry | undefined { return this.entries.get(id); }
  getTaskProgress(id: string): TaskProgressSnapshot | null { return this.progress.get(id)?.snapshot() ?? null; }
  async routeVoiceInput(id: string, text: string, startedAt: number | null, stillCurrent: () => boolean) {
    const session = this.entries.get(id)?.runtime.session;
    if (!session || !text.trim() || text.length > 2000) throw new Error("这句话没有听清或过长，请重新说。");
    if (!await session.classifyVoiceEdit(text)) return { kind: "none" as const };
    if (!stillCurrent()) throw new Error("语音已结束或你正在说新指令，本句未发送。");
    try {
      await this.steerFromVoice(id, text, startedAt);
      return { kind: "steer" as const, ok: true, message: "修改原话已送达正在执行的任务；不等于页面修改已完成。" };
    } catch (error) { return { kind: "steer" as const, ok: false, message: error instanceof Error ? error.message : "修改未送达。" }; }
  }
  async steerFromVoice(id: string, text: string, expectedStartedAt: number | null): Promise<void> {
    const entry = this.entries.get(id);
    const snapshot = this.getTaskProgress(id);
    if (!entry || !snapshot || snapshot.state !== "running" || expectedStartedAt === null || snapshot.startedAt !== expectedStartedAt) {
      throw new Error("原任务已停止或发生变化，修改未发送。");
    }
    if (!text.trim() || text.length > 2000) throw new Error("这段修改没有听清或过长，请简短重说。");
    await entry.runtime.session.steerCurrentTask(text);
    this.emit({ type: "agent_event", conversationId: id, event: { kind: "notice", message: `语音修改已送达当前任务：${text}` } });
  }
  list(): ConversationSummary[] { return [...this.entries.values()].map(({ summary }) => ({ ...summary })); }

  private create(id: string, title: string, restored?: ConversationSummary): Promise<ConversationEntry> {
    const existing = this.entries.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const summary: ConversationSummary = { id, title, createdAt: Date.now(), updatedAt: Date.now(), state: "idle", mode: "act", ...restored };
    const states = new Map<string, "idle" | "running" | "user">();
    const progress = new TaskProgress(id);
    this.progress.set(id, progress);
    const promise = this.factory(id, (message) => {
      progress.observe(message);
      const scoped = { ...message, conversationId: id };
      this.emit(scoped);
      if (message.type === "status") {
        states.set(message.sessionId ?? "main", message.state);
        summary.state = [...states.values()].includes("running") ? "running" : [...states.values()].includes("user") ? "user" : "idle";
        summary.updatedAt = Date.now();
        this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...summary } });
      }
      if (message.type === "model_info") {
        summary.model = message.model;
        this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...summary } });
      }
      if (message.type === "status" || message.type === "model_info") this.store?.save(this.list());
    }, summary).then((runtime) => {
      summary.model = runtime.session.modelName();
      runtime.fleet.setTabCoordinator?.(async (owner, members) => {
        const source = this.entries.get(owner)?.runtime;
        if (!source) return; // 已结束的运行时：扩展仍会检查归属并排空旧操作。
        const sessions = members.map(member => member === "main" ? source.session : source.fleet.get(member));
        if (sessions.some(session => session?.isHeld())) throw new Error("页面现在归你，操作未执行");
        await Promise.all(members.map(member => member === "main"
          ? source.session.yieldTab()
          : source.fleet.stopAndRelease(member)));
      });
      const entry = { summary, runtime };
      this.entries.set(id, entry);
      this.store?.save(this.list());
      this.pending.delete(id);
      return entry;
    }, (error: unknown) => { this.pending.delete(id); throw error; });
    this.pending.set(id, promise);
    return promise;
  }

  async handleMessage(message: ClientMessage): Promise<void> {
    if (message.type === "conversation_create") {
      let request = this.requests.get(message.requestId);
      if (!request) {
        request = this.create(randomUUID(), message.title?.trim() || "新会话");
        this.requests.set(message.requestId, request);
      }
      const entry = await request;
      this.emit({ type: "conversation_created", requestId: message.requestId, conversationId: entry.summary.id, conversation: { ...entry.summary } });
      return;
    }
    if (message.type === "conversation_list") {
      this.emit({ type: "conversation_list", requestId: message.requestId, conversations: this.list() });
      this.replayState(this.emit);
      return;
    }
    const id = normalizeConversationId(message.conversationId);
    const entry = this.entries.get(id) ?? (id === DEFAULT_CONVERSATION_ID ? await this.ensureDefault() : undefined);
    if (!entry) throw new Error(`CONVERSATION_NOT_FOUND: ${id}`);
    if (message.type === "memory_list" || message.type === "memory_update" || message.type === "memory_forget") {
      await this.handleMemoryMessage(message, id);
      return;
    }
    if (message.type === "user_message" && entry.summary.title === "新会话") entry.summary.title = message.text.trim().slice(0, 36) || "新会话";
    if (message.type === "set_mode") entry.summary.mode = message.mode;
    if (message.type === "user_message") this.progress.get(id)?.request(message.text);
    if (message.type === "abort") this.progress.get(id)?.abort();
    entry.runtime.handleMessage(message);
    if (message.type === "user_message" || message.type === "set_mode") {
      entry.summary.updatedAt = Date.now();
      this.store?.save(this.list());
      this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...entry.summary } });
    }
  }

  private async handleMemoryMessage(
    message: Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" }>,
    conversationId: string,
  ): Promise<void> {
    const action = message.type === "memory_list" ? "list" : message.type === "memory_update" ? "update" : "forget";
    try {
      if (!this.memoryStore) throw new Error("记忆存储不可用");
      if (message.type === "memory_list") {
        const entries = await this.memoryStore.list();
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entries });
        return;
      }
      if (message.type === "memory_update") {
        const changed = await this.memoryStore.update({
          id: message.id,
          expectedVersion: message.expectedVersion,
          text: message.text,
          scope: message.scope,
        });
        this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, entry: changed });
        return;
      }
      await this.memoryStore.forget({ id: message.id, expectedVersion: message.expectedVersion });
      this.emit({ type: "memory_result", conversationId, requestId: message.requestId, action, ok: true, deletedId: message.id });
    } catch (error) {
      this.emit({
        type: "memory_result",
        conversationId,
        requestId: message.requestId,
        action,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  replayState(emit: (message: ServerMessage) => void): void {
    for (const { summary, runtime } of this.entries.values()) {
      emit({ type: "status", conversationId: summary.id, state: runtime.session.isHeld() ? "user" : runtime.session.isStreaming() ? "running" : "idle" });
      void runtime.session.availableModels().then((models) => emit({ type: "model_info", conversationId: summary.id, model: runtime.session.modelName(), models }));
      for (const worker of runtime.fleet.list()) emit({ type: "status", conversationId: summary.id, sessionId: worker.id, state: runtime.fleet.get(worker.id)?.isHeld() ? "user" : worker.streaming ? "running" : "idle" });
      const team = runtime.fleet.teamView();
      if (team) emit({ type: "team_status", conversationId: summary.id, team });
    }
  }

  disconnect(): void {
    for (const { runtime } of this.entries.values()) {
      runtime.rpc.rejectAll(new Error("Extension disconnected"));
      if (!runtime.session.isHeld() && !runtime.fleet.isGroupHeld()) {
        runtime.session.abort();
        runtime.fleet.abortTeam();
      }
    }
  }
  dispose(): void { for (const { runtime } of this.entries.values()) runtime.dispose(); }
}
