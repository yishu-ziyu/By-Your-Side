import { PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, HOST_VERSION, type ClientMessage, type ServerMessage } from "../../shared/protocol.js";
import type { ConversationPersistence } from "./conversation-persistence.js";
import { ConversationManager } from "./conversation-manager.js";
import type { MemoryStore } from "./memory-store.js";
import type { TaskHistoryStore } from "./task-history.js";
import type { LearnedOperationStore } from "./learned-operations.js";
import type { SiteNotesStore } from "./site-notes.js";
import type { BrowserAgentSession } from "./session.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { VoiceService } from "./voice-service.js";
import { readVoicePage } from "./voice-page-reader.js";
import type { TaskRecordStore } from './task-record-store.js';

export interface ClientConn {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface HostCoreOptions {
  taskRecords?: TaskRecordStore;
  continuationEnabled?: () => boolean;
  createRuntime: ConstructorParameters<typeof ConversationManager>[0];
  store?: ConversationPersistence;
  memoryStore?: MemoryStore;
  taskHistory?: TaskHistoryStore;
  learnedOperations?: LearnedOperationStore;
  siteNotes?: SiteNotesStore;
  dispatcher?: TaskDispatcher;
  voiceKey?: ConstructorParameters<typeof VoiceService>[2];
  voiceSession?: ConstructorParameters<typeof VoiceService>[3];
  observe?: (msg: ServerMessage) => void;
  onVoiceCommand?: (msg: Extract<ClientMessage, { type: "voice" }>, conversationId: string) => boolean;
  voiceDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
  log: (message: string) => void;
}

export interface HostCore {
  session: BrowserAgentSession;
  conversations: ConversationManager;
  adoptClient(conn: ClientConn): void;
  onClientGone(conn: ClientConn): boolean;
  handleMessage(msg: ClientMessage): void;
  sendHelloOk(conn: ClientConn): void;
  disposeAll(): void;
}

function userFacingError(message: string): string {
  return message.startsWith("CONVERSATION_NOT_FOUND") ? "这个会话在助手这边已经找不到了（助手可能刚重启过），这条没有发出去。请点右上角「＋」新建会话后再发。" : message;
}

export async function startHostCore(options: HostCoreOptions): Promise<HostCore> {
  let current: ClientConn | null = null;
  let voice: VoiceService | null = null;

  const toClient = (msg: ServerMessage): void => {
    options.observe?.(msg);
    current?.send(msg);
  };

  const conversations = new ConversationManager(
    options.createRuntime,
    (msg) => { voice?.observe(msg); toClient(msg); },
    options.store,
    options.memoryStore,
    options.dispatcher ?? new TaskDispatcher(),
  );

  conversations.taskHistory = options.taskHistory;
  if (options.taskRecords) conversations.taskRecords = options.taskRecords;
  conversations.continuationEnabled = options.continuationEnabled ?? (() => false);
  conversations.learnedOperations = options.learnedOperations;
  conversations.siteNotes = options.siteNotes;

  const initial = await conversations.ensureDefault();

  voice = new VoiceService(
    id => conversations.getTaskProgress(id),
    toClient,
    options.voiceKey,
    options.voiceSession,
    (id, text, startedAt, stillCurrent, context) => conversations.routeVoiceInput(id, text, startedAt, stillCurrent, context),
    (event, fields) => { options.log(`[voice] ${event} ${JSON.stringify(fields)}`); options.voiceDiagnostic?.(event, fields); },
    () => conversations.voiceTargets(),
    (id, deliveryId, status) => conversations.markDeliveryPlayback(id, deliveryId, status),
    (origin, target) => conversations.isVoiceTask(origin, target),
    async (id, input) => {
      const runtime = conversations.get(id)?.runtime;

      if (!runtime) throw new Error("会话已关闭，未读取页面。");

      return readVoicePage(runtime.rpc, input);
    },
    async (request, stillCurrent) => {
      const receipt = await conversations.dispatchTaskAction(request, stillCurrent);

      return { ok: ["queued", "accepted", "applied"].includes(receipt.status), status: receipt.status, message: receipt.message, receipt };
    },
    (id, call, input, signal) => conversations.executeRealtimeBrowserTool(id, call, input, signal),
  );

  const session = initial.runtime.session;

  return {
    session,
    conversations,
    adoptClient(conn) {
      if (current && current !== conn) { voice?.close("client_replaced"); current.close(); }

      current = conn;
      conversations.reconnect();
    },
    onClientGone(conn) {
      if (conn !== current) return false;
      current = null;
      voice?.close("client_disconnected");
      conversations.disconnect();

      return true;
    },
    handleMessage(msg) {
      if (msg.type === "voice") {
        const conversationId = msg.conversationId ?? "default";

        if (options.onVoiceCommand?.(msg, conversationId)) return;
        void voice?.handle(conversationId, msg);

        return;
      }

      void conversations.handleMessage(msg).catch((err) => current?.send({
        type: "agent_event", conversationId: msg.conversationId,
        event: { kind: "error", message: userFacingError(err instanceof Error ? err.message : String(err)) },
      }));
    },
    sendHelloOk(conn) {
      void session.availableModels().then((models) => {
        conn.send({ type: "hello_ok", version: PROTOCOL_VERSION, model: session.modelName(), models, hostVersion: HOST_VERSION, extensionVersion: "0.2.0", storageSchema: STORAGE_SCHEMA_VERSION, features: { memory: !!options.memoryStore } });
        conn.send({ type: "conversation_list", conversations: conversations.list() });
        conversations.replayState((msg) => conn.send(msg));
      });
    },
    disposeAll() {
      voice?.close();
      conversations.dispose();
    },
  };
}
