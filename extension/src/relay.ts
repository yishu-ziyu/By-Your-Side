/**
 * 扩展内部通道：side panel ⇆ background service worker。
 * 与 shared/protocol.ts（扩展 ⇆ 伴随进程）不同，本文件只是 panel 与 background 之间的
 * 转发约定，走 chrome.runtime Port。
 */
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";

export const PANEL_PORT_NAME = "sideagent-panel";

/** 伴随进程连接状态（background 维护，面板只展示）。 */
export type ConnState = "connecting" | "connected" | "disconnected";

/** 上行传输：native messaging（默认）或 ws（调试回退）。 */
export type TransportKind = "native" | "ws";

export type PanelToBg =
  /** 转发一条协议消息给伴随进程（user_message / steer / abort）。 */
  | { kind: "client"; msg: ClientMessage }
  /** 面板（重）打开，请求同步当前连接状态与缓存的 hello_ok/status。 */
  | { kind: "sync" }
  /** 连接配置已变更（如 ws 调试模式更新了 token），请重连。 */
  | { kind: "retry" };

export type BgToPanel =
  /** 来自伴随进程的协议消息（tool_call 不经面板，由 background 直接执行）。 */
  | { kind: "server"; msg: ServerMessage }
  /** 连接状态变化。 */
  | { kind: "conn"; state: ConnState; transport?: TransportKind; detail?: string };
