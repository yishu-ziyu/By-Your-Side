/**
 * 扩展内部通道：side panel ⇆ background service worker。
 * 与 shared/protocol.ts（扩展 ⇆ 伴随进程）不同，本文件只是 panel 与 background 之间的
 * 转发约定，走 chrome.runtime Port。
 */
import type { Attachment, ClientMessage, ServerMessage, ViewportSectionUpdate } from "../../shared/protocol.js";
import type { PendingAsk } from "./shared/ask-selection.js";

export const PANEL_PORT_NAME = "sideagent-panel";

/** 伴随进程连接状态（background 维护，面板只展示）。 */
export type ConnState = "connecting" | "connected" | "disconnected";

/** 上行传输：只有扩展内 agent。 */
export type TransportKind = "inproc";

/** 侧栏能够回放的伴随进程消息；执行调用和握手/模型元数据不进入历史。 */
export type PanelHistoryServerMessage = Extract<ServerMessage, { type: "status" | "agent_event" | "team_status" }>;

/** 关闭侧栏后仍需要恢复的可见内容。 */
export type PanelHistoryItem =
  | { kind: "user"; text: string; attachments?: Attachment[]; undelivered?: { original: ClientMessage }; context?: UserTurnContext }
  | { kind: "server"; msg: PanelHistoryServerMessage };

/** 这一轮随消息带给助手的页面与选段；侧栏画成用户消息下面的 chip。 */
export interface UserTurnContext { title: string; url: string; selection?: string }

/** background 分配的单调序号是增量同步游标。 */
export interface PanelHistoryEntry {
  seq: number;
  /** Original background receipt time; absent on legacy records. */
  occurredAt?: number;
  item: PanelHistoryItem;
}

export type PanelToBg =
  | { kind: "select_conversation"; conversationId: string }
  /** 转发一条协议消息给伴随进程（user_message / steer / abort）。 */
  | { kind: "client"; msg: ClientMessage }
  /** 控制权动作由 background 补 requestId 与当前页面快照后再上行。 */
  | { kind: "control"; action: "takeover" | "handback"; conversationId?: string; tabId?: number }
  /** 面板（重）打开，请求同步状态；afterSeq 存在时只补发更新的可见历史。 */
  | { kind: "sync"; afterSeq?: number; conversationId?: string }
  /** 请重连。 */
  | { kind: "retry" }
  /** 端口存活探测：service worker 被 Chrome 停掉后，面板手里的端口不一定会收到断开事件。 */
  | { kind: "ping" };

export type BgToPanel = BgToPanelPayload & { conversationId?: string };

type BgToPanelPayload =
  | { kind: "page_section"; update: ViewportSectionUpdate | null; tabId: number }
  | { kind: "marginalia"; update: ViewportSectionUpdate; state: import("../../shared/reading.js").ReadingEvent["state"]; text: string; error?: string }
  | { kind: "conversations"; conversations: import("../../shared/protocol.js").ConversationSummary[]; selectedConversationId: string; resumeReading?: boolean }
  /** 来自伴随进程的协议消息（tool_call 不经面板，由 background 直接执行）。 */
  | { kind: "server"; msg: ServerMessage }
  /** ping 的回应，证明这条端口还连着活的 service worker。 */
  | { kind: "pong" }
  /** 连接状态变化。 */
  | { kind: "conn"; state: ConnState; transport?: TransportKind; detail?: string }
  /** 面板关闭期间积累的、按 seq 排序的可见历史。 */
  | { kind: "history"; entries: PanelHistoryEntry[]; replay?: boolean }
  /** 选中即问：划词或右键把一段正文交给侧栏，不自动发送。 */
  | { kind: "ask_selection"; ask: PendingAsk }
  /**
   * 送达回执（issue #4）：只覆盖 background→agent 上行传输层。
   * ok=false 表示上行传输不可用，确定未发给伴随进程；original 为未经页面
   * 附加上文的原始消息，供面板原样重试。没有回执 = background 层已接受并
   * 已交给传输层，不表示伴随进程已处理或任务已完成。
   */
  | { kind: "delivery"; seq: number; ok: boolean; original: ClientMessage }
  /** 用户那一条历史补上了这一轮带的页面（见 UserTurnContext）。 */
  | { kind: "turn_context"; seq: number; context: UserTurnContext }
  /** 一次同步回放结束：面板据此核对旧端口上的消息是否丢了。 */
  | { kind: "synced" };
