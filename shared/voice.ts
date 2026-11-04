import { isTaskGoalPlan, type TaskGoalPlan } from './task-goals.js';
import type {TaskReceipt} from './task-actions.js';
import {isTaskNextStep} from './task-next-step.js';
import type {Attachment,PageContext} from './protocol.js';
import { isTaskResultItem, isTaskResultState, type TaskResultItem, type TaskResultState } from './task-results.js';
import {isTaskRecoveryInput,type TaskRecoveryInput} from './task-recovery.js';
import { isTaskContinuation, type TaskContinuation } from './task-continuation.js';

export const USER_DELIVERY_KINDS = ["ack", "finding", "reply"] as const;

export type UserDeliveryKind = (typeof USER_DELIVERY_KINDS)[number];

export const USER_DELIVERY_STATUSES = ["composed", "speaking", "played"] as const;

export type UserDeliveryStatus = (typeof USER_DELIVERY_STATUSES)[number];

export const USER_DELIVERY_TEXT_MAX = 12000;

export const USER_DELIVERY_FACT_ITEM_MAX = 12;

export const USER_DELIVERY_SOURCE_MAX = 12;

export const USER_DELIVERY_SOURCE_URL_MAX = 500;

export const USER_DELIVERY_SOURCE_TITLE_MAX = 160;

export const USER_DELIVERY_FACT_DESCRIPTION_MAX = 160;

export const USER_DELIVERY_OUTCOMES = ["complete", "partial", "unverified"] as const;

export type UserDeliveryOutcome = (typeof USER_DELIVERY_OUTCOMES)[number];

export interface UserDeliverySourceRef {
  url: string;
  title?: string | null;
}

export interface UserDeliveryRemainingItem {
  id: string;
  description: string;
  status: "pending" | "blocked" | "unknown";
}

export interface UserDeliveryFacts {
  outcome: UserDeliveryOutcome;
  delivered: string[];
  remaining: UserDeliveryRemainingItem[];
  sources: UserDeliverySourceRef[];
  omittedDelivered?: number;
  omittedRemaining?: number;
}

export interface UserDelivery {
  conversationId: string;
  id: string;
  runId: string | null;
  kind: UserDeliveryKind;
  text: string;
  replyTo?: string;
  composedAt: number;
  status: UserDeliveryStatus;
  facts?: UserDeliveryFacts;
  unfinished?: string[];
  sources?: UserDeliverySourceRef[];
  hostNote?: string;
}

export const USER_DELIVERY_HOST_NOTE_MAX = 200;

export function deliveryTextWithNote(delivery: Pick<UserDelivery, "text" | "hostNote">): string {
  if (!delivery.hostNote) return delivery.text;
  const text = `${delivery.text}\n\n${delivery.hostNote}`;

  return text.length <= USER_DELIVERY_TEXT_MAX ? text : `${text.slice(0, USER_DELIVERY_TEXT_MAX - 12)}…（后文已截断）`;
}

export interface UserDeliveryStream {
  id: string;
  runId: string | null;
  kind: UserDeliveryKind;
  text: string;
  phase: 'streaming' | 'cancelled';
  voiceTurn?: number;
}

export interface VoiceConversationContext {
  recentTurns: Array<{role:'user'|'assistant'; text:string}>;
  latestResult: {runId:string; text:string; observedAt:number; source:'assistant_output'} | null;
  latestDelivery?: UserDelivery | null;
}

export interface TaskProgressSnapshot {
  conversationId: string;
  observedAt: number;
  state: "none" | "running" | "paused" | "interrupted" | "idle" | "aborted" | "error";
  goal: string | null;
  startedAt: number | null;
  runId?: string | null;
  restartRecovery?: boolean;
  interruptionReason?: 'host_restart' | 'connection_lost' | 'manual_continuation';
  recoveryInput?:TaskRecoveryInput;
  continuation?: TaskContinuation;
  untrackedWritePending?:boolean;
  unresolvedEffect?:boolean;
  executionAuditComplete?:boolean;
  opaqueEffectRan?:boolean;
  controlVersion?:number;
  active: Array<{ member: string; action: string; since: number }>;
  lastAction: { action: string; failed: boolean; at: number } | null;
  lastReadAt?: number;
  successVerified: false;
  conversationContext?: VoiceConversationContext;
  results?: TaskResultItem[];
  executionState?: TaskResultState;
  resultState?: TaskResultState;
  goalPlan?: TaskGoalPlan;
  nextStep?: import('./task-next-step.js').TaskNextStep;
  goalCheck?: { status: "done" | "needs_user" | "continue" | "open" | "blocked"; remaining: string | null; at: number };
  goalPage?: { title: string; url: string };
  interjections?: number;
  foldedResults?: { count: number; recent: string[] };
}

export interface VoiceTarget {id:string;title:string;runId:string|null;controlVersion?:number}

export const GPT_LIVE_MODEL = "gpt-live-1-codex";

export type RealtimeVoiceModel = "stepaudio-3-realtime-preview" | "stepaudio-2.5-realtime" | typeof GPT_LIVE_MODEL;

export interface VoiceRouteContext {
  nativeChat?: boolean;
  /** 语音层已判定这句要动手：不再分类，直接交给执行模型。 */
  delegated?: true;
  /** Keep pending delegation through conversational interjections, never through a new command. */
  awaitInputDecision?: () => Promise<void>;
  onInputDecision?: (readOnly: boolean, incomplete?:boolean) => void;
  pendingDelegation?: boolean;
  recentTurns?: VoiceConversationContext['recentTurns'];
  interruptedSpeech?:boolean;
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

export type VoiceTurnBranch = 'reply' | 'control' | 'read_only';

export type VoiceTurnProtocol = 'free_reply' | 'plan';

export type VoiceRouteResult = {plan?:VoicePlanSummary;turn?:{branch:VoiceTurnBranch;phase:'COMMITTED'|'DISCARDED';protocol?:VoiceTurnProtocol}} & (
  | {kind:'none';nativeChat?:true;resumeTargetId?:string; resumeReadOnly?:'chat'|'observe'|'status'; snapshot?:TaskProgressSnapshot;spokenText?:string}
  | {kind:'silent';quiet?:boolean}
  | {kind:'listening'}
  | {kind:'clarify';message:string}
  | {kind:'steer'|'action';awaitDelivery?:boolean;ok:boolean;status?:TaskReceipt['status'];message:string;receipts?:TaskReceipt[];snapshot?:TaskProgressSnapshot});

export const STEP_VOICES = [
  { id: "wenroushunv", label: "温柔淑女" },
  { id: "qingchunshaonv", label: "青春少女" },
  { id: "jingdiannvsheng", label: "经典女声" },
] as const;

export type StepVoice = typeof STEP_VOICES[number]["id"];

export const DEFAULT_STEP_VOICE: StepVoice = "wenroushunv";

export const STEP_VOICE_STORAGE_KEY = "step_voice";

export function isStepVoice(value: unknown): value is StepVoice {
  return STEP_VOICES.some(v => v.id === value);
}

export const ORB_STYLES = [
  { id: "dusk", label: "暮色" },
  { id: "dawn", label: "晨光" },
  { id: "particles", label: "粒子" },
] as const;

export type OrbStyle = typeof ORB_STYLES[number]["id"];

export const DEFAULT_ORB_STYLE: OrbStyle = "dusk";

export const ORB_STYLE_STORAGE_KEY = "voice_orb_style";

export function parseOrbStyle(value: {} | null | undefined): OrbStyle {
  return ORB_STYLES.find(style => style.id === value)?.id ?? DEFAULT_ORB_STYLE;
}

export const VOICE_PERSONAS = [
  { id: "default", label: "默认", summary: "简洁利落的搭子", text: "" },
  {
    id: "robin", label: "罗宾式", summary: "沉静博学，话少，偶尔冷幽默",
    text: "沉静、从容、博学，像一位见多识广的考古学者。说话温和、不急，话少而准。不用“好呀”“好啊”这类热情开头，不连串追问；常用一句简短的观察或见解代替寒暄。偶尔一句轻描淡写、略带冷意的幽默，可以轻轻一笑。关心对方，但点到为止，不黏人、不夸张赞美。口吻示例（只示范语气，不要照搬）：“结论其实藏在最后一段，前面都是铺垫。”“找到了，在页面最底下，藏得还挺深。”",
  },
] as const;

export const CUSTOM_PERSONA_MAX_CHARS = 300;

export type VoicePersona = { id: typeof VOICE_PERSONAS[number]["id"] } | { id: "custom"; text: string };

export const DEFAULT_VOICE_PERSONA: VoicePersona = { id: "default" };

export const VOICE_PERSONA_STORAGE_KEY = "voice_persona";

const isPersonaRecord = (value: unknown): value is { id?: unknown; text?: unknown } => !!value && typeof value === "object";

const isCustomPersona = (value: { id?: unknown; text?: unknown }): value is { id: "custom"; text: string } => value.id === "custom" && typeof value.text === "string";

export function parseVoicePersona(value: {} | null | undefined): VoicePersona {
  if (!isPersonaRecord(value)) return DEFAULT_VOICE_PERSONA;
  const preset = VOICE_PERSONAS.find(p => p.id === value.id);

  if (preset) return { id: preset.id };

  if (!isCustomPersona(value)) return DEFAULT_VOICE_PERSONA;
  const text = value.text.trim();

  return text && text.length <= CUSTOM_PERSONA_MAX_CHARS ? { id: "custom", text } : DEFAULT_VOICE_PERSONA;
}

export function voicePersonaText(persona: VoicePersona): string {
  return persona.id === "custom" ? persona.text : VOICE_PERSONAS.find(p => p.id === persona.id)?.text ?? "";
}

export type VoiceCommand =
  | { kind: "start"; diagnostic?: true; capture?: true; voice?: string; persona?: VoicePersona;  model?: string }
  | { kind: "stop" }
  | { kind: "audio"; turn: number; data: string; frame?: number }
  | { kind: "commit"; turn: number;input?:VoiceInputContext;contextPending?:boolean }
  | { kind: "input_context"; turn:number;input?:VoiceInputContext;error?:string }
  | { kind: "interrupt"; turn: number; played?: { itemId: string; ms: number } }
  | { kind: "playback_done"; responseId: string }
  | { kind: "barge_in"; turn: number }
  | { kind: "capture"; turn: number; data?: string; sampleRate?: number; serverText?: string; displayText?: string; mark?: true; note?: string }
  | { kind: "gpt_live_connected" }
  | { kind: "gpt_live_transcript"; turnId: string; role: 'user' | 'assistant'; text: string }
  | { kind: "delegation"; delegationId: string; text: string; userTurnId?: string }
  | { kind: "timing"; point: VoiceTimingPoint; at: number; turn?: number; key?: string; ref?: string };

export const VOICE_TIMING_POINTS = ["user_done", "remote_audio", "delegation", "result_sent", "result_audio", "panel_audio", "result_resent", "result_unvoiced"] as const;

export type VoiceTimingPoint = typeof VOICE_TIMING_POINTS[number];

export interface VoiceClientMessage { type: "voice"; voiceId: string; command: VoiceCommand }

export const VOICE_DIAG_SAMPLE_RATE = 24000;

export const VOICE_DIAG_MAX_SECONDS = 60;

export const VOICE_DIAG_TEXT_MAX = 12000;

export const VOICE_CAPTURE_MAX_BASE64 = 8_000_000;

export const VOICE_CAPTURE_NOTE_MAX = 200;

export type VoiceDiagAsrOutcome = 'current' | 'filtered' | 'empty' | 'unknown';

export type VoiceDiagGapCode = 'reconnect' | 'send_failed' | 'truncated' | 'closed';

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
  | { kind: "state"; state: "connecting" | "ready" | "answering" | "closed" | "error"; detail?: string; recoverable?: boolean;  sayAgain?: boolean; inputMode?: 'server_vad' }
  | { kind: "input_turn"; turn: number }
  | { kind: "audio"; turn: number; data: string; itemId: string; responseId: string }
  | { kind: "text"; turn: number; role: "user" | "assistant"; text: string }
  | { kind: "facts"; turn: number; snapshot: TaskProgressSnapshot }
  | { kind: "response_end"; turn: number; responseId: string }
  | { kind: "diag"; record: VoiceDiagRecord }
  | { kind: "gpt_live_auth"; access: string; accountId: string; instructions: string }
  | { kind: "delegation_context"; delegationId: string; channel: "speakable" | "commentary"; text: string }
  | { kind: "live_context"; channel: "speakable" | "commentary"; text: string };

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

export function validCapturePCM(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= VOICE_CAPTURE_MAX_BASE64 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}

export function isVoiceClientMessage(v: unknown): v is VoiceClientMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as VoiceClientMessage;

  if (m.type !== "voice" || !id(m.voiceId) || !m.command || typeof m.command !== "object") return false;
  const c = m.command;

  switch (c.kind) {
    case "start": return (c.diagnostic === undefined || c.diagnostic === true) && (c.capture === undefined || c.capture === true) && (c.voice === undefined || typeof c.voice === "string" && c.voice.length <= 64) && (c.model === undefined || typeof c.model === "string" && c.model.length <= 64);
    case "stop": return true;
    case "audio": return turn(c.turn) && validPCM(c.data) && (c.frame === undefined || Number.isSafeInteger(c.frame) && c.frame >= 0 && c.frame <= 1_000_000);
    case "commit": return turn(c.turn)&&(c.contextPending===undefined||typeof c.contextPending==='boolean');
    case "input_context": return turn(c.turn)&&(c.input!==undefined||c.error!==undefined)&&(c.error===undefined||typeof c.error==='string'&&c.error.length>0&&c.error.length<=500);
    case "interrupt": return turn(c.turn) && (c.played === undefined || !!c.played && id(c.played.itemId) && Number.isFinite(c.played.ms) && c.played.ms >= 0);
    case "playback_done": return id(c.responseId);
    case "barge_in": return turn(c.turn);
    case "gpt_live_connected": return true;
    case "gpt_live_transcript": return id(c.turnId) && (c.role === 'user' || c.role === 'assistant') && shortText(c.text, 4000);
    case "delegation": return id(c.delegationId) && c.delegationId.length <= 48 && shortText(c.text, 2000) && (c.userTurnId === undefined || id(c.userTurnId));
    case "capture": return turn(c.turn)
      && (c.data !== undefined || c.mark === true || c.serverText !== undefined || c.displayText !== undefined)
      && (c.data === undefined || validCapturePCM(c.data))
      && (c.sampleRate === undefined || typeof c.sampleRate === "number" && Number.isFinite(c.sampleRate) && Number(c.sampleRate) > 0 && Number(c.sampleRate) <= 192000)
      && (c.serverText === undefined || diagTextField(c.serverText))
      && (c.displayText === undefined || diagTextField(c.displayText))
      && (c.mark === undefined || c.mark === true)
      && (c.note === undefined || typeof c.note === "string" && c.note.length <= VOICE_CAPTURE_NOTE_MAX);
    case "timing": return VOICE_TIMING_POINTS.includes(c.point) && Number.isSafeInteger(c.at) && c.at > 0
      && (c.turn === undefined || serverTurn(c.turn)) && (c.key === undefined || id(c.key)) && (c.ref === undefined || id(c.ref));
    default: return false;
  }
}

const shortText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length >= 1 && v.length <= max;

const deliveryUrl = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= USER_DELIVERY_SOURCE_URL_MAX
  && /^https?:\/\/[^\s]+$/.test(v);

export function isUserDeliveryFacts(v: unknown): v is UserDeliveryFacts {
  if (!v || typeof v !== "object") return false;
  const f = v as UserDeliveryFacts;

  if (!USER_DELIVERY_OUTCOMES.includes(f.outcome)) return false;

  if (!Array.isArray(f.delivered) || f.delivered.length > USER_DELIVERY_FACT_ITEM_MAX
    || !f.delivered.every((item) => shortText(item, USER_DELIVERY_FACT_DESCRIPTION_MAX))) return false;

  if (f.omittedDelivered !== undefined && !(Number.isSafeInteger(f.omittedDelivered) && f.omittedDelivered >= 0)) return false;

  if (f.omittedRemaining !== undefined && !(Number.isSafeInteger(f.omittedRemaining) && f.omittedRemaining >= 0)) return false;

  if (!Array.isArray(f.remaining) || f.remaining.length > USER_DELIVERY_FACT_ITEM_MAX
    || !f.remaining.every((item) => !!item && typeof item === "object"
      && id((item as UserDeliveryRemainingItem).id)
      && shortText((item as UserDeliveryRemainingItem).description, USER_DELIVERY_FACT_DESCRIPTION_MAX)
      && ["pending", "blocked", "unknown"].includes((item as UserDeliveryRemainingItem).status))) return false;

  if (!isDeliverySourceList(f.sources)) return false;

  if (f.outcome === "complete" && (f.remaining.length > 0 || (f.omittedRemaining ?? 0) > 0)) return false;

  return true;
}

export function fitDeliverySources(list: readonly UserDeliverySourceRef[]): UserDeliverySourceRef[] {
  return list.filter(source => deliveryUrl(source.url)).slice(0, USER_DELIVERY_SOURCE_MAX)
    .map(source => (typeof source.title === "string" && source.title.length > USER_DELIVERY_SOURCE_TITLE_MAX ? { ...source, title: `${source.title.slice(0, USER_DELIVERY_SOURCE_TITLE_MAX - 1)}…` } : { ...source }));
}

function isDeliverySourceList(v: unknown): v is UserDeliverySourceRef[] {
  return Array.isArray(v) && v.length <= USER_DELIVERY_SOURCE_MAX
    && v.every((item) => !!item && typeof item === "object" && deliveryUrl((item as UserDeliverySourceRef).url)
      && ((item as UserDeliverySourceRef).title === undefined || (item as UserDeliverySourceRef).title === null
        || shortText((item as UserDeliverySourceRef).title, USER_DELIVERY_SOURCE_TITLE_MAX)));
}

export const isUnfinishedItem = (v: unknown): v is string => shortText(v, USER_DELIVERY_FACT_DESCRIPTION_MAX);

export function isUserDelivery(v: unknown): v is UserDelivery {
  if (!v || typeof v !== "object") return false;
  const d = v as UserDelivery;

  return id(d.conversationId) && id(d.id) && (d.runId === null || id(d.runId))
    && USER_DELIVERY_KINDS.includes(d.kind)
    && typeof d.text === "string" && d.text.trim().length >= 1 && d.text.length <= USER_DELIVERY_TEXT_MAX
    && Number.isFinite(d.composedAt)
    && USER_DELIVERY_STATUSES.includes(d.status)
    && (d.replyTo === undefined || typeof d.replyTo === "string" && d.replyTo.length >= 1 && d.replyTo.length <= USER_DELIVERY_TEXT_MAX)
    && (d.facts === undefined || isUserDeliveryFacts(d.facts))
    && (d.unfinished === undefined || Array.isArray(d.unfinished) && d.unfinished.length >= 1 && d.unfinished.length <= USER_DELIVERY_FACT_ITEM_MAX
      && d.unfinished.every(isUnfinishedItem))
    && (d.sources === undefined || isDeliverySourceList(d.sources))
    && (d.hostNote === undefined || shortText(d.hostNote, USER_DELIVERY_HOST_NOTE_MAX));
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

export function executionEffectsFullyKnown(s: Pick<TaskProgressSnapshot, 'executionAuditComplete' | 'untrackedWritePending' | 'opaqueEffectRan'>): boolean {
  return s.executionAuditComplete === true && s.untrackedWritePending !== true && s.opaqueEffectRan !== true;
}

export function isTaskProgressSnapshot(v: unknown): v is TaskProgressSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as TaskProgressSnapshot;

  return id(s.conversationId) && Number.isFinite(s.observedAt) && ["none", "running", "paused", "interrupted", "idle", "aborted", "error"].includes(s.state)
    && (s.goal === null || typeof s.goal === "string" && s.goal.length <= 600) && (s.startedAt === null || Number.isFinite(s.startedAt))
    && (s.runId === undefined || s.runId === null || id(s.runId))
    && (s.restartRecovery === undefined || typeof s.restartRecovery === "boolean")
    && (s.interruptionReason === undefined || ['host_restart','connection_lost','manual_continuation'].includes(s.interruptionReason))
    && (s.recoveryInput === undefined || isTaskRecoveryInput(s.recoveryInput))
    && (s.continuation === undefined || isTaskContinuation(s.continuation))
    && (s.untrackedWritePending === undefined || typeof s.untrackedWritePending==='boolean')
    && (s.unresolvedEffect === undefined || typeof s.unresolvedEffect==='boolean')
    && (s.executionAuditComplete === undefined || typeof s.executionAuditComplete==='boolean')
    && (s.opaqueEffectRan === undefined || typeof s.opaqueEffectRan==='boolean')
    && (s.nextStep === undefined || isTaskNextStep(s.nextStep))
    && (s.goalPlan === undefined || isTaskGoalPlan(s.goalPlan))
    && s.successVerified === false && Array.isArray(s.active) && s.active.length <= 12 && s.active.every(a => a && typeof a.member === "string" && typeof a.action === "string" && a.action.length <= 100 && Number.isFinite(a.since))
    && (s.lastAction === null || !!s.lastAction && typeof s.lastAction.action === "string" && typeof s.lastAction.failed === "boolean" && Number.isFinite(s.lastAction.at))
    && (s.conversationContext === undefined || isVoiceConversationContext(s.conversationContext)
      && (s.conversationContext.latestDelivery == null
        || s.conversationContext.latestDelivery.conversationId === s.conversationId && s.conversationContext.latestDelivery.runId === (s.runId ?? null)))
    && (s.results === undefined || Array.isArray(s.results) && s.results.length <= 64 && s.results.every(isTaskResultItem))
    && (s.executionState === undefined || isTaskResultState(s.executionState))
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
    case "input_turn": return turn(e.turn);
    case "diag": return isVoiceDiagRecord(e.record);
    case "gpt_live_auth": return shortText(e.access, 16384) && shortText(e.accountId, 128) && shortText(e.instructions, 8000);
    case "delegation_context": return id(e.delegationId) && (e.channel === "speakable" || e.channel === "commentary") && shortText(e.text, USER_DELIVERY_TEXT_MAX);
    case "live_context": return (e.channel === "speakable" || e.channel === "commentary") && shortText(e.text, USER_DELIVERY_TEXT_MAX);
    default: return false;
  }
}
