/**
 * 上行连接管理：background service worker ⇆ 伴随进程。
 * 优先 native messaging（connectNative，Chrome 自动拉起伴随进程）；
 * host 未安装/启动失败时回退 WebSocket 调试通道（127.0.0.1:7758，token 见 chrome.storage）。
 * 认证失败（hello_error）时停止自动重连，等面板更新配置后触发 retry()。
 */
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../../shared/protocol.js";
import type { ConnState, TransportKind } from "../relay.js";

export const NATIVE_HOST_NAME = "com.sideagent.host";
const TOKEN_KEY = "sideagent_token";

export interface UplinkHandlers {
  onServerMessage(msg: ServerMessage): void;
  onConnState(state: ConnState, transport: TransportKind | undefined, detail?: string): void;
}

export class Uplink {
  private readonly handlers: UplinkHandlers;
  private nativePort: chrome.runtime.Port | null = null;
  private ws: WebSocket | null = null;
  private transport: TransportKind | null = null;
  private retryAttempt = 0;
  private authFailed = false;

  constructor(handlers: UplinkHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    void this.connectNative();
  }

  /** 面板请求重连（如更新了 ws token）。 */
  retry(): void {
    this.authFailed = false;
    this.retryAttempt = 0;
    this.teardown();
    void this.connectNative();
  }

  /** 已建立连接时发送并返回 true；控制权事务用 false 阻止本地提前提交。 */
  sendClientMessage(msg: ClientMessage): boolean {
    try {
      if (this.transport === "native" && this.nativePort) {
        this.nativePort.postMessage(msg);
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
      this.nativePort?.disconnect();
    } catch {
      /* 忽略 */
    }
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.nativePort = null;
    this.ws = null;
    this.transport = null;
  }

  private handleRaw(raw: unknown): void {
    // native 通道收到的是已反序列化的对象；统一 stringify 后走协议守卫
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

  private handleDisconnect(detail: string | undefined): void {
    const wasTransport = this.transport;
    this.teardown();
    if (this.authFailed) {
      this.handlers.onConnState("disconnected", wasTransport ?? undefined, detail ?? "认证失败");
      return;
    }
    this.handlers.onConnState("connecting", undefined, detail);
    const delay = Math.min(15_000, 1000 * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    setTimeout(() => void this.connectNative(), delay);
  }

  private async connectNative(): Promise<void> {
    if (this.authFailed) return;
    this.teardown();
    this.handlers.onConnState("connecting", undefined);

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      await this.connectWs(`native host 不可用：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.nativePort = port;
    this.transport = "native";

    let everConnected = false;
    port.onMessage.addListener((raw: unknown) => {
      everConnected = true;
      this.handleRaw(raw);
    });
    port.onDisconnect.addListener(() => {
      if (this.nativePort !== port) return;
      const detail = chrome.runtime.lastError?.message;
      if (everConnected) {
        // 曾经连上过：host 崩溃或被回收，走重连
        this.handleDisconnect(detail ?? "伴随进程连接断开");
      } else {
        // 连 hello 都没回：host 未安装或启动失败，回退 ws 调试通道
        this.nativePort = null;
        this.transport = null;
        void this.connectWs(detail ?? "native host 未安装");
      }
    });

    // native 模式无 token，身份由 host manifest 的 allowed_origins 保证
    port.postMessage({ type: "hello", token: "", client: "sidepanel" });
  }

  private async connectWs(reason: string): Promise<void> {
    if (this.authFailed) return;
    const stored = await chrome.storage.local.get(TOKEN_KEY);
    const token = typeof stored[TOKEN_KEY] === "string" ? stored[TOKEN_KEY] : "";
    if (!token) {
      // 没 token 连 ws 也必败，直接停住等用户在面板里设置
      this.handlers.onConnState(
        "disconnected",
        undefined,
        `${reason}；且未配置 ws 调试 token。安装 native host（npm run install:host）或在面板设置 token`,
      );
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
      ws.send(JSON.stringify({ type: "hello", token, client: "sidepanel" }));
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
