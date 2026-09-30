/**
 * 上行连接管理：background service worker ⇆ 扩展内 agent（offscreen 文档，见 ../inproc/）。
 * 本机伴随进程（Native Messaging）已随本机模式退役；offscreen 文档建不起来且配了 token 时，
 * 才回退 WebSocket 调试通道（只给测试用，见 connectWs）。
 * 认证失败（hello_error）时停止自动重连，等面板更新配置后触发 retry()。
 */
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  STORAGE_SCHEMA_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../../shared/protocol.js";
import type { ConnState, TransportKind } from "../relay.js";
import {
  INPROC_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, INPROC_FAST_CONFIG_KEY, INPROC_DOCUMENT, INPROC_PORT_NAME, INPROC_VOICE_KEY, installVoiceHeaderRule, pickCredentials, resolveVoiceKey, type StoredCredential,
} from "../inproc/shared.js";

const TOKEN_KEY = "sideagent_token";

export interface UplinkHandlers {
  onServerMessage(msg: ServerMessage): void;
  onConnState(state: ConnState, transport: TransportKind | undefined, detail?: string): void;
}

export class Uplink {
  private readonly handlers: UplinkHandlers;
  private inprocPort: chrome.runtime.Port | null = null;
  private ws: WebSocket | null = null;
  private transport: TransportKind | null = null;
  private retryAttempt = 0;
  private authFailed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 正在建 offscreen 文档：同时到达的第二次连接不再重复创建（重复创建会失败并误拆活连接）。 */
  private connecting = false;

  constructor(handlers: UplinkHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    // 设置里改了模型，立刻推给扩展内 agent，不用重连。
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const keys = Object.keys(changes);

      if (keys.some((key) => key === INPROC_CONFIG_KEY || key === INPROC_FAST_CONFIG_KEY || key.startsWith(INPROC_CREDENTIAL_PREFIX))) void this.pushModelConfig();

      // 语音 key 可能沿用阶跃星辰模型的凭据，所以凭据变了也要重算。
      if (keys.some((key) => key === INPROC_VOICE_KEY || key.startsWith(INPROC_CREDENTIAL_PREFIX))) void this.pushVoiceKey();
    });
    void this.connectInproc();
  }

  /** 面板请求重连（如更新了 ws token）。 */
  retry(): void {
    this.authFailed = false;
    this.retryAttempt = 0;
    this.clearReconnectTimer();
    this.teardown();
    void this.connectInproc();
  }

  /** 已建立连接时发送并返回 true；控制权事务用 false 阻止本地提前提交。 */
  sendClientMessage(msg: ClientMessage): boolean {
    try {
      if (this.transport === "inproc" && this.inprocPort) {
        this.inprocPort.postMessage(msg);

        return true;
      }

      if (this.transport === "ws" && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));

        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  private teardown(): void {
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }

    try {
      this.inprocPort?.disconnect();
    } catch {
      /* 忽略 */
    }

    this.inprocPort = null;
    this.ws = null;
    this.transport = null;
  }

  private handleRaw(raw: unknown): void {
    // port 通道收到的是已反序列化的对象；统一 stringify 后走协议守卫
    const msg = parseServerMessage(typeof raw === "string" ? raw : JSON.stringify(raw));

    if (!msg) return;

    if (msg.type === "hello_ok") {
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
    // 旧连接的断开可能晚于新连接建立：重连定时器不得掐掉已经活着的新连接（否则刚恢复的任务会被再次打断）。
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.transport !== null) return;
      void this.connectInproc();
    }, delay);
  }

  /** offscreen 文档里的扩展内 agent 讲同一套协议。 */
  private async connectInproc(): Promise<void> {
    if (this.authFailed || this.connecting) return;

    // 重连定时器或面板 retry 到达时，已有一个活的传输就不再拆掉它重建。
    if (this.transport !== null) return;
    this.teardown();
    this.handlers.onConnState("connecting", undefined);
    this.connecting = true;

    try {
      const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });

      if (existing.length === 0) {
        await chrome.offscreen.createDocument({ url: INPROC_DOCUMENT, reasons: [chrome.offscreen.Reason.WORKERS], justification: "Run the agent loop inside the extension" });
      }
    } catch (err) {
      this.connecting = false;
      const detail = `扩展内 agent 启动失败：${err instanceof Error ? err.message : String(err)}`;

      // 配了 ws 调试 token 才走调试通道；否则按退避重试扩展内 agent（例如 offscreen 刚崩溃、还没关干净时重建失败），
      // 不能停在「未连接」等用户重载扩展。
      await this.connectWs(detail);

      return;
    }

    this.connecting = false;

    if (this.transport !== null) return;
    const port = chrome.runtime.connect({ name: INPROC_PORT_NAME });
    this.inprocPort = port;
    this.transport = "inproc";
    port.onMessage.addListener((raw) => {
      // 心跳只为让 service worker 保持存活；刷新后的订阅令牌落盘。两者都不转给侧栏。
      if (isKeepalive(raw)) return;

      if (isCredentialWrite(raw)) void persistCredential(raw.providerId, raw.credential);
      else this.handleRaw(raw);
    });
    port.onDisconnect.addListener(() => {
      if (this.inprocPort !== port) return;
      this.handleDisconnect(chrome.runtime.lastError?.message ?? "扩展内 agent 连接断开");
    });
    await this.pushModelConfig();
    await this.pushVoiceKey();
    port.postMessage({ type: "hello", token: "", client: "sidepanel", protocol: PROTOCOL_VERSION, extensionVersion: "0.2.0", storageSchema: STORAGE_SCHEMA_VERSION });
  }

  /** 模型选择与各家凭据一起发：offscreen 文档读不到 chrome.storage。 */
  private async pushModelConfig(): Promise<void> {
    if (!this.inprocPort) return;
    const stored = await chrome.storage.local.get(null);
    this.inprocPort?.postMessage({ type: "inproc_config", config: stored[INPROC_CONFIG_KEY] ?? null, fast: stored[INPROC_FAST_CONFIG_KEY] ?? null, credentials: pickCredentials(Object.entries(stored)) });
  }

  private async pushVoiceKey(): Promise<void> {
    const configured = await installVoiceHeaderRule(resolveVoiceKey(Object.entries(await chrome.storage.local.get(null)))).catch(() => false);
    this.inprocPort?.postMessage({ type: "inproc_voice", configured });
  }

  /**
   * WebSocket 调试回退：只给测试用。accept:journeys、P0 本地运行把 Node 里的会话管理接到隔离扩展上，
   * 靠这条通道（脚本先让 offscreen 文档建不起来、再写 token）。这些检查改到扩展里跑之后删除，见 docs/STATUS.md。
   */
  private async connectWs(reason: string): Promise<void> {
    if (this.authFailed) return;

    if (this.transport !== null) return;
    const stored = await chrome.storage.local.get(TOKEN_KEY);

    if (this.transport !== null) return;
    const token = typeof stored[TOKEN_KEY] === "string" ? stored[TOKEN_KEY] : "";

    if (!token) {
      this.handleDisconnect(reason);

      return;
    }

    let ws: WebSocket;

    try {
      ws = new WebSocket(`ws://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    } catch {
      this.handleDisconnect(reason);

      return;
    }

    this.ws = ws;
    this.transport = "ws";

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", token, client: "sidepanel", protocol: PROTOCOL_VERSION, extensionVersion: "0.2.0", storageSchema: STORAGE_SCHEMA_VERSION }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data === "string") this.handleRaw(e.data);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.handleDisconnect(`ws 调试通道断开（${reason}）`);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    };
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
