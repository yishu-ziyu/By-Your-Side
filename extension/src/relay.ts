/**
 * 扩展内部通道：side panel ⇆ background service worker。
 * 与 shared/protocol.ts（扩展 ⇆ 伴随进程）不同，本文件只是 panel 与 background 之间的
 * 转发约定，走 chrome.runtime Port。
 */
import type { Attachment, ClientMessage, ServerMessage, ViewportSectionUpdate } from "../../shared/protocol.js";
import type { PendingAsk } from "./shared/ask-selection.js";
import type { NudgeCard } from "./shared/nudge.js";

export const PANEL_PORT_NAME = "sideagent-panel";

/** 伴随进程连接状态（background 维护，面板只展示）。 */
export type ConnState = "connecting" | "connected" | "disconnected";

/** 上行传输：只有扩展内 agent。 */
export type TransportKind = "inproc";

/** 侧栏能够回放的伴随进程消息；执行调用和握手/模型元数据不进入历史。 */
export type PanelHistoryServerMessage = Extract<ServerMessage, { type: "status" | "agent_event" | "team_status" }>;

/** 关闭侧栏后仍需要恢复的可见内容。 */
export type PanelHistoryItem =
  /** card：这一轮是按主动卡的动词发起的（YIS-106），侧栏把这一轮画成按下的那张卡，不画成用户气泡。 */
  | { kind: "user"; text: string; attachments?: Attachment[]; undelivered?: { original: ClientMessage }; context?: UserTurnContext; card?: NudgeCard }
  | { kind: "server"; msg: PanelHistoryServerMessage };

/** 这一轮随消息带给助手的页面与选段；侧栏画成用户消息下面的 chip。 */
export interface UserTurnContext {
  title: string;
  url: string;
  selection?: string;
  pages?: Array<{ title: string; url: string; tabId: number; status?: "pending" | "read" | "unread"; reason?: string }>;
}

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
  /** 重发一条标着未送达的用户消息：后台用它记下的原文重发，更新原来那一条历史，不另记一条。 */
  | { kind: "redeliver"; seq: number; conversationId?: string }
  /** 请重连。 */
  | { kind: "retry" }
  /** 端口存活探测：service worker 被 Chrome 停掉后，面板手里的端口不一定会收到断开事件。 */
  | { kind: "ping" }
  /** 悬停/聚焦过程步骤：在网页上圈出当时点过的元素；target 空则收起。 */
  | { kind: "inspect_step"; target?: string; tabId?: number; url?: string; caption?: string }
  /** 还原填写：把助手这一轮填过、还没提交的格子写回它动手前的值。任务在跑时不做，回 fill_undo 带 refused。 */
  | { kind: "fill_undo"; conversationId?: string };

/** 还原填写的说明：编辑器里的文字、原来有内容的密码这类栏，这一版不还原。 */
export type FillUndoNote = "rich_text" | "sensitive";

/**
 * 这一轮还原填写的样子（background/fill-undo.ts）。只有数量、栏名和状态，不带任何格子的值。
 * ready：可以还原 count 处；submitted：确定提交过，收不回；page_changed：页面换了文档、或扩展重启后记录没了；
 * restored：点过还原，restored 是写回的栏，skipped 是没动的栏和原因。
 */
export type FillUndoView =
  | { state: "ready"; count: number; fields: string[]; notes: FillUndoNote[] }
  | { state: "submitted"; fields: string[]; notes: FillUndoNote[] }
  | { state: "page_changed"; fields: string[]; notes: FillUndoNote[] }
  | { state: "restored"; restored: string[]; skipped: Array<{ field: string; reason: "user_changed" | "gone" | "failed" }>; notes: FillUndoNote[] };

/** 网页里助手填过的格子所在的表单被提交了（content-domops 发给后台）。 */
export const FILL_UNDO_SUBMIT = "sideagent:fill-undo-submit";

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
   * 附加上文的原始消息，供面板原样重试。ok=true 只在 redeliver 重发成功后出现，面板据此去掉未送达标记。
   * 首次发送没有回执 = background 层已接受并已交给传输层，不表示伴随进程已处理或任务已完成。
   */
  | { kind: "delivery"; seq: number; ok: boolean; original: ClientMessage }
  /** 用户那一条历史补上了这一轮带的页面（见 UserTurnContext）。 */
  | { kind: "turn_context"; seq: number; context: UserTurnContext }
  /** @ 拉进来的标签页：扩展后台真读到正文才标已读。 */
  | { kind: "mention_status"; seq: number; tabId: number; status: "read" | "unread"; reason?: string }
  /** 一次同步回放结束：面板据此核对旧端口上的消息是否丢了。 */
  | { kind: "synced" }
  /** 步骤对照：找到了就圈，找不到回 ok=false，侧栏写「页面已变」。 */
  | { kind: "inspect_step_result"; ok: boolean }
  /** 接管/交还编排：离开 → 你在操作 → 重读 → 助手回来。由真实事件推进。 */
  | { kind: "handoff_phase"; phase: "leaving" | "user" | "rereading" | "agent" }
  /** 还原填写的现状：每次变化都发，面板重开时也补发；null 表示这一轮没有可还原的。refused=busy：任务在跑，没还原。 */
  | { kind: "fill_undo"; undo: FillUndoView | null; refused?: "busy" };
