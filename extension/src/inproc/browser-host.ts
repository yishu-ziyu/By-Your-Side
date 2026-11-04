import { createConversationRuntime, GptLiveSession, LearnedOperationStore, MemoryStore, RealtimeVoiceSession, SiteNotesStore, TaskHistoryStore, startHostCore, useMemoryHabits, usePausedMemory, usePendingMemoryJudgments, useSemanticMemory, useStyleSignals, type ArtifactPersistence, type ClientConn, type DocumentPersistence, type HostCore } from "@sideagent/agent/browser-core";
import type { SessionLogPort } from "@sideagent/agent/browser-core";
import { BrowserSemanticMemory } from "./semantic-memory.js";
import { HOST_VERSION, PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION, type ClientMessage, type ServerMessage } from "../../../shared/protocol.js";
import { describeModelError } from "../../../shared/user-facing.js";
import type { TaskActionRequest, TaskReceipt } from "../../../shared/task-actions.js";
import { PROBE_TIMEOUT_MS, probeModel, type createModelRuntime, type ModelRuntime } from "./model-runtime.js";
import { GPT_LIVE_MODEL } from "../../../shared/voice.js";
import { CUSTOM_ENDPOINT_ENV, INPROC_KEEPALIVE_MS, INPROC_PORT_NAME, modelCredential, resolveVoiceModel, type InprocModelConfig, type StoredCredentials } from "./shared.js";
import { BrowserSocket } from "./voice/browser-socket.js";
import { VoiceCaptureRecorder } from "../../../shared/voice-capture-core.js";
import { createVoiceCaptureSink } from "../shared/trace-store.js";
import { openConversationStore } from "./conversation-store.js";
import { listArtifacts, writeArtifact, deleteArtifact } from "../shared/durable-store.js";
import { openPiSession } from "./pi-session-idb.js";
import { openDurableStorage } from "./durable-storage.js";
import { IdbDocument } from "./document-idb.js";
import { pushedMiniApps, pushedSelfUse, pushedTranslationStyle, pushedContinuation, receiveCoreSettings } from "../shared/core-settings.js";
import { credentialContents, modelConfig } from "../settings/connections.js";

type FileReadModule = typeof import("../sidepanel/file-read/index.js");

let fileReadModule: Promise<FileReadModule> | null = null;

function loadFileRead(): Promise<FileReadModule> {
  fileReadModule ??= import(chrome.runtime.getURL("file-read.js")) as Promise<FileReadModule>;
  fileReadModule.catch(() => { fileReadModule = null; });

  return fileReadModule;
}

function originalBytes(dataBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  return bytes;
}

type Inbound = ClientMessage
  | { type: "inproc_config"; config: InprocModelConfig | null; fast?: InprocModelConfig | null; backup?: InprocModelConfig | null; connections?: unknown; credentials: StoredCredentials; codexCatalog?: unknown }
  | { type: "inproc_catalog"; codexCatalog?: unknown }
  | { type: "inproc_settings"; values: unknown }
  | { type: "inproc_voice"; configured: boolean; model?: unknown }
  | { type: "inproc_key_save_result"; requestId: string; ok: boolean };

interface InprocHostDeps {
  createRuntime: typeof createModelRuntime;
  sessionData?: (id: string) => Promise<{ session: SessionLogPort; files?: ArtifactPersistence }>;
  document?: (name: "memories" | "pending-memory" | "tasks" | "habits" | "site-notes" | "style-signals" | "learned-operations") => DocumentPersistence;
  onConnect: (listener: (port: chrome.runtime.Port) => void) => void;
}

function readOnlyWhileSelfUse(doc: DocumentPersistence): DocumentPersistence {
  return {
    read: () => doc.read(),
    exclusive: fn => doc.exclusive(fn),
    write: async (text, commitGuard) => { if (!pushedSelfUse()) await doc.write(text, commitGuard); },
  };
}

export function startInprocHost(deps: InprocHostDeps): void {

  let port: chrome.runtime.Port | null = null;
  let connection: ClientConn | null = null;
  let core: HostCore | null = null;
  let pendingCore: Promise<HostCore> | null = null;
  let selected: InprocModelConfig | null = null;
  let fastSelected: InprocModelConfig | null = null;
  let backupSelected: InprocModelConfig | null = null;
  let storedCredentials: StoredCredentials = {};
  let storedConnections: Record<string, InprocModelConfig> = {};
  const pendingKeySaves = new Map<string, { conversationId: string; roles: string; connection: string; provider: string; before: string; after: string }>();
  const cancelledKeySaves = new Set<string>();
  const savedKeyTransactions = new Map<string, { requestId: string; runId: string; target: string; roles: string; connection: string; credential: string }>();
  const keySaveReplies = new Map<string, (ok: boolean) => void>();
  const cancelKeySave = (id: string) => { cancelledKeySaves.add(id); try { port?.postMessage({ type: "inproc_key_cancel", requestId: id }); } catch {  } };
  let voiceConfigured = false;
  let voiceModel: unknown;
  let helloReceived = false;
  const deferredCreates: ClientMessage[] = [];

  const log = (message: string) => console.debug("[sideagent]", message);
  const voiceCapture = new VoiceCaptureRecorder(createVoiceCaptureSink(log), log);

  const models: ModelRuntime = deps.createRuntime((providerId, credential) => {
    port?.postMessage({ type: "inproc_credential", providerId, credential: credential ?? null });
  });
  void models.loadProviderModels().catch((error: unknown) => log(`provider model list unavailable: ${String(error)}`));

  async function ensureCore(): Promise<HostCore> {
    if (core) return core;

    if (!selected) throw new Error("还没有连接模型。打开「更多 → 模型与语音」，选一个服务商。");

    if (pendingCore) return pendingCore;

    const modelPort = models.createCoreModels(() => selected, () => fastSelected, () => backupSelected);
    let pattern = "";

    const currentPattern = () => {
      if (selected) {
        const model = models.resolveModel(selected);
        pattern = `${model.provider}/${model.id}`;
      }

      return pattern;
    };

    currentPattern();
    const document = deps.document ?? ((name: string) => new IdbDocument(name));
    const personal = (name: Parameters<typeof document>[0]) => readOnlyWhileSelfUse(document(name));
    const memoryStore = useSemanticMemory(usePausedMemory(useStyleSignals(useMemoryHabits(usePendingMemoryJudgments(new MemoryStore(personal("memories")), personal("pending-memory")), personal("habits")), personal("style-signals")), pushedSelfUse), new BrowserSemanticMemory());
    const taskHistory = new TaskHistoryStore(personal("tasks"));
    const siteNotes = new SiteNotesStore(document("site-notes"));
    const learnedOperations = new LearnedOperationStore(document("learned-operations"));
    pendingCore = openConversationStore(log).then(store => startHostCore({
      continuationEnabled: pushedContinuation,
      siteNotes,
      store,
      memoryStore,
      taskHistory,
      learnedOperations,
      createRuntime: async (id, emit, summary) => {
        const data = deps.sessionData ? await deps.sessionData(id) : {
          session: await openPiSession(id),
          files: {load:()=>listArtifacts(id),save:(item: Parameters<ArtifactPersistence["save"]>[0])=>writeArtifact(id,item),delete:(filename:string)=>deleteArtifact(id,filename)},
        };

        return createConversationRuntime(id, emit, summary?.model ?? currentPattern(), {
        loop: { models: modelPort, cwd: "/", session: data.session, openStorage: openDurableStorage },
        artifactPersistence: data.files,
        memoryStore,
        taskHistory,
        learnedOperations,
        miniApps: async () => pushedMiniApps(),
        continuationEnabled: pushedContinuation,
        translationStyle: () => pushedTranslationStyle(),
        readDownloadedFile: async input => {
          const read = await loadFileRead();
          const file = new File([originalBytes(input.dataBase64)], input.name, { type: input.mimeType });

          return read.readAttachmentFile(file, input.id);
        },
        });
      },
      voiceKey: async () => {
        if (resolveVoiceModel(voiceModel) === GPT_LIVE_MODEL) return chatgptAccess();

        if (!voiceConfigured) throw new Error("还没有语音密钥。打开「更多 → 模型与语音」，在「语音对话」里填阶跃星辰密钥。");

        return "injected-by-extension";
      },
      voiceSession: voiceDeps => {
        const model = resolveVoiceModel(voiceModel);

        if (model === GPT_LIVE_MODEL) return new GptLiveSession(voiceDeps);

        return new RealtimeVoiceSession({
          ...voiceDeps,
          model,
          connect: () => new BrowserSocket(model) as never,
        });
      },
      observe: msg => { if (msg.type === "voice" && msg.event.kind === "diag") voiceCapture.record(msg.voiceId, msg.conversationId ?? "default", msg.event.record); },
      onVoiceCommand: (msg, conversationId) => {
        if (msg.command.kind === "capture") {
          voiceCapture.command(msg.voiceId, conversationId, msg.command);

          return true;
        }

        if (msg.command.kind === "timing") {
          voiceCapture.timing(msg.voiceId, conversationId, msg.command);

          return true;
        }

        if (msg.command.kind === "start") voiceCapture.begin(msg.voiceId, conversationId, { persistAudio: false });

        return false;
      },
      voiceDiagnostic: (event, fields) => voiceCapture.host(event, fields),
      log,
    })).then(value => {
      core = value;

      if (connection) core.adoptClient(connection);

      return value;
    }).finally(() => { pendingCore = null; });

    return pendingCore;
  }

  async function chatgptAccess(): Promise<string> {
    const missing = "GPT-Live 要先在设置里用 ChatGPT 登录：打开右上角「更多 → 模型与语音」登录后再开启语音。";

    if ((await models.credentials.read("openai-codex"))?.type !== "oauth") throw new Error(missing);
    const access = await models.models.getAuth("openai-codex").then(result => result?.auth.apiKey, () => undefined);

    if (!access) throw new Error(missing);

    return access;
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

    if (message.type === "conversation_create") {
      if (message.reading) deferredCreates.push(message);

      return;
    }

    if (message.type === "task_action") {
      const request: TaskActionRequest = message.request;
      const detail = "还没有连接模型。打开「更多 → 模型与语音」，选一个服务商。";

      const receipt: TaskReceipt = {
        requestId: request.requestId, conversationId: request.conversationId, source: request.source,
        action: request.action, runId: null, text: request.text ?? "", targetTitle: request.context?.title ?? "",
        status: "rejected", message: detail, updatedAt: Date.now(), needsModel: true,
      };

      connection?.send({ type: "agent_event", conversationId: request.conversationId, event: { kind: "notice", message: detail, receipt } });

      return;
    }

    if (message.type === "warm_up") return;

    if (message.type === "nudge_request") {
      connection?.send({ type: "nudge_result", requestId: message.requestId, nudge: null });

      return;
    }

    if (message.type === "browse_habit_ask") return;

    if (message.type === "browse_habit_request") {
      connection?.send({ type: "browse_habit_result", requestId: message.requestId, habits: [] });

      return;
    }

    if (message.type !== "task_view_query" && message.type !== "task_receipt_query") {
      connection?.send({ type: "agent_event", conversationId: message.conversationId, event: { kind: "error", message: "先在「模型与语音」里连接模型。" } });
    }
  }

  async function handle(message: Inbound): Promise<void> {
    if (message.type === "inproc_key_save_result") return;
    if (message.type === "inproc_catalog") {
      await models.applyCodexCatalog(message.codexCatalog);
      if (core && connection) connection.send({ type: "model_info", models: await core.session.availableModels() });
      return;
    }
    if (message.type === "inproc_voice") {
      voiceConfigured = message.configured;
      voiceModel = message.model;

      return;
    }

    if (message.type === "inproc_settings") {
      receiveCoreSettings(message.values);

      return;
    }

    if (message.type === "inproc_config") {
      const mainChanged = JSON.stringify(selected) !== JSON.stringify(message.config);
      selected = message.config;
      fastSelected = message.fast ?? null;
      backupSelected = message.backup ?? null;
      storedConnections = readConnectionMap(message.connections);
      storedCredentials = message.credentials ?? {};
      await models.credentials.load(storedCredentials);
      await models.applyCodexCatalog(message.codexCatalog);

      if (!selected) return;
      const model = models.resolveModel(selected);

      if (core) {
        if (mainChanged) for (const conversation of core.conversations.list()) {
          await core.conversations.handleMessage({ type: "set_model", conversationId: conversation.id, model: `${model.provider}/${model.id}` });
        }
      } else {
        const coreStarted = performance.now();
        const started = await ensureCore();
        performance.measure('sideagent.startup.core', { start: coreStarted });

        if (helloReceived && connection) started.sendHelloOk(connection);

        for (const create of deferredCreates.splice(0)) started.handleMessage(create);
      }

      return;
    }

    if (message.type === "voice" && message.command.kind === "start") {
      try {
        resolveVoiceModel(voiceModel);

        if ((message.command.model ?? null) !== (typeof voiceModel === "string" ? voiceModel : null)) throw new Error("语音模型设置刚改过，还没生效：请再开一次语音。");

        if (message.command.diagnostic && voiceModel === GPT_LIVE_MODEL) throw new Error("GPT-Live 不支持诊断录音：先在「模型与语音」换回阶跃星辰语音。");
      }
      catch (error) {
        connection?.send({ type: "voice", voiceId: message.voiceId, conversationId: message.conversationId,
          event: { kind: "state", state: "error", detail: error instanceof Error ? error.message : String(error) } });

        return;
      }
    }

    if (message.type === "model_key_test") { void testKey(message);

 return; }

    if (message.type === "model_key_save") { void saveKey(message); return; }

    if (message.type === "retry_after_error" && message.target) {
      const config = configuredTarget(message.target);
      const conversationId = message.conversationId ?? "default";
      const saved = savedKeyTransactions.get(conversationId);
      savedKeyTransactions.delete(conversationId);
      const matchesSaved = saved && saved.requestId === message.keySaveRequestId && saved.runId === message.expectedRunId
        && saved.target === JSON.stringify(modelConfig(config)) && saved.roles === JSON.stringify([selected, fastSelected, backupSelected].map(modelConfig))
        && saved.connection === JSON.stringify(storedConnections[message.target.provider] ?? null)
        && saved.credential === credentialContents(storedCredentials[message.target.provider]);
      if (!matchesSaved || !config || !sameErrorTask(message.conversationId, message.expectedRunId) || !core?.conversations.get(conversationId)?.runtime.session.matchesModelConnection(config)) {
        connection?.send({ type: "agent_event", conversationId: message.conversationId, event: { kind: "error", message: "原模型连接已变化，没有继续。请重新检查连接。" } });
        return;
      }
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

  function sameErrorTask(conversationId: string | undefined, runId: string | undefined): boolean {
    const task = core?.conversations.getTaskProgress(conversationId ?? "default");
    return !!runId && task?.runId === runId && task.state === "error";
  }

  function readConnectionMap(value: unknown): Record<string, InprocModelConfig> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, InprocModelConfig> = {};
    for (const [provider, raw] of Object.entries(value)) { const config = modelConfig(raw); if (config?.provider === provider) result[provider] = config; }
    return result;
  }

  function configuredTarget(target: { provider: string; modelId: string; baseUrl?: string } | undefined): InprocModelConfig | null {
    if (!target) return null;
    const credential = storedCredentials[target.provider];
    const boundEndpoint = credential?.type === "api_key" ? credential.env?.[CUSTOM_ENDPOINT_ENV] : undefined;
    if (target.provider === "custom" && boundEndpoint && boundEndpoint !== target.baseUrl) return null;
    const matches = [selected, fastSelected, backupSelected].filter(config => config && config.provider === target.provider && config.modelId === target.modelId && config.baseUrl === target.baseUrl);
    if (matches[0]) return matches[0];
    const connection = storedConnections[target.provider];
    if (connection && connection.baseUrl === target.baseUrl) return { ...connection, modelId: target.modelId };
    if (target.provider !== "custom" && target.baseUrl === undefined && storedCredentials[target.provider]) return { provider: target.provider, modelId: target.modelId };
    return null;
  }

  async function saveKey(message: Extract<ClientMessage, { type: "model_key_save" }>): Promise<void> {
    const reply = (ok: boolean) => connection?.send({ type: "model_key_save_result", conversationId: message.conversationId, requestId: message.requestId, ok });
    try {
      const config = configuredTarget(message.target);
      if (cancelledKeySaves.has(message.requestId) || !config || !sameErrorTask(message.conversationId, message.expectedRunId) || !core?.conversations.get(message.conversationId ?? "default")?.runtime.session.matchesModelConnection(config) || !port) { reply(false); return; }
      const ok = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { keySaveReplies.delete(message.requestId); cancelKeySave(message.requestId); resolve(false); }, 9_000);
        keySaveReplies.set(message.requestId, value => { clearTimeout(timer); resolve(value); });
        port?.postMessage({ ...message, type: "inproc_key_save" });
      });
      const stillCurrent = !cancelledKeySaves.has(message.requestId) && sameErrorTask(message.conversationId, message.expectedRunId) && core?.conversations.get(message.conversationId ?? "default")?.runtime.session.matchesModelConnection(config) === true;
      log(`key-save: ${JSON.stringify({ stored: ok, cancelled: cancelledKeySaves.has(message.requestId), sameTask: sameErrorTask(message.conversationId, message.expectedRunId), sameModel: core?.conversations.get(message.conversationId ?? "default")?.runtime.session.matchesModelConnection(config) === true })}`);
      if (ok && stillCurrent) savedKeyTransactions.set(message.conversationId ?? "default", { requestId: message.requestId, runId: message.expectedRunId, target: JSON.stringify(modelConfig(config)), roles: message.roles, connection: message.connection, credential: credentialContents(modelCredential(config, message.key)) });
      reply(ok && stillCurrent);
    } catch (error) { log(`key-save: storage failure: ${(error instanceof Error ? error.name : "unknown")}`); reply(false); }
    finally { pendingKeySaves.delete(message.requestId); cancelledKeySaves.delete(message.requestId); }
  }

  async function testKey(message: Extract<ClientMessage, { type: "model_key_test" }>): Promise<void> {
    const reply = (result: { ok: boolean; ms?: number; reason?: string; detail?: string }) =>
      connection?.send({ type: "model_key_test_result", conversationId: message.conversationId, requestId: message.requestId, ...result });

    const config = configuredTarget(message.target);
    if (!config || !sameErrorTask(message.conversationId, message.expectedRunId) || !core?.conversations.get(message.conversationId ?? "default")?.runtime.session.matchesModelConnection(config)) return reply({ ok: false, reason: "原连接已变化，请重新打开并核对。" });
    const binding = JSON.stringify([selected, fastSelected, backupSelected, storedConnections[config.provider], storedCredentials[config.provider]]);
    const started = performance.now();
    const probe = deps.createRuntime(() => undefined);
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);

    try {
      await probe.credentials.load({ ...storedCredentials, [config.provider]: modelCredential(config, message.key) });
      await probeModel(probe, config, timeout);
      if (binding !== JSON.stringify([selected, fastSelected, backupSelected, storedConnections[config.provider], storedCredentials[config.provider]]) || !configuredTarget(message.target) || !sameErrorTask(message.conversationId, message.expectedRunId) || !core?.conversations.get(message.conversationId ?? "default")?.runtime.session.matchesModelConnection(config)) return reply({ ok: false, reason: "测试期间连接已变化，请重新打开并核对。" });
      reply({ ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      if (binding !== JSON.stringify([selected, fastSelected, backupSelected, storedConnections[config.provider], storedCredentials[config.provider]]) || !configuredTarget(message.target) || !sameErrorTask(message.conversationId, message.expectedRunId) || !core?.conversations.get(message.conversationId ?? "default")?.runtime.session.matchesModelConnection(config)) return reply({ ok: false, reason: "测试期间连接已变化，请重新打开并核对。" });
      const raw = (error instanceof Error ? error.message : String(error)).split(message.key).join("[密钥已隐藏]");
      const copy = describeModelError(`模型请求最终失败：${raw}`);

      const reason = timeout.aborted ? `${PROBE_TIMEOUT_MS / 1000} 秒内没有回复，服务商可能正忙，可以再试一次。`
        : copy?.kind === "auth" ? "这个密钥也不能用。服务商不接受它，或它不能用这个模型。" : `${copy?.title ?? "连接失败"}。`;

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
      if (raw.type === "inproc_key_save_result") {
        if (typeof raw.requestId === "string" && typeof raw.ok === "boolean") { keySaveReplies.get(raw.requestId)?.(raw.ok); keySaveReplies.delete(raw.requestId); }
        return;
      }
      if (raw.type === "model_key_cancel") {
        log("key-save: panel cancelled");
        cancelKeySave(raw.requestId);
        if (!pendingKeySaves.has(raw.requestId)) setTimeout(() => cancelledKeySaves.delete(raw.requestId), 30_000);
        return;
      }
      if (raw.type === "model_key_save") pendingKeySaves.set(raw.requestId, { conversationId: raw.conversationId ?? "default", roles: raw.roles, connection: raw.connection, provider: raw.target.provider, before: credentialContents(storedCredentials[raw.target.provider]), after: credentialContents(modelCredential(raw.target, raw.key)) });
      else if (raw.type === "inproc_config") {
        const roles = JSON.stringify([modelConfig(raw.config), modelConfig(raw.fast), modelConfig(raw.backup)]);
        for (const [id, pending] of pendingKeySaves) {
          const credential = credentialContents(raw.credentials?.[pending.provider]);
          const connection = JSON.stringify(readConnectionMap(raw.connections)[pending.provider] ?? null);
          if (roles !== pending.roles || connection !== pending.connection || credential !== pending.before && credential !== pending.after) { log(`key-save: config invalidated ${JSON.stringify({ roles: roles === pending.roles, connection: connection === pending.connection, before: credential === pending.before, after: credential === pending.after })}`); cancelKeySave(id); }
        }
      } else if (raw.type === "set_model" || raw.type === "user_message" || raw.type === "steer" || raw.type === "abort" || raw.type === "task_action") {
        const conversationId = raw.type === "task_action" ? raw.request.conversationId : raw.conversationId ?? "default";
        savedKeyTransactions.delete(conversationId);
        for (const [id, pending] of pendingKeySaves) if (pending.conversationId === conversationId) cancelKeySave(id);
      }
      queue = queue.then(() => handle(raw)).catch(error => {
        conn.send({ type: "agent_event", event: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
      });
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      connection = null;
      savedKeyTransactions.clear();
      for (const id of pendingKeySaves.keys()) cancelKeySave(id);
      core?.onClientGone(conn);
    });
  });
}
