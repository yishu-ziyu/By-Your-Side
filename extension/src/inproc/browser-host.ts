/** offscreen 入口：配置与端口留在扩展，任务和语音走同一份宿主核心。 */
import { createConversationRuntime, RealtimeVoiceSession, startHostCore, type ClientConn, type HostCore } from "@sideagent/agent/browser-core";
import { HOST_VERSION, PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, type ClientMessage, type ServerMessage } from "../../../shared/protocol.js";
import type { TaskActionRequest, TaskReceipt } from "../../../shared/task-actions.js";
import type { createModelRuntime, ModelRuntime } from "./model-runtime.js";
import { INPROC_KEEPALIVE_MS, INPROC_PORT_NAME, type InprocModelConfig, type StoredCredentials } from "./shared.js";
import { BrowserSocket } from "./voice/browser-socket.js";
import { VoiceCaptureRecorder } from "../../../shared/voice-capture-core.js";
import { createVoiceCaptureSink } from "../shared/trace-store.js";

type Inbound = ClientMessage
  | { type: "inproc_config"; config: InprocModelConfig | null; credentials: StoredCredentials }
  | { type: "inproc_voice"; configured: boolean };

export interface InprocHostDeps {
  createRuntime: typeof createModelRuntime;
  onConnect: (listener: (port: chrome.runtime.Port) => void) => void;
}

export function startInprocHost(deps: InprocHostDeps): void {
  let port: chrome.runtime.Port | null = null;
  let connection: ClientConn | null = null;
  let core: HostCore | null = null;
  let pendingCore: Promise<HostCore> | null = null;
  let selected: InprocModelConfig | null = null;
  let voiceConfigured = false;
  let helloReceived = false;
  /** 配置模型前侧栏发来的新建会话：核心启动后补处理，否则侧栏一直「正在新建会话」。 */
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

    const modelPort = models.createCoreModels(() => selected);
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
    pendingCore = startHostCore({
      createRuntime: (id, emit, summary) => createConversationRuntime(id, emit, summary?.model ?? currentPattern(), {
        loop: { models: modelPort, cwd: "/" }, mode: summary?.mode,
        fallbackModelPattern: "zai-coding-cn/glm-5.3-flash",
      }),
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
    }).then(value => {
      core = value;

      if (connection) core.adoptClient(connection);

      return value;
    }).finally(() => { pendingCore = null; });

    return pendingCore;
  }

  function sendUnavailable(message: ClientMessage): void {
    if (message.type === "hello") {
      connection?.send({ type: "hello_ok", version: PROTOCOL_VERSION, models: [], hostVersion: HOST_VERSION, extensionVersion: "0.1.0", storageSchema: STORAGE_SCHEMA_VERSION });
      connection?.send({ type: "conversation_list", conversations: [] });

      return;
    }

    if (message.type === "conversation_list") {
      connection?.send({ type: "conversation_list", requestId: message.requestId, conversations: [] });

      return;
    }

    if (message.type === "conversation_create") {
      deferredCreates.push(message);

      return;
    }

    if (message.type === "consent_list") {
      connection?.send({ type: "consent_list", conversationId: message.conversationId, requests: [] });

      return;
    }

    if (message.type === "task_action") {
      const request: TaskActionRequest = message.request;
      const detail = "还没有配置模型：打开右上角「更多 → 模型与语音」选择服务商。";

      const receipt: TaskReceipt = {
        requestId: request.requestId, conversationId: request.conversationId, source: request.source,
        action: request.action, runId: null, text: request.text ?? "", targetTitle: request.context?.title ?? "",
        status: "rejected", message: detail, updatedAt: Date.now(),
      };

      connection?.send({ type: "agent_event", conversationId: request.conversationId, event: { kind: "notice", message: detail, receipt } });

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
      await models.credentials.load(message.credentials ?? {});

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

    if (message.type === "hello") helloReceived = true;

    if (!selected) { sendUnavailable(message);

 return; }

    if (!core) await ensureCore();

    if (!core) { sendUnavailable(message);

 return; }

    if (message.type === "hello") core.sendHelloOk(connection!);
    else core.handleMessage(message);
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
