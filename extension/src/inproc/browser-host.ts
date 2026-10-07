/** offscreen 入口：配置与端口留在扩展，任务和语音走同一份宿主核心。 */
import { createConversationRuntime, MemoryStore, RealtimeVoiceSession, TaskHistoryStore, startHostCore, useMemoryHabits, usePendingMemoryJudgments, type ArtifactPersistence, type ClientConn, type DocumentPersistence, type HostCore } from "@sideagent/agent/browser-core";
import type { SessionLogPort } from "@sideagent/agent/browser-core";
import { HOST_VERSION, PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, type ClientMessage, type ServerMessage } from "../../../shared/protocol.js";
import { describeModelError } from "../../../shared/user-facing.js";
import type { TaskActionRequest, TaskReceipt } from "../../../shared/task-actions.js";
import { PROBE_TIMEOUT_MS, probeModel, type createModelRuntime, type ModelRuntime } from "./model-runtime.js";
import { INPROC_KEEPALIVE_MS, INPROC_PORT_NAME, type InprocModelConfig, type StoredCredentials } from "./shared.js";
import { BrowserSocket } from "./voice/browser-socket.js";
import { VoiceCaptureRecorder } from "../../../shared/voice-capture-core.js";
import { createVoiceCaptureSink } from "../shared/trace-store.js";
import { openConversationStore } from "./conversation-store.js";
import { listArtifacts, writeArtifact, deleteArtifact } from "../shared/durable-store.js";
import { openPiSession } from "./pi-session-idb.js";
import { IdbDocument } from "./document-idb.js";

type Inbound = ClientMessage
  | { type: "inproc_config"; config: InprocModelConfig | null; fast?: InprocModelConfig | null; credentials: StoredCredentials }
  | { type: "inproc_voice"; configured: boolean };

export interface InprocHostDeps {
  createRuntime: typeof createModelRuntime;
  /** Tests explicitly inject a session backend; production always uses IndexedDB. */
  sessionData?: (id: string) => Promise<{ session: SessionLogPort; files?: ArtifactPersistence }>;
  /** Node entry-contract tests inject durable documents; production uses IndexedDB. */
  document?: (name: "memories" | "pending-memory" | "tasks" | "habits") => DocumentPersistence;
  onConnect: (listener: (port: chrome.runtime.Port) => void) => void;
}

export function startInprocHost(deps: InprocHostDeps): void {
  let port: chrome.runtime.Port | null = null;
  let connection: ClientConn | null = null;
  let core: HostCore | null = null;
  let pendingCore: Promise<HostCore> | null = null;
  let selected: InprocModelConfig | null = null;
  let fastSelected: InprocModelConfig | null = null;
  let storedCredentials: StoredCredentials = {};
  let voiceConfigured = false;
  let helloReceived = false;
  /** 配置模型前收到的阅读转侧栏（带 reading 的新建会话）：核心启动后补处理。 */
  const deferredCreates: ClientMessage[] = [];

  const log = (message: string) => console.debug("[sideagent]", message);
  // 语音日常记录：与本机同一套行，写进扩展的 IndexedDB；扩展不保存音频，所以会话一律不开 persistAudio。
  const voiceCapture = new VoiceCaptureRecorder(createVoiceCaptureSink(log), log);

  const models: ModelRuntime = deps.createRuntime((providerId, credential) => {
    port?.postMessage({ type: "inproc_credential", providerId, credential: credential ?? null });
  });

  async function ensureCore(): Promise<HostCore> {
    if (core) return core;

    if (!selected) throw new Error("还没有配置模型：打开右上角「更多 → 模型与语音」选择服务商。");

    if (pendingCore) return pendingCore;

    const modelPort = models.createCoreModels(() => selected, () => fastSelected);
    let pattern = "";

    // 新对话按建立时的设置取模型；核心启动后设置页可能已经换过（恢复的对话沿用自己记下的模型）。
    const currentPattern = () => {
      if (selected) {
        const model = models.resolveModel(selected);
        pattern = `${model.provider}/${model.id}`;
      }

      return pattern;
    };

    currentPattern();
    // 会话目录先读进内存：核心启动时按它重建会话，offscreen 重启后侧栏的会话编号仍然有效。
    // 个人记忆存在扩展本地（IndexedDB），和本机宿主同一套判断与读写规则。
    // 「要不要记」判断失败的话排在另一条记录里，一轮结束后补判；判完即删原话。
    const document = deps.document ?? ((name: string) => new IdbDocument(name));
    const memoryStore = useMemoryHabits(usePendingMemoryJudgments(new MemoryStore(document("memories")), document("pending-memory")), document("habits"));
    const taskHistory = new TaskHistoryStore(document("tasks"));
    pendingCore = openConversationStore(log).then(store => startHostCore({
      store,
      memoryStore,
      taskHistory,
      createRuntime: async (id, emit, summary) => {
        const data = deps.sessionData ? await deps.sessionData(id) : {
          session: await openPiSession(id),
          files: {load:()=>listArtifacts(id),save:(item: Parameters<ArtifactPersistence["save"]>[0])=>writeArtifact(id,item),delete:(filename:string)=>deleteArtifact(id,filename)},
        };

        // 不另设备用模型：主模型挂起或出错时换设置里的快速模型（withModelFailover）。
        return createConversationRuntime(id, emit, summary?.model ?? currentPattern(), {
        loop: { models: modelPort, cwd: "/", session: data.session },
        artifactPersistence: data.files,
        memoryStore,
        taskHistory,
        });
      },
      voiceKey: async () => {
        if (!voiceConfigured) throw new Error("还没有语音 key：打开右上角「更多 → 模型与语音」，在「实时语音」里填阶跃星辰的 key。");

        return "injected-by-extension";
      },
      voiceSession: voiceDeps => new RealtimeVoiceSession({
        ...voiceDeps,
        // SAFETY: BrowserSocket 实现了 RealtimeVoiceSession 实际用到的 ws 子集（readyState/on/send/close）。
        connect: () => new BrowserSocket() as never,
      }),
      enableVoiceTaskDispatch: true,
      observe: msg => { if (msg.type === "voice" && msg.event.kind === "diag") voiceCapture.record(msg.voiceId, msg.conversationId ?? "default", msg.event.record); },
      onVoiceCommand: (msg, conversationId) => {
        // 只属于扩展的记录事实（capture）不送往上游语音会话。
        if (msg.command.kind === "capture") {
          voiceCapture.command(msg.voiceId, conversationId, msg.command);

          return true;
        }

        if (msg.command.kind === "start") voiceCapture.begin(msg.voiceId, conversationId, { persistAudio: false });

        return false;
      },
      log,
    })).then(value => {
      core = value;

      if (connection) core.adoptClient(connection);

      return value;
    }).finally(() => { pendingCore = null; });

    return pendingCore;
  }

  function sendUnavailable(message: ClientMessage): void {
    if (message.type === "hello") {
      connection?.send({ type: "hello_ok", version: PROTOCOL_VERSION, models: [], hostVersion: HOST_VERSION, extensionVersion: "0.2.0", storageSchema: STORAGE_SCHEMA_VERSION });
      connection?.send({ type: "conversation_list", conversations: [] });

      return;
    }

    if (message.type === "conversation_list") {
      connection?.send({ type: "conversation_list", requestId: message.requestId, conversations: [] });

      return;
    }

    // 只补处理阅读转侧栏：它一直等回执。侧栏自己的新建请求 4 秒没回执就留在原会话，
    // 配好模型后再补建会把侧栏切到一个空会话，用户刚发的第一句话和回答都被挤到后台。
    if (message.type === "conversation_create") {
      if (message.reading) deferredCreates.push(message);

      return;
    }

    if (message.type === "task_action") {
      const request: TaskActionRequest = message.request;
      const detail = "还没有配置模型：打开右上角「更多 → 模型与语音」选择服务商。";

      const receipt: TaskReceipt = {
        requestId: request.requestId, conversationId: request.conversationId, source: request.source,
        action: request.action, runId: null, text: request.text ?? "", targetTitle: request.context?.title ?? "",
        status: "rejected", message: detail, updatedAt: Date.now(), needsModel: true,
      };

      connection?.send({ type: "agent_event", conversationId: request.conversationId, event: { kind: "notice", message: detail, receipt } });

      return;
    }

    // 主动建议是后台自己发起的：没配模型就静静地不建议，不在会话里报错。
    if (message.type === "nudge_request") {
      connection?.send({ type: "nudge_result", requestId: message.requestId, nudge: null });

      return;
    }

    if (message.type !== "task_view_query" && message.type !== "task_receipt_query") {
      connection?.send({ type: "agent_event", conversationId: message.conversationId, event: { kind: "error", message: "请先在「模型与语音」里配置模型。" } });
    }
  }

  async function handle(message: Inbound): Promise<void> {
    if (message.type === "inproc_voice") {
      voiceConfigured = message.configured;

      return;
    }

    if (message.type === "inproc_config") {
      selected = message.config;
      fastSelected = message.fast ?? null;
      storedCredentials = message.credentials ?? {};
      await models.credentials.load(storedCredentials);

      if (!selected) return;
      const model = models.resolveModel(selected);

      if (core) {
        for (const conversation of core.conversations.list()) {
          await core.conversations.handleMessage({ type: "set_model", conversationId: conversation.id, model: `${model.provider}/${model.id}` });
        }
      } else {
        const started = await ensureCore();

        if (helloReceived && connection) started.sendHelloOk(connection);

        for (const create of deferredCreates.splice(0)) started.handleMessage(create);
      }

      return;
    }

    if (message.type === "model_key_test") { void testKey(message);

 return; }

    // 侧栏刚换的 key 先用上再接着做：设置存储随后也会推来同一份，不等它，免得接着做时还拿旧 key。
    if (message.type === "retry_after_error" && message.key && selected) {
      storedCredentials = { ...storedCredentials, [selected.provider]: { type: "api_key", key: message.key } };
      await models.credentials.load(storedCredentials);
    }

    if (message.type === "hello") helloReceived = true;

    if (!selected) { sendUnavailable(message);

 return; }

    if (!core) await ensureCore();

    if (!core) { sendUnavailable(message);

 return; }

    if (message.type === "hello") core.sendHelloOk(connection!);
    else core.handleMessage(message);
  }

  /** 换 key 面板的「测试连接」：用另一份运行时试新 key，不动正在用的凭据。 */
  async function testKey(message: Extract<ClientMessage, { type: "model_key_test" }>): Promise<void> {
    const reply = (result: { ok: boolean; ms?: number; reason?: string; detail?: string }) =>
      connection?.send({ type: "model_key_test_result", conversationId: message.conversationId, requestId: message.requestId, ...result });

    if (!selected) return reply({ ok: false, reason: "还没有配置模型。" });
    const config = selected;
    const started = performance.now();
    const probe = deps.createRuntime(() => undefined);
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);

    try {
      await probe.credentials.load({ ...storedCredentials, [config.provider]: { type: "api_key", key: message.key } });
      await probeModel(probe, config, timeout);
      reply({ ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const copy = describeModelError(`模型请求最终失败：${raw}`);

      const reason = timeout.aborted ? `${PROBE_TIMEOUT_MS / 1000} 秒内没有回复，服务商可能正忙，可以再试一次。`
        : copy?.kind === "auth" ? "这个 key 也不行：key 无效，或没有这个模型的权限。" : `${copy?.title ?? "连接失败"}。`;

      reply({ ok: false, reason, detail: raw.slice(0, 2000) });
    }
  }

  setInterval(() => port?.postMessage({ type: "inproc_keepalive" }), INPROC_KEEPALIVE_MS);

  deps.onConnect(next => {
    if (next.name !== INPROC_PORT_NAME) return;
    port = next;
    helloReceived = false;

    const conn: ClientConn = {
      send: (frame: ServerMessage) => next.postMessage(frame),
      close: () => next.disconnect(),
    };

    connection = conn;

    if (core) core.adoptClient(conn);
    let queue = Promise.resolve();
    next.onMessage.addListener((raw: Inbound) => {
      queue = queue.then(() => handle(raw)).catch(error => {
        conn.send({ type: "agent_event", event: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
      });
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      connection = null;
      core?.onClientGone(conn);
    });
  });
}
