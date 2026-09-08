/** Voice is a read-only view of one conversation, not another task-input channel. */
export interface TaskProgressSnapshot {
  conversationId: string;
  observedAt: number;
  state: "none" | "running" | "paused" | "idle" | "aborted" | "error";
  goal: string | null;
  startedAt: number | null;
  active: Array<{ member: string; action: string; since: number }>;
  lastAction: { action: string; failed: boolean; at: number } | null;
  /** Idle means this run stopped. Task success is never inferred from agent_end. */
  successVerified: false;
}

export type VoiceCommand =
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "audio"; turn: number; data: string }
  | { kind: "commit"; turn: number }
  | { kind: "interrupt"; turn: number; played?: { itemId: string; ms: number } }
  | { kind: "playback_done"; responseId: string };
export interface VoiceClientMessage { type: "voice"; voiceId: string; command: VoiceCommand }
export type VoiceEvent =
  | { kind: "state"; state: "connecting" | "ready" | "answering" | "closed" | "error"; detail?: string }
  | { kind: "audio"; turn: number; data: string; itemId: string; responseId: string }
  | { kind: "text"; turn: number; role: "user" | "assistant"; text: string }
  | { kind: "facts"; turn: number; snapshot: TaskProgressSnapshot }
  | { kind: "response_end"; turn: number; responseId: string };
export interface VoiceServerMessage { type: "voice"; voiceId: string; event: VoiceEvent }

const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
const turn = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
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
export function isTaskProgressSnapshot(v: unknown): v is TaskProgressSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as TaskProgressSnapshot;
  return id(s.conversationId) && Number.isFinite(s.observedAt) && ["none", "running", "paused", "idle", "aborted", "error"].includes(s.state)
    && (s.goal === null || typeof s.goal === "string" && s.goal.length <= 600) && (s.startedAt === null || Number.isFinite(s.startedAt))
    && s.successVerified === false && Array.isArray(s.active) && s.active.length <= 12 && s.active.every(a => a && typeof a.member === "string" && typeof a.action === "string" && a.action.length <= 100 && Number.isFinite(a.since))
    && (s.lastAction === null || !!s.lastAction && typeof s.lastAction.action === "string" && typeof s.lastAction.failed === "boolean" && Number.isFinite(s.lastAction.at));
}
export function isVoiceServerMessage(v: unknown): v is VoiceServerMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as VoiceServerMessage;
  if (m.type !== "voice" || !id(m.voiceId) || !m.event || typeof m.event !== "object") return false;
  const e = m.event;
  switch (e.kind) {
    case "state": return ["connecting", "ready", "answering", "closed", "error"].includes(e.state) && (e.detail === undefined || typeof e.detail === "string" && e.detail.length <= 500);
    case "audio": return turn(e.turn) && validPCM(e.data) && id(e.itemId) && id(e.responseId);
    case "text": return turn(e.turn) && ["user", "assistant"].includes(e.role) && typeof e.text === "string" && e.text.length <= 12000;
    case "facts": return turn(e.turn) && isTaskProgressSnapshot(e.snapshot);
    case "response_end": return turn(e.turn) && id(e.responseId);
    default: return false;
  }
}
