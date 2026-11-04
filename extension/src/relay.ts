import { parseClientMessage, type Attachment, type ClientMessage, type ServerMessage, type ViewportSectionUpdate } from "../../shared/protocol.js";
import type { PendingAsk } from "./shared/ask-selection.js";
import type { NudgeCard } from "./shared/nudge.js";

export const PANEL_PORT_NAME = "sideagent-panel";

export type DeliveryReason = "gone" | "resent";

export type DeliveryReceipt = { seq: number; ok: boolean; text?: string; original?: ClientMessage; reason?: DeliveryReason };

export function parseRedeliver(msg: unknown): { seq: number; text: string } | null {
  if (!msg || typeof msg !== "object" || !("seq" in msg) || !("text" in msg)) return null;
  const { seq, text } = msg;

  return typeof seq === "number" && Number.isInteger(seq) && typeof text === "string" ? { seq, text } : null;
}

export function parseDeliveryReceipt(msg: unknown): DeliveryReceipt | null {
  if (!msg || typeof msg !== "object" || !("seq" in msg) || !("ok" in msg)) return null;
  const { seq, ok } = msg;
  const text = "text" in msg ? msg.text : undefined;
  const reason = "reason" in msg ? msg.reason : undefined;
  const original = "original" in msg && msg.original ? parseClientMessage(JSON.stringify(msg.original)) : null;

  if (typeof seq !== "number" || !Number.isInteger(seq) || typeof ok !== "boolean") return null;

  if (text !== undefined && typeof text !== "string") return null;

  if (reason !== undefined && reason !== "gone" && reason !== "resent") return null;

  return { seq, ok, ...(text === undefined ? {} : { text }), ...(original ? { original } : {}), ...(reason ? { reason } : {}) };
}

export const SEND_CONFIRM_PANEL_PORT = "send-confirm-panel";

export const SEND_ARM_MS = 800;

export type ConnState = "connecting" | "connected" | "disconnected";

export type TransportKind = "inproc";

export type PanelHistoryServerMessage = Extract<ServerMessage, { type: "status" | "agent_event" | "team_status" }>;

export type PanelHistoryItem =
  | { kind: "user"; text: string; attachments?: Attachment[]; undelivered?: { original: ClientMessage }; context?: UserTurnContext; card?: NudgeCard }
  | { kind: "server"; msg: PanelHistoryServerMessage };

export interface UserTurnContext {
  title: string;
  url: string;
  selection?: string;
  pages?: Array<{ title: string; url: string; tabId: number; status?: "pending" | "read" | "unread"; reason?: string }>;
}

export interface PanelHistoryEntry {
  seq: number;
  occurredAt?: number;
  item: PanelHistoryItem;
}

export type PanelToBg =
  | { kind: "select_conversation"; conversationId: string }
  | { kind: "client"; msg: ClientMessage }
  | { kind: "control"; action: "takeover" | "handback"; conversationId?: string; tabId?: number }
  | { kind: "sync"; afterSeq?: number; conversationId?: string }
  | { kind: "redeliver"; seq: number; text: string; conversationId?: string }
  | { kind: "retry" }
  | { kind: "focus" }
  | { kind: "panel_window"; windowId: number }
  | { kind: "ping" }
  | { kind: "inspect_step"; target?: string; tabId?: number; url?: string; caption?: string }
  | { kind: "page_refs_check"; id: string; names: string[] }
  | { kind: "page_ref_point"; id: string; name: string }
  | { kind: "fill_undo"; conversationId?: string };

export type FillUndoNote = "rich_text" | "sensitive";

export type FillUndoView = (
  | { state: "ready"; count: number; fields: string[]; notes: FillUndoNote[] }
  | { state: "submitted"; fields: string[]; notes: FillUndoNote[] }
  | { state: "page_changed"; fields: string[]; notes: FillUndoNote[] }
  | { state: "restored"; restored: string[]; skipped: Array<{ field: string; reason: "user_changed" | "gone" | "failed" }>; notes: FillUndoNote[] }
) & {
  untracked?: string[];
  unavailable?: string[];
};

export const FILL_UNDO_SUBMIT = "sideagent:fill-undo-submit";

export type BgToPanel = BgToPanelPayload & { conversationId?: string };

type BgToPanelPayload =
  | { kind: "page_section"; update: ViewportSectionUpdate | null; tabId: number }
  | { kind: "marginalia"; update: ViewportSectionUpdate; state: import("../../shared/reading.js").ReadingEvent["state"]; text: string; error?: string }
  | { kind: "conversations"; conversations: import("../../shared/protocol.js").ConversationSummary[]; selectedConversationId: string; resumeReading?: boolean }
  | { kind: "server"; msg: ServerMessage }
  | { kind: "pong" }
  | { kind: "conn"; state: ConnState; transport?: TransportKind; detail?: string }
  | { kind: "history"; entries: PanelHistoryEntry[]; replay?: boolean }
  | { kind: "ask_selection"; ask: PendingAsk }
  | { kind: "delivery"; seq: number; ok: boolean; text?: string; original?: ClientMessage; reason?: DeliveryReason }
  | { kind: "turn_context"; seq: number; context: UserTurnContext }
  | { kind: "mention_status"; seq: number; tabId: number; status: "read" | "unread"; reason?: string }
  | { kind: "synced" }
  | { kind: "inspect_step_result"; ok: boolean }
  | { kind: "page_refs_found"; id: string; names: string[] }
  | { kind: "page_ref_pointed"; id: string; ok: boolean }
  | { kind: "handoff_phase"; phase: "leaving" | "user" | "rereading" | "agent" }
  | { kind: "fill_undo"; undo: FillUndoView | null; refused?: "busy" };
