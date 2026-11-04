import {
  PROTOCOL_VERSION,
  STORAGE_SCHEMA_VERSION,
  parseServerMessage,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../../shared/protocol.js";
import type { ConnState, TransportKind } from "../relay.js";
import {
  CODEX_CATALOG_KEY, INPROC_BACKUP_CONFIG_KEY, INPROC_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, INPROC_FAST_CONFIG_KEY, INPROC_DOCUMENT, INPROC_PORT_NAME, INPROC_VOICE_KEY, INPROC_VOICE_MODEL_KEY, installVoiceHeaderRule, modelCredential, pickCredentials, resolveVoiceKey, type StoredCredential,
} from "../inproc/shared.js";
import { CORE_SETTING_KEYS } from "../shared/core-settings.js";
import { CONNECTION_PREFIX, credentialFingerprint, modelConfig, readConnections, withModelSettings } from "../settings/connections.js";

export interface UplinkHandlers {
  onServerMessage(msg: ServerMessage): void;
  onConnState(state: ConnState, transport: TransportKind | undefined, detail?: string): void;
}

export class Uplink {
  private readonly handlers: UplinkHandlers;
  private inprocPort: chrome.runtime.Port | null = null;
  private transport: TransportKind | null = null;
  private retryAttempt = 0;
  private authFailed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private connectStarted = 0;

  constructor(handlers: UplinkHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const keys = Object.keys(changes);

      if (keys.some((key) => key === INPROC_CONFIG_KEY || key === INPROC_FAST_CONFIG_KEY || key === INPROC_BACKUP_CONFIG_KEY || key.startsWith(INPROC_CREDENTIAL_PREFIX) || key.startsWith(CONNECTION_PREFIX))) void this.pushModelConfig();
      if (keys.includes(CODEX_CATALOG_KEY)) void this.pushModelCatalog();

      if (keys.some((key) => CORE_SETTING_KEYS.includes(key))) void this.pushCoreSettings();

      if (keys.some((key) => key === INPROC_VOICE_KEY || key === INPROC_VOICE_MODEL_KEY || key.startsWith(INPROC_CREDENTIAL_PREFIX))) void this.pushVoiceKey();
    });
    void this.connectInproc();
  }
  wake(): void { if (this.transport === null) void this.connectInproc(); }

  retry(): void {
    this.authFailed = false;
    this.retryAttempt = 0;
    this.clearReconnectTimer();
    this.teardown();
    void this.connectInproc();
  }

  sendClientMessage(msg: ClientMessage): boolean {
    try {
      if (this.transport === "inproc" && this.inprocPort) {
        this.inprocPort.postMessage(msg);

        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  private teardown(): void {
    try {
      this.inprocPort?.disconnect();
    } catch {
    }

    this.inprocPort = null;
    this.transport = null;
  }

  private handleRaw(raw: unknown): void {
    const msg = parseServerMessage(typeof raw === "string" ? raw : JSON.stringify(raw));

    if (!msg) return;

    if (msg.type === "hello_ok") {
      performance.measure("sideagent.startup.ready", { start: this.connectStarted });
      this.retryAttempt = 0;
      this.handlers.onConnState("connected", this.transport ?? undefined, msg.model);
    } else if (msg.type === "hello_error") {
      this.authFailed = true;
    }

    this.handlers.onServerMessage(msg);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private handleDisconnect(detail: string | undefined): void {
    const wasTransport = this.transport;
    this.teardown();

    if (this.authFailed) {
      this.clearReconnectTimer();
      this.handlers.onConnState("disconnected", wasTransport ?? undefined, detail ?? "认证失败");

      return;
    }

    this.handlers.onConnState("connecting", undefined, detail);
    const delay = Math.min(15_000, 1000 * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.transport !== null) return;
      void this.connectInproc();
    }, delay);
  }

  private async connectInproc(): Promise<void> {
    if (this.authFailed || this.connecting) return;

    if (this.transport !== null) return;
    this.teardown();
    this.handlers.onConnState("connecting", undefined);
    this.connecting = true;
    this.connectStarted = performance.now();

    try {
      const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });

      if (existing.length === 0) {
        await chrome.offscreen.createDocument({ url: INPROC_DOCUMENT, reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.USER_MEDIA], justification: "Run the agent loop inside the extension and record push-to-talk speech" });
      }
    } catch (err) {
      this.connecting = false;
      const detail = `助手没有启动：${err instanceof Error ? err.message : String(err)}`;

      this.handleDisconnect(detail);

      return;
    }

    this.connecting = false;

    if (this.transport !== null) return;
    const port = chrome.runtime.connect({ name: INPROC_PORT_NAME });
    this.inprocPort = port;
    this.transport = "inproc";
    const keySaves = new Map<string, { cancelled: boolean }>();
    port.onMessage.addListener((raw) => {
      if (raw && typeof raw === "object" && raw.type === "inproc_key_cancel" && typeof raw.requestId === "string") {
        const pending = keySaves.get(raw.requestId);
        if (pending) pending.cancelled = true;
        return;
      }
      if (raw && typeof raw === "object" && raw.type === "inproc_key_save") {
        const message = parseClientMessage(JSON.stringify({ ...raw, type: "model_key_save" }));
        if (!message || message.type !== "model_key_save" || keySaves.has(message.requestId)) return;
        const pending = { cancelled: false };
        keySaves.set(message.requestId, pending);
        void withModelSettings(async () => {
          const roles = [INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY];
          const credentialKey = INPROC_CREDENTIAL_PREFIX + message.target.provider;
          const connectionKey = CONNECTION_PREFIX + message.target.provider;
          const stored = await chrome.storage.local.get([...roles, credentialKey, connectionKey]);
          const configs = roles.map(role => modelConfig(stored[role]));
          const connection = modelConfig(stored[connectionKey]);
          const allowed = configs.some(config => JSON.stringify(config) === JSON.stringify(message.target)) || message.target.provider !== "custom" && !!stored[credentialKey] || !!connection && connection.provider === message.target.provider && connection.baseUrl === message.target.baseUrl;
          if (pending.cancelled || this.inprocPort !== port || JSON.stringify(configs) !== message.roles || JSON.stringify(connection) !== message.connection || !allowed || await credentialFingerprint(stored[credentialKey]) !== message.credentialHash) return false;
          if (pending.cancelled || this.inprocPort !== port) return false;
          await chrome.storage.local.set({ [credentialKey]: modelCredential(message.target, message.key) });
          return true;
        }).then(async ok => {
          try { if (ok) await this.pushModelConfig(); port.postMessage({ type: "inproc_key_save_result", requestId: message.requestId, ok }); }
          catch { try { port.postMessage({ type: "inproc_key_save_result", requestId: message.requestId, ok: false }); } catch {  } }
        }, () => { try { port.postMessage({ type: "inproc_key_save_result", requestId: message.requestId, ok: false }); } catch {  } }).finally(() => keySaves.delete(message.requestId));
        return;
      }
      if (isKeepalive(raw)) return;

      if (isCredentialWrite(raw)) void persistCredential(raw.providerId, raw.credential);
      else this.handleRaw(raw);
    });
    port.onDisconnect.addListener(() => {
      for (const pending of keySaves.values()) pending.cancelled = true;
      if (this.inprocPort !== port) return;
      this.handleDisconnect(chrome.runtime.lastError?.message ?? "助手断开了");
    });
    performance.measure("sideagent.startup.offscreen", { start: this.connectStarted });
    const settingsStarted = performance.now();
    await this.pushCoreSettings();
    await this.pushModelConfig();
    await this.pushVoiceKey();
    performance.measure("sideagent.startup.settings", { start: settingsStarted });
    port.postMessage({ type: "hello", token: "", client: "sidepanel", protocol: PROTOCOL_VERSION, extensionVersion: "0.2.0", storageSchema: STORAGE_SCHEMA_VERSION });
  }

  /** WHY: 模型选择与各家凭据一起发：offscreen 文档读不到 chrome.storage。 */
  private async pushModelConfig(): Promise<void> {
    if (!this.inprocPort) return;
    const stored = await chrome.storage.local.get(null);
    this.inprocPort?.postMessage({ type: "inproc_config", config: stored[INPROC_CONFIG_KEY] ?? null, fast: stored[INPROC_FAST_CONFIG_KEY] ?? null, backup: stored[INPROC_BACKUP_CONFIG_KEY] ?? null, connections: Object.fromEntries(readConnections(stored)), credentials: pickCredentials(Object.entries(stored)), codexCatalog: stored[CODEX_CATALOG_KEY] });
  }

  private async pushModelCatalog(): Promise<void> {
    const stored = await chrome.storage.local.get(CODEX_CATALOG_KEY);
    this.inprocPort?.postMessage({ type: "inproc_catalog", codexCatalog: stored[CODEX_CATALOG_KEY] });
  }

  private async pushCoreSettings(): Promise<void> {
    if (!this.inprocPort) return;
    const values = await chrome.storage.local.get(CORE_SETTING_KEYS);
    this.inprocPort?.postMessage({ type: "inproc_settings", values });
  }

  private async pushVoiceKey(): Promise<void> {
    const stored = await chrome.storage.local.get(null);
    const configured = await installVoiceHeaderRule(resolveVoiceKey(Object.entries(stored))).catch(() => false);
    // WHY: 不在这里修正无效选择：宿主须拒绝启动，不能偷偷回到按量接口。
    this.inprocPort?.postMessage({ type: "inproc_voice", configured, model: stored[INPROC_VOICE_MODEL_KEY] });
  }

}

function isKeepalive(raw: unknown): raw is { type: "inproc_keepalive" } {
  return typeof raw === "object" && raw !== null && "type" in raw && raw.type === "inproc_keepalive";
}

function isCredentialWrite(raw: unknown): raw is { type: "inproc_credential"; providerId: string; credential: StoredCredential | null } {
  return typeof raw === "object" && raw !== null && "type" in raw && raw.type === "inproc_credential" && "providerId" in raw && typeof raw.providerId === "string";
}

async function persistCredential(providerId: string, credential: StoredCredential | null): Promise<void> {
  const key = `${INPROC_CREDENTIAL_PREFIX}${providerId}`;

  if (credential) await chrome.storage.local.set({ [key]: credential });
  else await chrome.storage.local.remove(key);
}
