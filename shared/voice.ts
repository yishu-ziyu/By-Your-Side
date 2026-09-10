import type {TaskReceipt} from './task-actions.js';
import type {Attachment,PageContext} from './protocol.js';
import { isTaskResultItem, isTaskResultState, type TaskResultItem, type TaskResultState } from './task-results.js';

export const USER_DELIVERY_KINDS = ["ack", "finding", "reply"] as const;
export type UserDeliveryKind = (typeof USER_DELIVERY_KINDS)[number];
export const USER_DELIVERY_STATUSES = ["composed", "speaking", "played"] as const;
export type UserDeliveryStatus = (typeof USER_DELIVERY_STATUSES)[number];
export const USER_DELIVERY_TEXT_MAX = 2000;

/** Official user-facing message. Internal text_delta / tool output is not this record. */
export interface UserDelivery {
  conversationId: string;
  id: string;
  runId: string | null;
  kind: UserDeliveryKind;
  text: string;
  replyTo?: string;
  composedAt: number;
  status: UserDeliveryStatus;
}

/** Cumulative text of an explicitly user-facing answer; not ordinary model text_delta. */
export interface UserDeliveryStream {
  id: string;
  runId: string | null;
  kind: UserDeliveryKind;
  text: string;
  phase: 'streaming' | 'cancelled';
}

/** Recent same-conversation dialogue and the latest final assistant report, for voice follow-ups. */
export interface VoiceConversationContext {
  recentTurns: Array<{role:'user'|'assistant'; text:string}>;
  latestResult: {runId:string; text:string; observedAt:number; source:'assistant_output'} | null;
  /** Official user-facing delivery; optional so older snapshots stay valid. */
  latestDelivery?: UserDelivery | null;
}

/** Facts are observed separately from task action receipts. */
export interface TaskProgressSnapshot {
  conversationId: string;
  observedAt: number;
  state: "none" | "running" | "paused" | "idle" | "aborted" | "error";
  goal: string | null;
  startedAt: number | null;
  runId?: string | null;
  controlVersion?:number;
  active: Array<{ member: string; action: string; since: number }>;
  lastAction: { action: string; failed: boolean; at: number } | null;
  /** Idle means this run stopped. Task success is never inferred from agent_end. */
  successVerified: false;
  /** Sourced assistant output, never an independent verification; absent on error/abort/no-result. */
  conversationContext?: VoiceConversationContext;
  /** Remaining registered results. Default [] / unregistered; optional so older snapshots stay valid. */
  results?: TaskResultItem[];
  resultState?: TaskResultState;
}

export interface VoiceTarget {id:string;title:string;runId:string|null;controlVersion?:number}
export interface VoiceRouteContext {
  reportStage?:(stage:'classifying'|'observing'|'controlling')=>void;
  controlVersion?:number;
  resumeTargetId?:string;
  resumeReadOnly?: "chat" | "observe" | "status";
  targets?:VoiceTarget[];
  requestId: string;
  runId: string | null;
  voiceId: string;
  turn: number;
  input?:VoiceInputContext;
}
export interface VoiceInputContext {observation?:{token:string;tabId:number};context?:PageContext;attachments?:Attachment[]}
export interface VoicePlanSummary {id:string;conversationId:string;updatedAt:number;steps:Array<{action:string;text:string;targetId:string;targetTitle?:string;status:'unexecuted'|'pending'|'complete';receipt?:TaskReceipt}>}
export type VoiceRouteResult = {plan?:VoicePlanSummary} & (
  | {kind:'none';resumeTargetId?:string; resumeReadOnly?:'chat'|'observe'|'status'; snapshot?:TaskProgressSnapshot;spokenText?:string}
  | {kind:'silent'}
  | {kind:'clarify';message:string}
  | {kind:'steer'|'action';awaitDelivery?:boolean;ok:boolean;status?:TaskReceipt['status'];message:string;receipts?:TaskReceipt[];snapshot?:TaskProgressSnapshot});

export type VoiceCommand =
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "audio"; turn: number; data: string }
  | { kind: "commit"; turn: number;input?:VoiceInputContext }
  | { kind: "interrupt"; turn: number; played?: { itemId: string; ms: number } }
  | { kind: "playback_done"; responseId: string };
export interface VoiceClientMessage { type: "voice"; voiceId: string; command: VoiceCommand }
export type VoiceEvent =
  | {kind:'reset_output';turn:number}
  | { kind: "state"; state: "connecting" | "ready" | "answering" | "closed" | "error"; detail?: string; recoverable?: boolean }
  | { kind: "audio"; turn: number; data: string; itemId: string; responseId: string }
  | { kind: "text"; turn: number; role: "user" | "assistant"; text: string }
  | { kind: "facts"; turn: number; snapshot: TaskProgressSnapshot }
  | { kind: "response_end"; turn: number; responseId: string };
export interface VoiceServerMessage { type: "voice"; voiceId: string; event: VoiceEvent }

const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
const turn = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const serverTurn = (v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
export function validPCM(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 65536 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}
export function isVoiceClientMessage(v: unknown): v is VoiceClientMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as VoiceClientMessage;
  if (m.type !== "voice" || !id(m.voiceId) || !m.command || typeof m.command !== "object") return false;
  const c = m.command;
  switch (c.kind) {
    case "start": case "stop": return true;
    case "audio": return turn(c.turn) && validPCM(c.data);
    case "commit": return turn(c.turn);
    case "interrupt": return turn(c.turn) && (c.played === undefined || !!c.played && id(c.played.itemId) && Number.isFinite(c.played.ms) && c.played.ms >= 0);
    case "playback_done": return id(c.responseId);
    default: return false;
  }
}
export function isUserDelivery(v: unknown): v is UserDelivery {
  if (!v || typeof v !== "object") return false;
  const d = v as UserDelivery;
  return id(d.conversationId) && id(d.id) && (d.runId === null || id(d.runId))
    && USER_DELIVERY_KINDS.includes(d.kind)
    && typeof d.text === "string" && d.text.trim().length >= 1 && d.text.length <= USER_DELIVERY_TEXT_MAX
    && Number.isFinite(d.composedAt)
    && USER_DELIVERY_STATUSES.includes(d.status)
    && (d.replyTo === undefined || typeof d.replyTo === "string" && d.replyTo.length >= 1 && d.replyTo.length <= USER_DELIVERY_TEXT_MAX);
}

export function isSpeakableDelivery(d: UserDelivery | null | undefined, runId?: string | null): d is UserDelivery {
  return !!d && (d.kind === "finding" || d.kind === "reply") && d.status !== "played" && typeof d.text === "string" && d.text.trim().length > 0
    && (runId === undefined || d.runId === runId);
}

export function isVoiceConversationContext(v: unknown): v is VoiceConversationContext {
  if (!v || typeof v !== "object") return false;
  const c = v as VoiceConversationContext;
  return Array.isArray(c.recentTurns) && c.recentTurns.length <= 12
    && c.recentTurns.every(t => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.length <= 2000)
    && (c.latestResult === null || !!c.latestResult && id(c.latestResult.runId) && typeof c.latestResult.text === "string" && c.latestResult.text.length <= 6000
      && Number.isFinite(c.latestResult.observedAt) && c.latestResult.source === "assistant_output")
    && (c.latestDelivery === undefined || c.latestDelivery === null || isUserDelivery(c.latestDelivery));
}
export function isTaskProgressSnapshot(v: unknown): v is TaskProgressSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as TaskProgressSnapshot;
  return id(s.conversationId) && Number.isFinite(s.observedAt) && ["none", "running", "paused", "idle", "aborted", "error"].includes(s.state)
    && (s.goal === null || typeof s.goal === "string" && s.goal.length <= 600) && (s.startedAt === null || Number.isFinite(s.startedAt))
    && (s.runId === undefined || s.runId === null || id(s.runId))
    && s.successVerified === false && Array.isArray(s.active) && s.active.length <= 12 && s.active.every(a => a && typeof a.member === "string" && typeof a.action === "string" && a.action.length <= 100 && Number.isFinite(a.since))
    && (s.lastAction === null || !!s.lastAction && typeof s.lastAction.action === "string" && typeof s.lastAction.failed === "boolean" && Number.isFinite(s.lastAction.at))
    && (s.conversationContext === undefined || isVoiceConversationContext(s.conversationContext)
      && (s.conversationContext.latestDelivery == null
        || s.conversationContext.latestDelivery.conversationId === s.conversationId && s.conversationContext.latestDelivery.runId === (s.runId ?? null)))
    && (s.results === undefined || Array.isArray(s.results) && s.results.length <= 64 && s.results.every(isTaskResultItem))
    && (s.resultState === undefined || isTaskResultState(s.resultState));
}
export function isVoiceServerMessage(v: unknown): v is VoiceServerMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as VoiceServerMessage;
  if (m.type !== "voice" || !id(m.voiceId) || !m.event || typeof m.event !== "object") return false;
  const e = m.event;
  if(e.kind==='reset_output')return Number.isSafeInteger(e.turn)&&e.turn>=0;
  switch (e.kind) {
    case "state": return ["connecting", "ready", "answering", "closed", "error"].includes(e.state) && (e.detail === undefined || typeof e.detail === "string" && e.detail.length <= 500) && (e.recoverable === undefined || typeof e.recoverable === "boolean");
    case "audio": return serverTurn(e.turn) && validPCM(e.data) && id(e.itemId) && id(e.responseId);
    case "text": return serverTurn(e.turn) && ["user", "assistant"].includes(e.role) && typeof e.text === "string" && e.text.length <= 12000;
    case "facts": return serverTurn(e.turn) && isTaskProgressSnapshot(e.snapshot);
    case "response_end": return serverTurn(e.turn) && id(e.responseId);
    default: return false;
  }
}
