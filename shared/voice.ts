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
  /** Present only for the reply to this live voice turn; background task findings omit it. */
  voiceTurn?: number;
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
  /** Keep pending delegation through conversational interjections, never through a new command. */
  awaitInputDecision?: () => Promise<void>;
  onInputDecision?: (readOnly: boolean) => void;
  pendingDelegation?: boolean;
  /** In-session spoken dialogue, including replies that were not task findings. */
  recentTurns?: VoiceConversationContext['recentTurns'];
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
  /** Diagnostic capture is only ever opened by an explicit request; a backend that does not confirm must not receive audio. */
  | { kind: "start"; diagnostic?: true; capture?: true }
  | { kind: "stop" }
  | { kind: "audio"; turn: number; data: string; frame?: number }
  | { kind: "commit"; turn: number;input?:VoiceInputContext }
  | { kind: "interrupt"; turn: number; played?: { itemId: string; ms: number } }
  | { kind: "playback_done"; responseId: string }
  /**
   * Facts only the extension can observe for one turn: the continuous PCM it captured, the text the
   * panel rendered, or a user mark. One turn may arrive as several commands; the agent merges them by
   * voiceId+turn, and nothing here changes what the voice session does.
   */
  | { kind: "capture"; turn: number; data?: string; sampleRate?: number; serverText?: string; displayText?: string; mark?: true; note?: string };
export interface VoiceClientMessage { type: "voice"; voiceId: string; command: VoiceCommand }

export const VOICE_DIAG_SAMPLE_RATE = 24000;
/** One diagnostic take is bounded; longer speech is truncated, never silently claimed complete. */
export const VOICE_DIAG_MAX_SECONDS = 60;
export const VOICE_DIAG_TEXT_MAX = 12000;
/** A normal-use capture carries a whole turn (60s at 24k ≈ 3.8M base64 chars); frames stay under `validPCM`. */
export const VOICE_CAPTURE_MAX_BASE64 = 8_000_000;
export const VOICE_CAPTURE_NOTE_MAX = 200;
/** Raw ASR seen before the old-turn filter; `current` is this turn, `filtered` was dropped as an old turn. */
export type VoiceDiagAsrOutcome = 'current' | 'filtered' | 'empty' | 'unknown';
export type VoiceDiagGapCode = 'reconnect' | 'send_failed' | 'truncated' | 'closed';

/**
 * Upstream capture evidence, produced by the session on the real send path only.
 * C1 is the concatenation of the `audio` payloads of the `append` records, i.e. exactly what the
 * socket accepted; `frame` only aligns those bytes with the client's continuous 24k capture (C0).
 */
export type VoiceDiagRecord =
  | { type: 'ready'; sampleRate: number; maxSeconds: number }
  | { type: 'append'; seq: number; eventId: string; turn: number; frame: number | null; samples: number; audio: string }
  | { type: 'commit'; seq: number; eventId: string; turn: number }
  | { type: 'item'; turn: number; itemId: string }
  | { type: 'asr'; turn: number | null; itemId: string; outcome: VoiceDiagAsrOutcome; text: string }
  | { type: 'forward'; turn: number; itemId: string; text: string }
  | { type: 'gap'; code: VoiceDiagGapCode; turn: number | null; detail?: string };

export type VoiceEvent =
  | {kind:'reset_output';turn:number}
  | { kind: "state"; state: "connecting" | "ready" | "answering" | "closed" | "error"; detail?: string; recoverable?: boolean }
  | { kind: "audio"; turn: number; data: string; itemId: string; responseId: string }
  | { kind: "text"; turn: number; role: "user" | "assistant"; text: string }
  | { kind: "facts"; turn: number; snapshot: TaskProgressSnapshot }
  | { kind: "response_end"; turn: number; responseId: string }
  | { kind: "diag"; record: VoiceDiagRecord };
export interface VoiceServerMessage { type: "voice"; voiceId: string; event: VoiceEvent }

const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
const turn = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const serverTurn = (v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const diagTurn=(v:unknown)=>v===null||turn(v);
const diagItemId=(v:unknown)=>typeof v==="string"&&v.length>=1&&v.length<=128;
const diagTextField=(v:unknown)=>typeof v==="string"&&v.length<=VOICE_DIAG_TEXT_MAX;
export function isVoiceDiagRecord(v: unknown): v is VoiceDiagRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const seq = Number.isSafeInteger(r.seq) && Number(r.seq) > 0;
  switch (r.type) {
    case "ready": return Number.isFinite(r.sampleRate) && Number(r.sampleRate) > 0 && Number(r.sampleRate) <= 192000 && Number.isFinite(r.maxSeconds) && Number(r.maxSeconds) > 0 && Number(r.maxSeconds) <= 900;
    case "append": return seq && id(r.eventId) && turn(r.turn) && (r.frame === null || Number.isSafeInteger(r.frame) && Number(r.frame) >= 0) && Number.isSafeInteger(r.samples) && Number(r.samples) > 0 && validPCM(r.audio);
    case "commit": return seq && id(r.eventId) && turn(r.turn);
    case "item": return turn(r.turn) && diagItemId(r.itemId);
    case "asr": return diagTurn(r.turn) && diagItemId(r.itemId) && ["current", "filtered", "empty", "unknown"].includes(r.outcome as string) && diagTextField(r.text);
    case "forward": return turn(r.turn) && diagItemId(r.itemId) && diagTextField(r.text);
    case "gap": return ["reconnect", "send_failed", "truncated", "closed"].includes(r.code as string) && diagTurn(r.turn) && (r.detail === undefined || typeof r.detail === "string" && r.detail.length <= 200);
    default: return false;
  }
}
export function validPCM(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 65536 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}
/** Same rules as `validPCM`, but a capture command may carry a whole turn instead of one frame. */
export function validCapturePCM(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= VOICE_CAPTURE_MAX_BASE64 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}
export function isVoiceClientMessage(v: unknown): v is VoiceClientMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as VoiceClientMessage;
  if (m.type !== "voice" || !id(m.voiceId) || !m.command || typeof m.command !== "object") return false;
  const c = m.command;
  switch (c.kind) {
    case "start": return (c.diagnostic === undefined || c.diagnostic === true) && (c.capture === undefined || c.capture === true);
    case "stop": return true;
    case "audio": return turn(c.turn) && validPCM(c.data) && (c.frame === undefined || Number.isSafeInteger(c.frame) && c.frame >= 0 && c.frame <= 1_000_000);
    case "commit": return turn(c.turn);
    case "interrupt": return turn(c.turn) && (c.played === undefined || !!c.played && id(c.played.itemId) && Number.isFinite(c.played.ms) && c.played.ms >= 0);
    case "playback_done": return id(c.responseId);
    /** A capture must carry at least one real fact; `note` alone is not evidence and is always optional. */
    case "capture": return turn(c.turn)
      && (c.data !== undefined || c.mark === true || c.serverText !== undefined || c.displayText !== undefined)
      && (c.data === undefined || validCapturePCM(c.data))
      && (c.sampleRate === undefined || typeof c.sampleRate === "number" && Number.isFinite(c.sampleRate) && Number(c.sampleRate) > 0 && Number(c.sampleRate) <= 192000)
      && (c.serverText === undefined || diagTextField(c.serverText))
      && (c.displayText === undefined || diagTextField(c.displayText))
      && (c.mark === undefined || c.mark === true)
      && (c.note === undefined || typeof c.note === "string" && c.note.length <= VOICE_CAPTURE_NOTE_MAX);
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
    case "diag": return isVoiceDiagRecord(e.record);
    default: return false;
  }
}
