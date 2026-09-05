/**
 * 扩展内部通道：side panel ⇆ background service worker。
 * 与 shared/protocol.ts（扩展 ⇆ 伴随进程）不同，本文件只是 panel 与 background 之间的
 * 转发约定，走 chrome.runtime Port。
 */
import type { AgentMode, ClientMessage, ServerMessage } from "../../shared/protocol.js";

export const PANEL_PORT_NAME = "sideagent-panel";

/** 伴随进程连接状态（background 维护，面板只展示）。 */
export type ConnState = "connecting" | "connected" | "disconnected";

/** 上行传输：native messaging（默认）或 ws（调试回退）。 */
export type TransportKind = "native" | "ws";

/** 侧栏能够回放的伴随进程消息；执行调用和握手/模型元数据不进入历史。 */
export type PanelHistoryServerMessage = Extract<ServerMessage, { type: "status" | "agent_event" | "team_status" }>;

/** 关闭侧栏后仍需要恢复的可见内容。 */
export type PanelHistoryItem =
  | { kind: "user"; text: string }
  | { kind: "server"; msg: PanelHistoryServerMessage };

/** background 分配的单调序号是增量同步游标。 */
export interface PanelHistoryEntry {
  seq: number;
  item: PanelHistoryItem;
}

export type PanelToBg =
  /** 转发一条协议消息给伴随进程（user_message / steer / abort）。 */
  | { kind: "client"; msg: ClientMessage }
  /** 控制权动作由 background 补 requestId 与当前页面快照后再上行。 */
  | { kind: "control"; action: "takeover" | "handback" }
  /** 面板（重）打开，请求同步状态；afterSeq 存在时只补发更新的可见历史。 */
  | { kind: "sync"; afterSeq?: number }
  /** 连接配置已变更（如 ws 调试模式更新了 token），请重连。 */
  | { kind: "retry" };

export type BgToPanel =
  /** 来自伴随进程的协议消息（tool_call 不经面板，由 background 直接执行）。 */
  | { kind: "server"; msg: ServerMessage }
  /** 连接状态变化。 */
  | { kind: "conn"; state: ConnState; transport?: TransportKind; detail?: string }
  /** 当前 Agent 运行模式（教学模式开关状态同步）。 */
  | { kind: "mode"; mode: AgentMode }
  /** 面板关闭期间积累的、按 seq 排序的可见历史。 */
  | { kind: "history"; entries: PanelHistoryEntry[] };
