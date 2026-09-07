import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONVERSATION_ID, normalizeConversationId,
  type ClientMessage, type ConversationSummary, type ServerMessage,
} from "../../shared/protocol.js";
import type { ConversationStore } from "./conversation-store.js";
import type { createConversationRuntime } from "./conversation-runtime.js";

type Runtime = Awaited<ReturnType<typeof createConversationRuntime>>;
export interface ConversationEntry { summary: ConversationSummary; runtime: Runtime }

/** Identity is captured by each runtime's emitter, never read from the selected panel. */
export class ConversationManager {
  private readonly entries = new Map<string, ConversationEntry>();
  private readonly pending = new Map<string, Promise<ConversationEntry>>();
  private readonly requests = new Map<string, Promise<ConversationEntry>>();
  constructor(
    private readonly factory: (id: string, emit: (message: ServerMessage) => void, summary?: ConversationSummary) => Promise<Runtime>,
    private readonly emit: (message: ServerMessage) => void,
    private readonly store?: ConversationStore,
  ) {}

  async ensureDefault(): Promise<ConversationEntry> {
    for (const summary of this.store?.load() ?? []) await this.create(summary.id, summary.title, summary);
    return this.create(DEFAULT_CONVERSATION_ID, "新会话");
  }
  get(id: string): ConversationEntry | undefined { return this.entries.get(id); }
  list(): ConversationSummary[] { return [...this.entries.values()].map(({ summary }) => ({ ...summary })); }

  private create(id: string, title: string, restored?: ConversationSummary): Promise<ConversationEntry> {
    const existing = this.entries.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const summary: ConversationSummary = { id, title, createdAt: Date.now(), updatedAt: Date.now(), state: "idle", mode: "act", ...restored };
    const states = new Map<string, "idle" | "running" | "user">();
    const promise = this.factory(id, (message) => {
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
    if (message.type === "user_message" && entry.summary.title === "新会话") entry.summary.title = message.text.trim().slice(0, 36) || "新会话";
    if (message.type === "set_mode") entry.summary.mode = message.mode;
    entry.runtime.handleMessage(message);
    if (message.type === "user_message" || message.type === "set_mode") {
      entry.summary.updatedAt = Date.now();
      this.store?.save(this.list());
      this.emit({ type: "conversation_updated", conversationId: id, conversation: { ...entry.summary } });
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
