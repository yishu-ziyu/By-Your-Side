/**
 * 与传输方式无关的宿主核心：会话管理、语音接线、hello 回应与消息分发。
 * 本机伴随进程（main.ts，stdio / ws）与扩展 offscreen 文档（extension/src/inproc/main.ts，runtime 端口）共用这一份；
 * 两边只各自提供传输、存储与本机才有的能力（剪贴板服务、语音录制）。
 */
import { PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, HOST_VERSION, type ClientMessage, type ServerMessage } from "../../shared/protocol.js";
import { generalBrowserLoopEnabled } from "./config.js";
import type { ConversationPersistence } from "./conversation-persistence.js";
import { ConversationManager } from "./conversation-manager.js";
import type { MemoryStore } from "./memory-store.js";
import type { SkillStore } from "./skill-store.js";
import type { BrowserAgentSession } from "./session.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { VoiceService } from "./voice-service.js";
import { readVoicePage } from "./voice-page-reader.js";

export interface ClientConn {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface HostCoreOptions {
  createRuntime: ConstructorParameters<typeof ConversationManager>[0];
  store?: ConversationPersistence;
  memoryStore?: MemoryStore;
  skillStore?: SkillStore;
  dispatcher?: TaskDispatcher;
  /** 语音密钥与会话工厂；不给时用本机默认（读 ~/.sideagent 的密钥、ws 连接）。 */
  voiceKey?: ConstructorParameters<typeof VoiceService>[2];
  voiceSession?: ConstructorParameters<typeof VoiceService>[3];
  /** 扩展内的语音任务始终交给正式任务调度；本机沿用现有开关。 */
  enableVoiceTaskDispatch?: boolean;
  /** 每条发往客户端的消息都会经过这里（本机用来录制语音诊断）。 */
  observe?: (msg: ServerMessage) => void;
  /** 客户端发来的语音命令先经这里；返回 true 表示已处理（本机录音的 capture 命令）。 */
  onVoiceCommand?: (msg: Extract<ClientMessage, { type: "voice" }>, conversationId: string) => boolean;
  /** hello_ok 的附加字段（本机的剪贴板端口）。 */
  helloExtras?: () => { clipboardPort?: number };
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

/** 内部错误码不直接给用户看：会话找不到时说清楚发生了什么、该怎么办。 */
function userFacingError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

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
    options.skillStore,
    options.dispatcher ?? new TaskDispatcher(),
  );

  const initial = await conversations.ensureDefault();

  voice = new VoiceService(
    id => conversations.getTaskProgress(id),
    toClient,
    options.voiceKey,
    options.voiceSession,
    undefined,
    (id, text, startedAt, stillCurrent, context) => conversations.routeVoiceInput(id, text, startedAt, stillCurrent, context),
    (event, fields) => options.log(`[voice] ${event} ${JSON.stringify(fields)}`),
    () => conversations.voiceTargets(),
    (id, deliveryId, status) => conversations.markDeliveryPlayback(id, deliveryId, status),
    (id, text, runId) => conversations.recordSpokenAck(id, text, runId),
    (origin, target) => conversations.isVoiceTask(origin, target),
    async (id, input) => {
      const runtime = conversations.get(id)?.runtime;

      if (!runtime) throw new Error("会话已关闭，未读取页面。");

      return readVoicePage(runtime.rpc, input);
    },
    (options.enableVoiceTaskDispatch ?? generalBrowserLoopEnabled()) ? async (request, stillCurrent) => {
      const receipt = await conversations.dispatchTaskAction(request, stillCurrent);

      return { ok: ["queued", "accepted", "applied"].includes(receipt.status), status: receipt.status, message: receipt.message, receipt };
    } : undefined,
    (id, call, input, signal) => conversations.executeRealtimeBrowserTool(id, call, input, signal),
  );

  const session = initial.runtime.session;

  return {
    session,
    conversations,
    adoptClient(conn) {
      if (current && current !== conn) { voice?.close(); current.close(); }

      current = conn;
      conversations.reconnect();
    },
    onClientGone(conn) {
      if (conn !== current) return false;
      current = null;
      voice?.close();
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
        event: { kind: "error", message: userFacingError(err) },
      }));
    },
    sendHelloOk(conn) {
      void session.availableModels().then((models) => {
        conn.send({ type: "hello_ok", version: PROTOCOL_VERSION, model: session.modelName(), models, hostVersion: HOST_VERSION, extensionVersion: "0.1.0", storageSchema: STORAGE_SCHEMA_VERSION, features: { memory: !!options.memoryStore, skills: !!options.skillStore }, ...options.helloExtras?.() });
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
