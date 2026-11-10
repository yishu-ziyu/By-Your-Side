import { isReadingClientMessage, isReadingEvent, isReadingKindResult, isReadingRouteResult, isReadingTranscript, type ReadingClientMessage, type ReadingEvent, type ReadingKindResult, type ReadingRouteResult, type ReadingTranscript } from "./reading.js";
import { isNudgeClientMessage, isNudgeResult, type NudgeClientMessage, type NudgeResult } from "./nudge.js";
import { isBrowseHabitClientMessage, isBrowseHabitResult, type BrowseHabitClientMessage, type BrowseHabitResult } from "./browse-habits.js";
import { isExecutionFeedback } from "./execution-feedback.js";

import { isMemoryEntry, isMemoryScope, MEMORY_TEXT_MAX, isStoredMemoryEntry, normalizeMemoryHostname, upgradeMemoryEntry, validMemoryId, validMemoryText, validMemoryVersion, type MemoryEntry, type MemoryScope } from "./memory.js";
import { isTaskHistoryEntry, type TaskHistoryEntry } from "./task-history.js";
import type { RouteTarget } from "./route.js";
import { isUserDelivery, isVoiceClientMessage, isVoiceServerMessage, type UserDelivery, type VoiceClientMessage, type VoiceServerMessage } from "./voice.js";
import { isTaskActionRequest, isTaskReceipt, taskId, type TaskActionRequest, type TaskReceipt } from "./task-actions.js";
import { isTaskView } from "./task-view.js";
import type { CopyTextRange } from "./copy-range.js";
import { isJsonObject, isJsonSchema, isLearnedOperationResult, type JsonObject, type JsonSchema, type LearnedOperationResult } from "./learned-operations.js";
export type { CopyTextRange } from "./copy-range.js";

export const PROTOCOL_VERSION = 1;

export const STORAGE_SCHEMA_VERSION = 1;

export const HOST_VERSION = "0.2.0";

export const LEAD_SESSION_ID = "main";

export const DEFAULT_CONVERSATION_ID = "default";

export const WORKING_TABS_STORAGE_KEY = "workingTabs";

export function executionKey(conversationId: string, sessionId: string = LEAD_SESSION_ID): string {
  const cid = conversationId || DEFAULT_CONVERSATION_ID;
  const sid = sessionId || LEAD_SESSION_ID;

  if (cid === DEFAULT_CONVERSATION_ID) return encodeURIComponent(sid);

  return `${encodeURIComponent(cid)}::${encodeURIComponent(sid)}`;
}

export function normalizeConversationId(id?: string | null): string { return id ?? DEFAULT_CONVERSATION_ID; }

export type FieldReadbackMatch = "same" | "reformatted" | "not_held" | "different" | "unreadable";

export interface FieldReadback { name: string; match: FieldReadbackMatch; requested?: string; observed?: string; sensitive?: true; truncated?: true;  select?: true }

export const FIELD_READBACK_MAX = 1000;

export interface FillSource { tabId?: number; target: string; range?: CopyTextRange }

export interface ConversationSummary {
  id: string; title: string; createdAt: number; updatedAt: number;
  state: AgentRunState; model?: string; mode: AgentMode; runId?: string | null;
  checkpoint?: "interrupted" | "unavailable";
  ending?: string;
  site?: string;
}

export function isLeadSession(sessionId?: string | null): boolean {
  return sessionId == null || sessionId === "" || sessionId === LEAD_SESSION_ID;
}

export function normalizeSessionId(sessionId?: string | null): string {
  return isLeadSession(sessionId) ? LEAD_SESSION_ID : sessionId!;
}

export type AgentMode = "act";

export interface PageContext {
  tabId: number;
  title: string;
  url: string;
  selection?: { text: string };
}

const CIRCLE_NOTE_MAX = 600;

export interface ImageAttachment {
  id: string;
  type: "image";
  name: string;
  dataBase64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  note?: string;
  circle?: number;
}

export const FILE_READ_MAX_BYTES = 50 * 1024 * 1024;

export const FILE_TEXT_MAX = 400_000;

export const FILE_BYTES_KEEP_MAX = 5 * 1024 * 1024;

export const FILE_PAGE_IMAGES_MAX = 4;

export const FILE_FORMATS = ["pdf", "docx", "xlsx", "pptx", "csv", "text", "html", "image"] as const;

export type FileFormat = (typeof FILE_FORMATS)[number];

export interface FileAttachment {
  id: string;
  type: "file";
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  format: FileFormat;
  text: string;
  parts?: { kind: "page" | "sheet" | "slide"; count: number };
  truncated?: true;
  pageImages?: Array<{ page: number; mimeType: "image/jpeg"; dataBase64: string }>;
  dataBase64?: string;
  note?: string;
}

export type Attachment = ImageAttachment | FileAttachment;

function isFileAttachment(a: Record<string, unknown>): boolean {
  if (typeof a.name !== "string" || !a.name || a.name.length > 256) return false;

  if (typeof a.mimeType !== "string" || a.mimeType.length > 128) return false;

  if (!Number.isSafeInteger(a.size) || Number(a.size) < 0) return false;

  if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) return false;

  if (!FILE_FORMATS.includes(a.format as FileFormat)) return false;

  if (typeof a.text !== "string" || a.text.length > FILE_TEXT_MAX) return false;

  if (a.parts !== undefined) {
    const parts = a.parts as Record<string, unknown> | null;

    if (!parts || !["page", "sheet", "slide"].includes(parts.kind as string) || !Number.isSafeInteger(parts.count) || Number(parts.count) < 0) return false;
  }

  if (a.truncated !== undefined && a.truncated !== true) return false;

  if (a.pageImages !== undefined) {
    if (!Array.isArray(a.pageImages) || a.pageImages.length > FILE_PAGE_IMAGES_MAX) return false;

    for (const image of a.pageImages as Array<Record<string, unknown> | null>) {
      if (!image || !Number.isSafeInteger(image.page) || image.mimeType !== "image/jpeg" || typeof image.dataBase64 !== "string" || !image.dataBase64) return false;
    }
  }

  if (a.dataBase64 !== undefined && (typeof a.dataBase64 !== "string" || a.dataBase64.length > Math.ceil(FILE_BYTES_KEEP_MAX / 3) * 4)) return false;

  return a.note === undefined || (typeof a.note === "string" && a.note.length <= 600);
}

export function isAttachment(v: unknown): v is Attachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;

  if (typeof a.id !== "string" || !a.id || a.id.length > 128) return false;

  if (a.type === "file") return isFileAttachment(a);

  if (a.type !== "image") return false;

  if (typeof a.name !== "string" || a.name.length > 256) return false;

  if (typeof a.dataBase64 !== "string" || !a.dataBase64) return false;

  if (a.note !== undefined && (typeof a.note !== "string" || a.note.length > CIRCLE_NOTE_MAX)) return false;

  if (a.circle !== undefined && !(Number.isSafeInteger(a.circle) && Number(a.circle) >= 1 && Number(a.circle) <= 99)) return false;

  if (
    a.mimeType !== "image/png" &&
    a.mimeType !== "image/jpeg" &&
    a.mimeType !== "image/webp" &&
    a.mimeType !== "image/gif"
  ) {
    return false;
  }

  return true;
}

export type AgentRunState = "idle" | "running" | "user";

function isAgentRunState(v: unknown): v is AgentRunState {
  return v === "idle" || v === "running" || v === "user";
}

export type TeamMemberRole = "lead" | "worker";

export type TeamMemberPhase =
  | "running"
  | "waiting_tool"
  | "waiting_message"
  | "draining"
  | "user"
  | "restoring"
  | "restored"
  | "paused_tab_closed"
  | "paused_snapshot_failed"
  | "aborted"
  | "idle";

export type TeamPhase = "idle" | "draining" | "user" | "restoring" | "partial" | "restored" | "aborted";

export interface TeamMemberView {
  sessionId: string;
  role: TeamMemberRole;
  phase: TeamMemberPhase;
  activity?: "running" | "waiting_tool" | "waiting_message";
  tabId?: number;
  title?: string;
  url?: string;
  reason?: string;
  capturedAt?: number;
}

export interface TeamView {
  groupId: string;
  generation: number;
  phase: TeamPhase;
  members: TeamMemberView[];
  capturedAt: number;
}

export interface TeamFrozenMember {
  sessionId: string;
  role: TeamMemberRole;
  tabId?: number;
  activity?: "running" | "waiting_tool" | "waiting_message";
  title?: string;
  url?: string;
}

export type TeamMemberHandback =
  | {
      sessionId: string;
      context: PageContext;
      snapshot: string;
      capturedAt?: number;
    }
  | {
      sessionId: string;
      closed: true;
      reason?: string;
      capturedAt?: number;
    }
  | {
      sessionId: string;
      snapshotFailed: true;
      reason?: string;
      context?: PageContext;
      capturedAt?: number;
    };

export type ToolExecutionFact = "not_executed" | "unknown" | "executed";

const HELD_REASONS = ["pay", "declined", "repeat", "busy", "stopped", "left", "timeout", "send_changed", "send_unverified", "guide_stopped", "guide_left", "guide_no_change", "guide_timeout"] as const;
export type HeldReason = typeof HELD_REASONS[number];

export function isHeldReason(v: unknown): v is HeldReason {
  return (HELD_REASONS as readonly unknown[]).includes(v);
}

export interface ModelConnectionTarget { provider: string; modelId: string; baseUrl?: string }
export interface ModelConnectionIdentity { provider: string; modelId: string; runId: string; endpointHash?: string }

export type ClientMessage = ConversationEnvelope & (
  | VoiceClientMessage
  | ReadingClientMessage
  | NudgeClientMessage
  | BrowseHabitClientMessage
  | { type: "memory_list"; requestId: string }
  | { type: "memory_update"; requestId: string; id: string; expectedVersion: number; text: string; scope: MemoryScope }
  | { type: "memory_forget"; requestId: string; id: string; expectedVersion: number }
  | { type: "memory_restore"; requestId: string; id: string; expectedVersion: number }
  | { type: "memory_ask_answer"; requestId: string; askId: string; answer: "remember" | "once"; text?: string }
  | { type: "memory_site"; requestId: string; id: string; expectedVersion: number; hostname: string; off: boolean }
  | { type: "memory_unforget"; requestId: string; entries: MemoryEntry[] }
  | { type: "task_history_list"; requestId: string }
  | { type: "task_history_forget"; requestId: string; id: string | null }
  | { type: "task_history_site"; requestId: string; id: string; hostname: string; off: boolean }
  | { type: "task_history_restore"; requestId: string; task: TaskHistoryEntry }
  | { type: "skill_operations_list"; requestId: string }
  | { type: "skill_operation_delete"; requestId: string; id: string }
  | { type: "skill_operation_run"; requestId: string; id: string; input: JsonObject; tabId?: number }
  | { type: "site_note_delete"; requestId: string; host: string; text: string; runId: string }
  | { type: "site_note_list"; requestId: string }
  | { type: "conversation_create"; requestId: string; title?: string; reading?: ReadingTranscript }
  | { type: "conversation_list"; requestId?: string }
  | { type: "hello"; token: string; client: "sidepanel"; protocol?: number; extensionVersion?: string; storageSchema?: number }
  | { type: "user_message"; text: string; context?: PageContext; attachments?: Attachment[]; spoken?: true }
  | { type: "task_action"; request: TaskActionRequest }
  | { type: "task_receipt_query"; requestId: string }
  | { type: "task_view_query"; requestId: string }
  | { type: "steer"; text: string; context?: PageContext; attachments?: Attachment[]; spoken?: true }
  | { type: "abort"; taskRequestId?:string }
  | { type:'task_control_result';requestId:string;action:'pause'|'resume'|'abort';runId:string;ok:boolean;reason?:string;uncertain?:boolean;partial?:boolean }
  | {
      type: "takeover";
      requestId: string;
      taskRequestId?: string;
      groupId?: string;
      generation?: number;
      members?: TeamFrozenMember[];
    }
  | {
      type: "handback";
      requestId: string;
      taskRequestId?: string;
      context?: PageContext;
      snapshot?: string;
      members?: TeamMemberHandback[];
      groupId?: string;
      generation?: number;
    }
  | { type: "set_model"; model: string }
  | { type: "set_thinking"; model: string; level: ThinkingLevel | null; restore?: true }
  | { type: "warm_up"; context?: PageContext; connection?: true }
  | { type: "page_translate"; context?: PageContext }
  | { type: "retry_after_error"; keySaveRequestId?: string; target?: ModelConnectionTarget; expectedRunId?: string; auto?: true }
  | { type: "model_key_test"; requestId: string; key: string; target: ModelConnectionTarget; expectedRunId: string }
  | { type: "model_key_save"; requestId: string; key: string; target: ModelConnectionTarget; expectedRunId: string; roles: string; connection: string; credentialHash: string }
  | { type: "model_key_cancel"; requestId: string }
  | { type: "tool_result"; id: string; ok: boolean; data?: unknown; error?: string; executionFact?: ToolExecutionFact }
  | { type: "tool_waiting_user"; id: string; waiting: boolean;  guide?: GuideWait;  send?: SendConfirmView });

export type SendConfirmOutcome = "send" | "decline" | "stopped" | "left" | "timeout";

export interface SendConfirmView {
  id: string;
  host: string;
  label: string;
  content?: string;
  recipient?: string;
  route?: "click" | "script" | "enter" | "request";
  outcome?: SendConfirmOutcome;
  clicked?: "yes" | "no" | "unknown" | "changed" | "unverified";
  kind?: "search" | "send" | "request";
  query?: string;
  path?: string;
  method?: string;
  body?: string;
  startedAt?: number;
  expiresAt?: number;
}

export interface ConversationEnvelope { conversationId?: string }

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.some(level => level === value);
}
export interface ThinkingInfo { model: string; base: ThinkingLevel; actual: ThinkingLevel }

export interface ModelOption {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  featured?: boolean;
  thinking?: { levels: ThinkingLevel[]; default: ThinkingLevel };
}

export interface HostFeatures { memory: boolean }

export type ServerMessage = ConversationEnvelope & {epochs?:Record<string,number>;runId?:string|null} & (
  | ReadingEvent
  | ReadingRouteResult
  | ReadingKindResult
  | NudgeResult
  | BrowseHabitResult
  | {type:'task_control';requestId:string;action:'pause'|'resume'|'abort';runId:string;scope?:'task'|'page';tabId?:number;ask?:string;targets?:string[]}
  | {type:'task_control_ack';requestId:string;action:'abort';ok:boolean}
  | VoiceServerMessage
  | { type: "memory_result"; requestId: string; action: "list" | "update" | "forget" | "restore" | "ask" | "site" | "unforget"; ok: boolean; entries?: MemoryEntry[]; entry?: MemoryEntry; deletedId?: string; error?: string;  rev?: number; alreadySaved?: true;  askClosed?: true }
  | { type: "task_history_result"; requestId: string; ok: boolean; tasks?: TaskHistoryEntry[]; error?: string }
  | { type: "skill_operations_result"; requestId: string; ok: boolean; operations?: SkillOperationSummary[]; error?: string }
  | { type: "skill_operation_run_result"; requestId: string; ok: boolean; result?: LearnedOperationResult; error?: string }
  | { type: "site_note_delete_result"; requestId: string; ok: boolean; error?: string }
  | { type: "site_note_list_result"; requestId: string; ok: boolean; notes?: Array<{ host: string; text: string; runId: string }>; error?: string }
  | { type: "model_key_test_result"; requestId: string; ok: boolean; ms?: number; reason?: string; detail?: string }
  | { type: "model_key_save_result"; requestId: string; ok: boolean }
  | { type: "conversation_created"; requestId: string; conversation: ConversationSummary }
  | { type: "conversation_list"; requestId?: string; conversations: ConversationSummary[] }
  | { type: "conversation_updated"; conversation: ConversationSummary }
  | { type: "hello_ok"; version: number; model?: string; models?: ModelOption[]; hostVersion?: string; extensionVersion?: string; storageSchema?: number;  features?: HostFeatures }
  | { type: "hello_error"; error: string }
  | { type: "model_info"; model?: string; models: ModelOption[] }
  | { type: "status"; state: AgentRunState; sessionId?: string }
  | { type: "task_view"; view: import('./task-view.js').TaskView }
  | {
      type: "control_result";
      requestId: string;
      action: "takeover" | "handback";
      ok: boolean;
      state: AgentRunState;
      reason?: string;
      team?: TeamView;
    }
  | { type: "team_status"; team: TeamView | null }
  | { type: "tool_call"; id: string; name: ToolName; params: Record<string, unknown>; sessionId?: string; programId?: string; programDeadline?: number;  sdkId?: string }
  | { type: "agent_event"; event: AgentUiEvent; sessionId?: string });

export type AgentUiEvent =
  | ({ kind: "thinking_level" } & ThinkingInfo)
  | { kind: "worker_task"; task: string; output: string; spawnToolCallId?: string }
  | { kind: "memory"; action: "saved" | "used" | "updated" | "forgotten"; entries: MemoryEntry[]; message?: string;  rev?: number;
      tasks?: TaskHistoryEntry[];
      hostname?: string;
      replaced?: MemoryEntry[] }
  | { kind: "memory_ask"; askId: string; rule: string; scope: MemoryScope; replaces?: { id: string; text: string }; hostname?: string; outcome?: "remembered" | "already" | "once" | "closed"; learned?: MemoryEntry;  habit?: true;  evidence?: string[];  quotes?: string[] }
  | { kind: "site_notes"; host: string; title?: string; notes: string[] }
  | { kind: "answer_sources"; sources: import("./answer-source.js").AnswerSource[] }
  | { kind: "fact_check"; status: "done"; answer: string; problems: string[]; replacement?: string }
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "tool_start"; toolCallId: string; name: string; params: Record<string, unknown>; detail?: { text: string; href?: string }; valueHash?: string }
  | { kind: "tool_end"; toolCallId: string; name: string; isError: boolean; resultText?: string; pageTitle?: string; timeout?: { copy: string; retry: boolean }; executionFact?: ToolExecutionFact;  reason?: string;  repeatRefused?: true;  heldReason?: HeldReason;  sendConfirmed?: true;  readback?: FieldReadback;  pageTarget?: { target: string; label: string; tabId: number; url: string };  skill?: { id: string; name: string; outcome: "saved" | "used" | "unused" } }
  | { kind: "tool_observation"; toolCallId: string; name: string; target: string | null; tabId: number | null; workingTab: boolean; text: string; truncated: boolean; tabIds?: number[]; url?:string; title?:string }
  | { kind: "send_confirm_wait"; waiting: boolean; confirm?: SendConfirmView }
  | { kind: "guide_wait"; waiting: boolean; guide?: GuideWait }
  | { kind: "tool_late_result"; toolCallId: string; name: string; ok: boolean; executionFact: ToolExecutionFact }
  | { kind: "execution_feedback"; feedback: import('./execution-feedback.js').ExecutionFeedback }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "context_usage"; used: number; window: number; model: string }
  | { kind: "agent_start"; deliveryMode?: "explicit" }
  | { kind: "agent_end" }
  | { kind: "run_stopped" }
  | { kind: "goal_check"; status: "done" | "needs_user" | "continue" | "open" | "blocked" | "checking" | "unavailable";  pageRead?: boolean; remaining?: string; correction?: string;  finding?: string;  held?: boolean;  step?: { at: number; of: number }; }
  | { kind: "user_delivery"; delivery: UserDelivery }
  | { kind: "artifact"; action: "saved" | "deleted"; filename: string; content?: string; encoding?: "base64" }
  | { kind: "user_delivery_stream"; stream: import('./voice.js').UserDeliveryStream }
  | { kind: "notice"; message: string; receipt?: TaskReceipt;plan?:import("./voice.js").VoicePlanSummary;
      progress?: true;
      aside?: true }
  | { kind: "error"; message: string; modelConnection?: ModelConnectionIdentity };

export const TOOL_NAMES = [
  "fetch",
  "network",
  "video_captions",
  "worker_tabs",
  "page_translation",
  "read_element",
  "read_elements",
  "list_tabs",
  "get_active_tab",
  "open_tab",
  "switch_tab",
  "close_tab",
  "navigate",
  "snapshot",
  "page_text",
  "click",
  "hover",
  "fill",
  "type_text",
  "press_key",
  "scroll",
  "js",
  "screenshot",
  "observe_page",
  "mark",
  "clear_marks",
  "guide_step",
  "double_click",
  "arm_event",
  "wait_event",
  "disarm_event",
  "consume_events",
  "accept_dialog",
  "dismiss_dialog",
  "dialog_info",
  "describe_target",
  "download_url",
  "select_option",
  "upload_file",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface UploadFilePayload { name: string; type: string; text?: string; base64?: string }

export interface AnchorSource {
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  label?: string | null;
  text?: string | null;
  title?: string | null;
  alt?: string | null;
  ancestorText?: string | null;
  autocomplete?: string | null;
}

export interface DownloadReceipt {
  capturedFile?: { dataBase64: string; mimeType: string };
  attachment?: { id: string; name: string; truncated?: true };
  attachmentError?: string;
  downloadId: string;
  tabId: number;
  url: string;
  suggestedFilename: string;
  path: string | null;
  failure: string | null;
  completed: boolean;
  cancelled: boolean;
  bytes?: number;
  danger?: string;
}

export type MarkActionId = "confirm" | "cancel";

export interface MarkAction {
  id: MarkActionId;
  label: string;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  working: boolean;
}

export type PageReadinessValue = "interactive" | "complete" | "timeout" | "download" | "error_page";

export interface NavigationDownload {
  filename: string;
  path: string;
  state: "in_progress" | "interrupted" | "complete";
  bytes?: number;
  error?: string;
  danger?: string;
}

export interface SwitchTabVerification {
  verified: boolean;
  activeTabId?: number;
  windowId?: number;
  windowFocused?: boolean;
  workingTabId?: number | null;
}

export interface ToolContract {
  page_translation: { params: import('./page-translation.js').TranslationCommand; data: import('./page-translation.js').TranslationReceipt };
  fetch: {
    params: { url: string; method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; savePath?: string; pages?: { from: number; to: number; step?: number } };
    data: { url: string; status: number; ok: boolean; contentType: string; bytes: number; truncated: boolean; text: string; readBytes?: number; totalBytes?: number | null; stoppedReason?: "complete" | "limit" | "deadline" | "abort"; timingsMs?: { confirmation: number; dispatch: number; response: number; body: number } };
  };
  network: {
    params: { tabId?: number; urlContains?: string; types?: string[] | "all"; limit?: number; clear?: boolean };
    data: {
      text: string;
      tabId: number;
      total: number;
      matched: number;
      shown: number;
      dropped: number;
      inFlight: number;
      excludedInFlight: number;
      lastActivityAt: number;
      generation: number;
      integrity: "none" | "ok" | "late" | "detached" | "gap" | "restart";
      attached: boolean;
    };
  };
  video_captions: { params: { tabId?: number }; data: { text: string; tabId: number; tracks: number; lists: number; loginRequired?: boolean; sourceUrl?: string; videoId?: string | null; title?: string; part?: { index: number; title: string; count: number } | null; identityVerified?: boolean; captionTracks?: Array<{ source: string; lang: string; label: string; auto: boolean; url?: string; cues?: number | null }> } };
  worker_tabs: { params: { action: "inspect" | "release" | "claim"; tabId?: number; workerId?: string; expectedConversationId?: string | null; orActive?: boolean; overrideUserHold?: boolean }; data: { tabId?: number; tabIds?: number[]; workers: string[]; owned?: boolean; conversationId?: string | null; foreign?: boolean; members?: string[] } };
  read_element: {
    params: { tabId?: number; target: string;  readback?: {documentId:string;deadline:number;nodeIdentity?: {kind:'ax';backendNodeId:number}};  copyRead?: {documentId:string;deadline:number;nodeIdentity:{kind:'ax';backendNodeId:number}} } & import('./element-state.js').ElementReadOptions;
    data: { tabId: number; target: string; tagName: string; persistentTarget?: string; url?: string; text?: string; value?: string; scopeLabels?:string[]; documentId?: string; nodeIdentity?: {kind:'ax';backendNodeId:number}; anchorSource?: AnchorSource;  fullText?: string;  inputRange?: import('./page-readout.js').InputRange & { problem?: import('./page-readout.js').RangeProblem };  properties?: Partial<Record<import('./element-state.js').ElementProperty, import('./element-state.js').ElementValue | null>>;  note?: string; check?: { matched: true; property: import('./element-state.js').ElementProperty; elapsedMs: number } };
  };
  read_elements: {
    params: { tabId?: number; selector: string; limit?: number };
    data: {
      tabId: number; documentId?: string; selector: string;
      total: number; truncated: boolean;
      elements: Array<{
        index: number; tagName: string; text: string; visible: boolean;
        target?: string;
        rect: { x: number; y: number; width: number; height: number };
        style: { backgroundColor: string; color: string; outline: string; border: string; textDecoration: string; fontWeight: string };
        scopeLabels?: string[];
      }>;
    };
  };
  list_tabs: { params: Record<string, never>; data: { tabs: TabInfo[] } };
  get_active_tab: { params: Record<string, never>; data: { tab: TabInfo | null } };
  open_tab: { params: { url?: string }; data: { tabId: number; url: string; title: string; readiness?: PageReadinessValue; waitMs?:number; quietMs?:number; retryMs?:number; documentId?:string; download?: NavigationDownload; note?: string;  retry?: string;  tabClosed?: true } };
  switch_tab: { params: { tabId: number;  show?: boolean }; data: { tabId: number; verification?: SwitchTabVerification } };
  close_tab: { params: { tabId?: number }; data: { closed: true } };
  navigate: { params: { tabId?: number; url: string; timeout?: number; inPlace?: boolean }; data: { url: string; title: string; readiness?: PageReadinessValue; waitMs?:number; quietMs?:number; retryMs?:number; documentId?:string; download?: NavigationDownload; note?: string;  retry?: string;  workingTabId?: number } };
  snapshot: { params: { tabId?: number; scope?: "full_page" | "viewport";decision?:boolean;  cursor?: string;  viewScopeId?: string;  fresh?: boolean }; data: { text: string; tabId: number; documentId?:string; textEvidence?:import("./page-text-evidence.js").PageTextEvidence; url?:string; translation?:import("./page-translation.js").TranslationDisplayState|null;marks?:import("./host-marks.js").HostDrawnMark[];observation?:import('./browser-decision.js').BrowserObservation } };
  page_text: { params: { tabId?: number; max?: number }; data: { text: string; totalChars: number; tabId: number; url?: string; title?: string } };
  click: {
    params: {
      tabId?: number;
      target?: string;
      point?: [number, number];
      position?: import('./pointer-input.js').ElementPosition;
      button?: import('./pointer-input.js').MouseButton;
      clickCount?: number;
      force?: boolean;
      label?: string;
      awaitPage?: boolean;
    };
    data: { clicked: true; effect?: import('./effect.js').EffectReport;  appeared?: import('./effect.js').PageAppeared; newTab?: { tabId: number; url?: string }; dialog?: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string };  sendConfirmed?: true; timing?: Record<string, number>; page?: ToolContract["snapshot"]["data"] };
  };
  double_click: {
    params: {
      tabId?: number;
      target?: string;
      point?: [number, number];
      position?: import('./pointer-input.js').ElementPosition;
      button?: import('./pointer-input.js').MouseButton;
      clickCount?: number;
      force?: boolean;
      label?: string;
    };
    data: { doubleClicked: true; effect?: import('./effect.js').EffectReport; appeared?: import('./effect.js').PageAppeared; newTab?: { tabId: number; url?: string }; dialog?: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } } | { doubleClicked: false; dialog: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } };
  };
  arm_event: {
    params: {
      tabId?: number;
      type: "popup" | "download" | "filechooser";
      timeoutMs?: number;
    };
    data: { token: string; type: "popup" | "download" | "filechooser"; tabId: number; timeoutMs: number };
  };
  wait_event: {
    params: { token: string; timeoutMs?: number };
    data: {
      token: string;
      type: "popup" | "download" | "filechooser";
      tabId: number;
      popup?: { tabId: number; url?: string; targetId?: string; label: string };
      download?: {
        downloadId: string;
        url: string;
        suggestedFilename: string;
        tabId: number;
        failure: string | null;
        completed: boolean;
        path?: string;
        bytes?: number;
        danger?: string;
        capturedFile?: { dataBase64: string; mimeType: string };
        attachment?: { id: string; name: string; truncated?: true };
        attachmentError?: string;
      };
      fileChooser?: { chooserId: string; multiple: boolean; backendNodeId: number };
    };
  };
  disarm_event: {
    params: { token: string };
    data: { disarmed: true; token: string; status: string };
  };
  consume_events: {
    params: { tabId?: number; clear?: boolean };
    data: { tabId: number; events: Array<{ kind: string; at: number; payload: Record<string, unknown> }> };
  };
  accept_dialog: {
    params: { tabId?: number; promptText?: string };
    data: { accepted: boolean; dialog?: { type: string; message: string; tabId: number; url?: string } };
  };
  dismiss_dialog: {
    params: { tabId?: number };
    data: { dismissed: boolean; dialog?: { type: string; message: string; tabId: number; url?: string } };
  };
  dialog_info: {
    params: { tabId?: number };
    data: { dialog: null | { type: string; message: string; tabId: number; url?: string; defaultPrompt?: string } };
  };
  describe_target: {
    params: { tabId?: number; target: string };
    data: { target: RouteTarget | null };
  };
  download_url: {
    params: { url: string; filename?: string; timeoutMs?: number; tabId?: number };
    data: DownloadReceipt;
  };
  hover: {
    params: { tabId?: number; target?: string; point?: [number, number]; label?: string };
    data: { hovered: true };
  };
  fill: { params: { tabId?: number; target: string;  value?: string;  from?: FillSource;  copyRange?: CopyTextRange;  submit?: boolean;  expectedDocumentId?: string; expectedBackendNodeId?: number;  memory?: { id: string; text: string; createdAt: number } }; data: { filled: true;  copyProof?: import('./copied-field.js').CopiedFieldProof; appeared?: import('./effect.js').PageAppeared;  typing?: "failed";  submit?: { refused: string } | { uncertain: string } | { pressed: true; effect?: import('./effect.js').EffectReport; appeared?: import('./effect.js').PageAppeared; dialog?: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } } | { pressed: false; dialog: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } };  rangeIssue?: import('./page-readout.js').RangeIssue;  readback?: FieldReadback;  source?: { chars: number; head: string; tail: string };  refound?: true } };
  select_option: {
    params: {
      tabId?: number;
      target: string;
      values: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }> | null;
      expectedDocumentId?: string;
      expectedBackendNodeId?: number;
    };
    data: { selected: string[]; labels: string[];  refound?: true; appeared?: import('./effect.js').PageAppeared };
  };
  upload_file: {
    params: { tabId?: number; target?: string; files: UploadFilePayload[] };
    data: { files: Array<{ name: string; size: number; type: string }> };
  };
  type_text: { params: { tabId?: number; text: string; }; data: { typed: true;  readback?: FieldReadback } };
  press_key: { params: { tabId?: number; key: string; }; data: { pressed: true; effect?: import('./effect.js').EffectReport; appeared?: import('./effect.js').PageAppeared;  singleLineInput?: true; dialog?: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } } | { pressed: false; dialog: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultPrompt?: string } } };
  scroll: { params: { tabId?: number; dy?: number; toBottom?: boolean }; data: { atBottom: boolean } };
  js: { params: { tabId?: number; code: string }; data: { value: unknown } };
  observe_page: {params:{token:string;mode?:'text'|'image'};data:unknown};
  screenshot: {
    params: {
      tabId?: number;
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number; scale?: number };
      scale?: "css" | "raw";
    };
    data: {
      imageBase64: string;
      mediaType: "image/png";
      width: number;
      height: number;
      pixelWidth: number;
      pixelHeight: number;
      cssWidth: number;
      cssHeight: number;
      devicePixelRatio: number;
      tabId: number;
      url: string;
      title: string;
      capturedAt: number;
      source: "cdp" | "visible-tab";
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number; scale?: number };
      scale?: "css" | "raw";
      documentId?: string;
      coordinates?: {
        origin: { x: number; y: number };
        scroll: { x: number; y: number };
        viewport: { width: number; height: number };
        pixelsPerCssPixel: number;
        space: "document";
      } | null;
    };
  };
  mark: { params: { tabId?: number; target?: string; through?: string; label?: string; actions?: MarkAction[]; text?: string[] }; data: { marked: true; counts?: Array<{ text: string; count: number }> } };
  clear_marks: { params: {tabId?: number}; data: { cleared: true } };
  guide_step: { params: { tabId?: number; target: string; say: string; step: number }; data: GuideStepResult };
}

export interface GuideWait { step: number; say: string; state: "waiting" | "no_change";  target?: string }

export interface GuideStepResult {
  outcome: "done";
  misses: number;
  noChangeClicks: number;
  changed?: "dom" | "url" | "document";
  after?: string;
}

export interface SkillOperationSummary { id: string; name: string; purpose: string; site: string; inputSchema: JsonSchema }

function isSkillOperationSummary(value: unknown): value is SkillOperationSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;

  return validMemoryId(item.id) && isShortText(item.name) && isShortText(item.purpose) && isShortText(item.site) && isJsonSchema(item.inputSchema, true);
}

function isShortText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2000;
}

function isModelConnectionTarget(value: unknown): value is ModelConnectionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (typeof target.provider !== "string" || !target.provider || target.provider.length > 200 || typeof target.modelId !== "string" || !target.modelId || target.modelId.length > 300) return false;
  if (target.provider !== "custom") return target.baseUrl === undefined;
  if (typeof target.baseUrl !== "string" || target.baseUrl.length > 2048) return false;
  try { return ["http:", "https:"].includes(new URL(target.baseUrl).protocol); } catch { return false; }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;

    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;

    if (msg.conversationId !== undefined && !validConversationId(msg.conversationId)) return null;

    if (msg.type === "reading_request" || msg.type === "reading_cancel" || msg.type === "reading_route" || msg.type === "reading_kind" || msg.type === "reading_import") return isReadingClientMessage(msg) ? msg : null;

    if (msg.type === "nudge_request" || msg.type === "nudge_validate") return isNudgeClientMessage(msg) ? msg : null;

    if (msg.type === "browse_habit_request" || msg.type === "browse_habit_ask") return isBrowseHabitClientMessage(msg) ? msg : null;

    if (msg.type === "conversation_create" && msg.reading !== undefined && !isReadingTranscript(msg.reading)) return null;

    if (msg.type === "voice") {
      if(!isVoiceClientMessage(msg))return null;

      if((msg.command.kind==='commit'||msg.command.kind==='input_context')&&msg.command.input!==undefined){
        const input=msg.command.input;

        if(input?.observation!==undefined&&(!input.observation||!validRequestId(input.observation.token)||!Number.isSafeInteger(input.observation.tabId)))return null;

        if(!input||typeof input!=='object'||Array.isArray(input)||(input.context!==undefined&&!isPageContext(input.context))||(input.attachments!==undefined&&(!Array.isArray(input.attachments)||!input.attachments.every(isAttachment))))return null;
      }

      return msg;
    }

    if (msg.type === "task_action") {
      const r = msg.request;

      return isTaskActionRequest(r) && r.conversationId === msg.conversationId
        && (r.context === undefined || isPageContext(r.context))
        && (r.pages === undefined || Array.isArray(r.pages) && r.pages.length <= 8 && r.pages.every(isPageContext))
        && (r.attachments === undefined || Array.isArray(r.attachments) && r.attachments.every(isAttachment)) ? msg : null;
    }

    if (msg.type === "task_receipt_query") return validRequestId(msg.requestId) ? msg : null;

    if (msg.type === "task_view_query") return validRequestId(msg.requestId) ? msg : null;

    if(msg.type==='task_control_result')return validRequestId(msg.requestId)&&taskId(msg.runId)&&['pause','resume','abort'].includes(msg.action)&&typeof msg.ok==='boolean'
      &&(msg.reason===undefined||typeof msg.reason==='string'&&msg.reason.length<=1000)&&(msg.uncertain===undefined||typeof msg.uncertain==='boolean')&&(msg.partial===undefined||typeof msg.partial==='boolean')?msg:null;

    if((msg.type==='takeover'||msg.type==='handback'||msg.type==='abort')&&msg.taskRequestId!==undefined&&!validRequestId(msg.taskRequestId))return null;

    if (msg.type.startsWith("memory_")) {
      if (msg.type !== "memory_list" && msg.type !== "memory_update" && msg.type !== "memory_forget" && msg.type !== "memory_restore" && msg.type !== "memory_ask_answer" && msg.type !== "memory_site" && msg.type !== "memory_unforget") return null;

      if (!validRequestId(msg.requestId)) return null;

      if (msg.type === "memory_unforget") return Array.isArray(msg.entries) && msg.entries.length > 0 && msg.entries.length <= 100 && msg.entries.every(isMemoryEntry) ? msg : null;

      if (msg.type === "memory_site" && !(typeof msg.hostname === "string" && normalizeMemoryHostname(msg.hostname) === msg.hostname && typeof msg.off === "boolean")) return null;

      if (msg.type === "memory_ask_answer" && !(validMemoryId(msg.askId) && (msg.answer === "remember" || msg.answer === "once") && (msg.text === undefined || (typeof msg.text === "string" && msg.text.length <= MEMORY_TEXT_MAX)))) return null;

      if (msg.type !== "memory_list" && msg.type !== "memory_ask_answer" && (!validMemoryId(msg.id) || !validMemoryVersion(msg.expectedVersion))) return null;

      if (msg.type === "memory_update" && (!validMemoryText(msg.text) || !isMemoryScope(msg.scope))) return null;
    }

    if (msg.type === "task_history_list" && !validRequestId(msg.requestId)) return null;

    if (msg.type === "skill_operations_list" && !validRequestId(msg.requestId)) return null;

    if (msg.type === "site_note_delete" && !(validRequestId(msg.requestId) && typeof msg.host === "string" && normalizeMemoryHostname(msg.host) === msg.host && typeof msg.text === "string" && msg.text.length > 0 && msg.text.length <= 200 && typeof msg.runId === "string" && msg.runId.length > 0 && msg.runId.length <= 200)) return null;
    if (msg.type === "site_note_list" && !validRequestId(msg.requestId)) return null;

    if (msg.type === "skill_operation_delete" && !(validRequestId(msg.requestId) && validMemoryId(msg.id))) return null;

    if (msg.type === "skill_operation_run" && !(validRequestId(msg.requestId) && validMemoryId(msg.id) && isJsonObject(msg.input) && JSON.stringify(msg.input).length <= 16_384
      && (msg.tabId === undefined || Number.isSafeInteger(msg.tabId) && msg.tabId >= 0))) return null;

    if (msg.type === "task_history_forget" && (!validRequestId(msg.requestId) || (msg.id !== null && !validMemoryId(msg.id)))) return null;

    if (msg.type === "task_history_site" && !(validRequestId(msg.requestId) && validMemoryId(msg.id) && typeof msg.hostname === "string" && normalizeMemoryHostname(msg.hostname) === msg.hostname && typeof msg.off === "boolean")) return null;

    if (msg.type === "task_history_restore" && !(validRequestId(msg.requestId) && isTaskHistoryEntry(msg.task))) return null;

    if (msg.type === "conversation_create" && (!validRequestId(msg.requestId) || (msg.title !== undefined && (typeof msg.title !== "string" || msg.title.length > 120)))) return null;

    if (msg.type === "conversation_list" && msg.requestId !== undefined && !validRequestId(msg.requestId)) return null;

    if (msg.type === "set_model" && (typeof msg.model !== "string" || !msg.model)) return null;

    if (msg.type === "set_thinking" && (typeof msg.model !== "string" || !msg.model.includes("/") || msg.model.length > 240 || !(msg.level === null || isThinkingLevel(msg.level)) || msg.restore !== undefined && msg.restore !== true)) return null;

    if (msg.type === "retry_after_error" && (msg.auto !== undefined && msg.auto !== true || msg.target !== undefined && (!isModelConnectionTarget(msg.target) || !validRequestId(msg.expectedRunId) || !validRequestId(msg.keySaveRequestId)) || msg.expectedRunId !== undefined && !validRequestId(msg.expectedRunId))) return null;

    if (msg.type === "model_key_test" && (!validRequestId(msg.requestId) || typeof msg.key !== "string" || !msg.key.trim() || msg.key.length > 4096 || !isModelConnectionTarget(msg.target) || !validRequestId(msg.expectedRunId))) return null;

    if (msg.type === "model_key_save" && (!validRequestId(msg.requestId) || typeof msg.key !== "string" || !msg.key.trim() || msg.key.length > 4096 || !isModelConnectionTarget(msg.target) || !validRequestId(msg.expectedRunId) || typeof msg.roles !== "string" || msg.roles.length > 8192 || typeof msg.connection !== "string" || msg.connection.length > 4096 || typeof msg.credentialHash !== "string" || !/^[a-f0-9]{64}$/.test(msg.credentialHash))) return null;

    if (msg.type === "model_key_cancel" && !validRequestId(msg.requestId)) return null;

    if (
      (msg.type === "user_message" || msg.type === "steer") &&
      msg.context !== undefined &&
      !isPageContext(msg.context)
    ) {
      return null;
    }

    if ((msg.type === "user_message" || msg.type === "steer") && msg.spoken !== undefined && msg.spoken !== true) return null;

    if (
      (msg.type === "user_message" || msg.type === "steer") &&
      msg.attachments !== undefined &&
      (!Array.isArray(msg.attachments) || !msg.attachments.every(isAttachment))
    ) {
      return null;
    }

    if (msg.type === "page_translate" && msg.context !== undefined && !isPageContext(msg.context)) return null;

    if (msg.type === "takeover") {
      if (!validRequestId(msg.requestId)) return null;

      if (msg.members !== undefined) {
        if (!Array.isArray(msg.members) || msg.members.length === 0 || !msg.members.every(isTeamFrozenMember)) {
          return null;
        }

        if (msg.groupId !== undefined && (typeof msg.groupId !== "string" || !msg.groupId || msg.groupId.length > 64)) {
          return null;
        }

        if (msg.generation !== undefined && (typeof msg.generation !== "number" || !Number.isFinite(msg.generation))) {
          return null;
        }
      }
    }

    if (msg.type === "handback") {
      if (!validRequestId(msg.requestId)) return null;
      const members = msg.members;

      if (members !== undefined) {
        if (!Array.isArray(members) || members.length === 0 || !members.every(isTeamMemberHandback)) return null;
      } else {
        if (!isPageContext(msg.context)) return null;

        if (typeof msg.snapshot !== "string") return null;
      }
    }

    return msg;
  } catch {
    return null;
  }
}

function isPageContext(v: unknown): v is PageContext {
  if (typeof v !== "object" || v === null) return false;
  const c = v as PageContext;

  if (typeof c.tabId !== "number" || typeof c.title !== "string" || typeof c.url !== "string") return false;

  if (c.selection === undefined) return true;

  if (typeof c.selection !== "object" || c.selection === null) return false;
  const text = c.selection.text;

  return typeof text === "string" && text.length >= 1 && text.length <= 2000;
}

function upgradeMemoryEntries(value: unknown): value is MemoryEntry[] {
  if (!Array.isArray(value) || !value.every(isStoredMemoryEntry)) return false;
  value.forEach((entry, i) => { value[i] = upgradeMemoryEntry(entry); });

  return true;
}

type ServerOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
type AgentEventMessage = ServerOf<"agent_event">;
type AgentEventOf<K extends AgentEventMessage["event"]["kind"]> = AgentEventMessage & { event: Extract<AgentEventMessage["event"], { kind: K }> };

// WHY: 这几种消息自己把关，历来不走通用的 sessionId 检查；并入下面的表会改变它们的接收范围。
const SELF_CHECKED_SERVER: { [T in ServerMessage["type"]]?: (msg: ServerOf<T>) => boolean } = {
  reading_event: (msg) => isReadingEvent(msg),
  reading_route_result: (msg) => isReadingRouteResult(msg),
  reading_kind_result: (msg) => isReadingKindResult(msg),
  browse_habit_result: (msg) => isBrowseHabitResult(msg),
  task_control: (msg) => validRequestId(msg.requestId)&&taskId(msg.runId)&&['pause','resume','abort'].includes(msg.action)&&(msg.scope===undefined||msg.scope==='task'||msg.scope==='page')&&(msg.tabId===undefined||Number.isSafeInteger(msg.tabId)&&msg.tabId>0)&&(msg.ask===undefined||typeof msg.ask==='string'&&msg.ask.length<=200)&&(msg.targets===undefined||Array.isArray(msg.targets)&&msg.targets.length<=6&&msg.targets.every(t=>typeof t==='string'&&t.length<=200)),
  task_control_ack: (msg) => validRequestId(msg.requestId)&&msg.action==='abort'&&typeof msg.ok==='boolean',
  voice: (msg) => isVoiceServerMessage(msg),
  nudge_result: (msg) => isNudgeResult(msg),
  nudge_validation: (msg) => isNudgeResult(msg),
};

const AGENT_EVENT_CHECKS: { [K in AgentEventMessage["event"]["kind"]]?: (msg: AgentEventOf<K>) => boolean } = {
  notice: (msg) => {
    if(msg.event.plan!==undefined){
      const p=msg.event.plan;

      if(!p||!validRequestId(p.id)||p.conversationId!==msg.conversationId||!Number.isFinite(p.updatedAt)||!Array.isArray(p.steps)||p.steps.length<1||p.steps.length>3||!p.steps.every(s=>s&&typeof s.action==='string'&&typeof s.text==='string'&&s.text.length<=12000&&validConversationId(s.targetId)&&(s.targetTitle===undefined||typeof s.targetTitle==='string'&&s.targetTitle.length<=120)&&['pending','complete','unexecuted'].includes(s.status)&&(s.receipt===undefined||isTaskReceipt(s.receipt)&&s.receipt.conversationId===s.targetId)))return false;
    }

    if (msg.event.receipt !== undefined
      && (!isTaskReceipt(msg.event.receipt) || (msg.event.receipt.conversationId !== msg.conversationId && msg.event.receipt.originConversationId !== msg.conversationId))) return false;

    if (msg.event.receipt?.newConversationRequest) {
      const input = msg.event.receipt.newConversationRequest;

      if (input.context !== undefined && !isPageContext(input.context)) return false;

      if (input.attachments !== undefined && (!Array.isArray(input.attachments) || !input.attachments.every(isAttachment))) return false;
    }

    return true;
  },
  context_usage: (msg) => {
      const { used, window, model } = msg.event;

      if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(window) || window <= 0 || typeof model !== "string" || !model || model.length > 200) return false;

    return true;
  },
  user_delivery: (msg) => {
      if (!isUserDelivery(msg.event.delivery)) return false;

      if (msg.conversationId === undefined || msg.event.delivery.conversationId !== msg.conversationId) return false;

    return true;
  },
  user_delivery_stream: (msg) => {
      const s = msg.event.stream;

      if (!msg.conversationId || !s || !validRequestId(s.id) || (s.runId !== null && !validRequestId(s.runId))
        || !['ack','finding','reply'].includes(s.kind) || !['streaming','cancelled'].includes(s.phase)
        || typeof s.text !== 'string' || s.text.length > 2000) return false;

    return true;
  },
  worker_task: (msg) => {
      const e = msg.event;

      if (!msg.sessionId || isLeadSession(msg.sessionId)) return false;

      if (![e.task, e.output].every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 80)) return false;

      if (e.spawnToolCallId !== undefined && !validRequestId(e.spawnToolCallId)) return false;

    return true;
  },
  execution_feedback: (msg) => {
      if (!isExecutionFeedback(msg.event.feedback)) return false;

    return true;
  },
  memory_ask: (msg) => {
      const event = msg.event;

      if (!validMemoryId(event.askId) || !validMemoryText(event.rule) || !isMemoryScope(event.scope)) return false;

      if (event.replaces !== undefined && (!event.replaces || !validMemoryId(event.replaces.id) || !validMemoryText(event.replaces.text))) return false;

      if (event.hostname !== undefined && (typeof event.hostname !== "string" || normalizeMemoryHostname(event.hostname) !== event.hostname)) return false;

      if (event.outcome !== undefined && !["remembered", "already", "once", "closed"].includes(event.outcome)) return false;

      if (event.habit !== undefined && event.habit !== true) return false;

      if (event.evidence !== undefined && !(Array.isArray(event.evidence) && event.evidence.length <= 14 && event.evidence.every(line => typeof line === "string" && line.length <= 300))) return false;

      if (event.learned !== undefined && (!isMemoryEntry(event.learned) || event.learned.kind !== "method" || event.learned.status !== "active")) return false;

    return true;
  },
  site_notes: (msg) => {
      const event = msg.event;

      if (typeof event.host !== "string" || !event.host || event.host.length > 253 || (event.title !== undefined && (typeof event.title !== "string" || event.title.length > 80))) return false;

      if (!Array.isArray(event.notes) || !event.notes.length || event.notes.length > 3 || !event.notes.every(note => typeof note === "string" && note.length > 0 && note.length <= 200)) return false;

    return true;
  },
  memory: (msg) => {
      const event = msg.event;

      if (!["saved", "used", "updated", "forgotten"].includes(event.action) || !upgradeMemoryEntries(event.entries)) return false;

      if (event.message !== undefined && typeof event.message !== "string") return false;

      if (event.rev !== undefined && !(Number.isInteger(event.rev) && event.rev >= 0)) return false;

      if (event.tasks !== undefined && (!Array.isArray(event.tasks) || !event.tasks.every(isTaskHistoryEntry))) return false;

      if (event.hostname !== undefined && (typeof event.hostname !== "string" || normalizeMemoryHostname(event.hostname) !== event.hostname)) return false;

      if (event.replaced !== undefined && !upgradeMemoryEntries(event.replaced)) return false;

    return true;
  },
  error: (msg) => {
    if (msg.event.modelConnection !== undefined) {
      const c = msg.event.modelConnection;
      if (!c || typeof c.provider !== "string" || !c.provider || c.provider.length > 200 || typeof c.modelId !== "string" || !c.modelId || c.modelId.length > 300 || !validRequestId(c.runId) || (c.endpointHash !== undefined && (typeof c.endpointHash !== "string" || !/^[a-f0-9]{64}$/.test(c.endpointHash))) || (c.provider === "custom" && !c.endpointHash)) delete msg.event.modelConnection;
    }

    return true;
  },
};

const SERVER_CHECKS: { [T in ServerMessage["type"]]?: (msg: ServerOf<T>) => boolean } = {
  model_key_save_result: (msg) => validRequestId(msg.requestId) && typeof msg.ok === "boolean",
  model_key_test_result: (msg) => validRequestId(msg.requestId) && typeof msg.ok === "boolean" && (msg.ms === undefined || Number.isFinite(msg.ms)) && (msg.reason === undefined || isShortText(msg.reason)) && (msg.detail === undefined || isShortText(msg.detail)),
  site_note_delete_result: (msg) => validRequestId(msg.requestId) && typeof msg.ok === "boolean" && (msg.error === undefined || isShortText(msg.error)),
  site_note_list_result: (msg) => validRequestId(msg.requestId) && typeof msg.ok === "boolean" && (msg.error === undefined || isShortText(msg.error)) && (msg.notes === undefined || Array.isArray(msg.notes) && msg.notes.length <= 1000 && msg.notes.every((n: unknown) => { const v = n as { host?: unknown; text?: unknown; runId?: unknown } | null; return !!v && typeof v.host === "string" && normalizeMemoryHostname(v.host) === v.host && typeof v.text === "string" && v.text.length > 0 && v.text.length <= 200 && typeof v.runId === "string" && v.runId.length > 0 && v.runId.length <= 200; })),
  skill_operation_run_result: (msg) => validRequestId(msg.requestId) && typeof msg.ok === "boolean" && (msg.result === undefined || isLearnedOperationResult(msg.result)) && (msg.error === undefined || isShortText(msg.error)) && (msg.ok ? !!msg.result : typeof msg.error === "string" && !!msg.error),
  status: (msg) => isAgentRunState(msg.state),
  task_view: (msg) => isTaskView(msg.view),
  conversation_list: (msg) => Array.isArray(msg.conversations) && msg.conversations.every(isConversationSummary),
  tool_call: (msg) => (!(msg.programId !== undefined && !validRequestId(msg.programId))) && (!(msg.programDeadline !== undefined && (!Number.isSafeInteger(msg.programDeadline) || msg.programDeadline < 0 || !msg.programId))),
  conversation_updated: (msg) => isConversationSummary(msg.conversation),
  conversation_created: (msg) => isConversationSummary(msg.conversation) && validRequestId(msg.requestId),
  skill_operations_result: (msg) => {
      if (!validRequestId(msg.requestId) || (msg.ok !== true && msg.ok !== false)) return false;

      if (msg.operations !== undefined && (!Array.isArray(msg.operations) || !msg.operations.every(isSkillOperationSummary))) return false;

      if (msg.error !== undefined && !isShortText(msg.error)) return false;

    return true;
  },
  task_history_result: (msg) => {
      if (!validRequestId(msg.requestId) || (msg.ok !== true && msg.ok !== false)) return false;

      if (msg.tasks !== undefined && (!Array.isArray(msg.tasks) || !msg.tasks.every(isTaskHistoryEntry))) return false;

      if (msg.error !== undefined && !isShortText(msg.error)) return false;

    return true;
  },
  memory_result: (msg) => {
      if (!validRequestId(msg.requestId) || typeof msg.ok !== "boolean" || !["list", "update", "forget", "restore", "ask", "site", "unforget"].includes(msg.action)) return false;

      if (msg.entries !== undefined && !upgradeMemoryEntries(msg.entries)) return false;

      if (msg.entry !== undefined && !isStoredMemoryEntry(msg.entry)) return false;

      if (msg.entry !== undefined) msg.entry = upgradeMemoryEntry(msg.entry);

      if (msg.deletedId !== undefined && !validMemoryId(msg.deletedId)) return false;

      if (msg.error !== undefined && typeof msg.error !== "string") return false;

      if (msg.rev !== undefined && !(Number.isInteger(msg.rev) && msg.rev >= 0)) return false;

      if (msg.alreadySaved !== undefined && (msg.alreadySaved !== true || msg.action !== "ask" || !msg.entry)) return false;

      if (msg.askClosed !== undefined && (msg.askClosed !== true || msg.action !== "ask" || msg.ok)) return false;

      if (msg.ok && ((msg.action === "list" && !msg.entries) || (msg.action === "update" && !msg.entry) || (msg.action === "forget" && !msg.deletedId) || (msg.action === "restore" && !msg.entries?.length) || (msg.action === "site" && !msg.entry) || (msg.action === "unforget" && !msg.entries?.length))) return false;

      if (!msg.ok && (typeof msg.error !== "string" || !msg.error)) return false;

    return true;
  },
  control_result: (msg) => {
      if (!validRequestId(msg.requestId)) return false;

      if (msg.action !== "takeover" && msg.action !== "handback") return false;

      if (typeof msg.ok !== "boolean" || !isAgentRunState(msg.state)) return false;

      if (msg.reason !== undefined && typeof msg.reason !== "string") return false;

      if (msg.team !== undefined && !isTeamView(msg.team)) return false;

    return true;
  },
  team_status: (msg) => {
      if (msg.team !== null && !isTeamView(msg.team)) return false;

    return true;
  },
};

function validServerEnvelope(msg: ServerMessage): boolean {
  if (msg.conversationId !== undefined && !validConversationId(msg.conversationId)) return false;

  if (msg.runId !== undefined && msg.runId !== null && !taskId(msg.runId)) return false;

  if(msg.epochs!==undefined&&(!msg.epochs||typeof msg.epochs!=='object'||Array.isArray(msg.epochs)||!Object.entries(msg.epochs).every(([id,n])=>validOptionalSessionId(id)&&Number.isSafeInteger(n)&&n>=0)))return false;

  return true;
}

// WHY: 类型名来自外部消息，"constructor" 这样的名字会从原型链查到函数，只能认表里自己的项。
function checkFor(table: object, key: unknown): ((msg: never) => boolean) | undefined {
  return typeof key === "string" && Object.hasOwn(table, key) ? (table as Record<string, (msg: never) => boolean>)[key] : undefined;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw) as ServerMessage;

    if (!msg || typeof msg !== "object" || typeof msg.type !== "string" || !validServerEnvelope(msg)) return null;
    const self = checkFor(SELF_CHECKED_SERVER, msg.type);

    if (self) return self(msg as never) ? msg : null;

    if (msg.type === "agent_event" && !(checkFor(AGENT_EVENT_CHECKS, msg.event?.kind)?.(msg as never) ?? true)) return null;

    if ("sessionId" in msg && !validOptionalSessionId((msg as { sessionId?: unknown }).sessionId)) return null;

    return checkFor(SERVER_CHECKS, msg.type)?.(msg as never) ?? true ? msg : null;
  } catch {
    return null;
  }
}

function validOptionalSessionId(value: unknown): boolean {
  if (value === undefined) return true;

  return typeof value === "string" && value.length > 0 && value.length <= 32;
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 96;
}

const TEAM_PHASES: ReadonlySet<string> = new Set([
  "idle",
  "draining",
  "user",
  "restoring",
  "partial",
  "restored",
  "aborted",
]);

const TEAM_MEMBER_PHASES: ReadonlySet<string> = new Set([
  "running",
  "waiting_tool",
  "waiting_message",
  "draining",
  "user",
  "restoring",
  "restored",
  "paused_tab_closed",
  "paused_snapshot_failed",
  "aborted",
  "idle",
]);

function isTeamMemberView(v: unknown): v is TeamMemberView {
  if (!v || typeof v !== "object") return false;
  const m = v as TeamMemberView;

  if (typeof m.sessionId !== "string" || !m.sessionId || m.sessionId.length > 32) return false;

  if (m.role !== "lead" && m.role !== "worker") return false;

  if (!TEAM_MEMBER_PHASES.has(m.phase)) return false;

  if (m.activity !== undefined && m.activity !== "running" && m.activity !== "waiting_tool" && m.activity !== "waiting_message") return false;

  if (m.tabId !== undefined && typeof m.tabId !== "number") return false;

  if (m.title !== undefined && typeof m.title !== "string") return false;

  if (m.url !== undefined && typeof m.url !== "string") return false;

  if (m.reason !== undefined && typeof m.reason !== "string") return false;

  if (m.capturedAt !== undefined && typeof m.capturedAt !== "number") return false;

  return true;
}

export function isTeamView(v: unknown): v is TeamView {
  if (!v || typeof v !== "object") return false;
  const t = v as TeamView;

  if (typeof t.groupId !== "string" || !t.groupId || t.groupId.length > 64) return false;

  if (typeof t.generation !== "number" || !Number.isFinite(t.generation)) return false;

  if (!TEAM_PHASES.has(t.phase)) return false;

  if (typeof t.capturedAt !== "number" || !Number.isFinite(t.capturedAt)) return false;

  if (!Array.isArray(t.members) || t.members.length === 0 && t.phase !== "aborted") return false;

  return t.members.every(isTeamMemberView);
}

function isTeamFrozenMember(v: unknown): v is TeamFrozenMember {
  if (!v || typeof v !== "object") return false;
  const m = v as TeamFrozenMember;

  if (typeof m.sessionId !== "string" || !m.sessionId || m.sessionId.length > 32) return false;

  if (m.role !== "lead" && m.role !== "worker") return false;

  if (m.tabId !== undefined && typeof m.tabId !== "number") return false;

  if (m.title !== undefined && typeof m.title !== "string") return false;

  if (m.url !== undefined && typeof m.url !== "string") return false;

  if (m.activity !== undefined && m.activity !== "running" && m.activity !== "waiting_tool" && m.activity !== "waiting_message") {
    return false;
  }

  return true;
}

function isTeamMemberHandback(v: unknown): v is TeamMemberHandback {
  if (!v || typeof v !== "object") return false;
  const m = v as TeamMemberHandback;

  if (typeof m.sessionId !== "string" || !m.sessionId || m.sessionId.length > 32) return false;

  if ("closed" in m && (m as { closed?: unknown }).closed === true) {
    const reason = (m as { reason?: unknown }).reason;

    if (reason !== undefined && typeof reason !== "string") return false;

    return true;
  }

  if ("snapshotFailed" in m && (m as { snapshotFailed?: unknown }).snapshotFailed === true) {
    const reason = (m as { reason?: unknown }).reason;

    if (reason !== undefined && typeof reason !== "string") return false;
    const ctx = (m as { context?: unknown }).context;

    if (ctx !== undefined && !isPageContext(ctx)) return false;

    return true;
  }

  const open = m as { context?: unknown; snapshot?: unknown; capturedAt?: unknown };

  if (!isPageContext(open.context)) return false;

  if (typeof open.snapshot !== "string") return false;

  if (open.capturedAt !== undefined && typeof open.capturedAt !== "number") return false;

  return true;
}

export function validConversationId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }

export function isConversationSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as ConversationSummary;

  return validConversationId(item.id) && typeof item.title === "string" && item.title.length <= 120 &&
    Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt) && isAgentRunState(item.state) &&
    (item.mode === "act" || (item.mode as string) === "teach") && (item.model === undefined || typeof item.model === "string")
    && (item.runId === undefined || item.runId === null || taskId(item.runId))
    && (item.checkpoint === undefined || item.checkpoint === "interrupted" || item.checkpoint === "unavailable");
}

export interface PageElementSource {
  document: string;
  id: string;
  url: string;
  title: string;
  text: string;
  kind: 'section' | 'table' | 'code' | 'card' | 'selection';
}

export type MarginaliaMode = 'off' | 'source' | 'ai';

export interface ViewportSectionUpdate { source: PageElementSource; position: number; viewportHeight: number; index: number; tabId: number }

export type PageInteractionMessage =
  | { type: 'PINPOINT_DOM_TARGET'; action: 'identity'; tabId: number; url: string }
  | { type: 'PINPOINT_DOM_TARGET'; action: 'resolve'; query: string; tabId: number; document: string; url: string }
  | { type: 'PINPOINT_DOM_TARGET'; action: 'reveal'; source: PageElementSource; tabId: number }
  | { type: 'VIEWPORT_ACTIVE_SECTION'; action: 'update'; source: PageElementSource; position: number; viewportHeight: number; index: number }
  | { type: 'VIEWPORT_ACTIVE_SECTION'; action: 'track'; tabId: number; mode: MarginaliaMode }
  | { type: 'VIEWPORT_ACTIVE_SECTION'; action: 'track'; enabled: boolean }
  | { type: 'VIEWPORT_ACTIVE_SECTION'; action: 'ready' | 'clear' }
  | { type: 'FEED_DROPPED_ELEMENT'; action: 'offer'; token: string; source: PageElementSource }
  | { type: 'FEED_DROPPED_ELEMENT'; action: 'consume'; token: string }
  | { type: 'FEED_DROPPED_ELEMENT'; action: 'validate'; source: PageElementSource }
  | { type: 'GHOST_QUICK_ACTION'; action: GhostQuickAction | 'probe' }
  | { type: 'MEMORY_FIELD_MARK'; token: string; memory: { id: string; text: string; createdAt: number } }
  | { type: 'MEMORY_FIELD_FORGET'; id: string; requestId: string }
  | { type: 'CIRCLE_DRAWN'; n: number; rect: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number };  text?: string }
  | { type: 'CIRCLE_EXIT' };

export const GHOST_QUICK_ACTIONS = ['toggle_play', 'next', 'toggle_code'] as const;

export type GhostQuickAction = (typeof GHOST_QUICK_ACTIONS)[number];

export type GhostQuickReply =
  | { ok: true; available: GhostQuickAction[]; playing: boolean; codeFolded: boolean }
  | { ok: boolean; message: string; elapsedMs: number; playing: boolean; codeFolded: boolean };

export function isPageElementSource(value: unknown): value is PageElementSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<PageElementSource>;

  return typeof source.document === 'string' && source.document.length <= 80
    && typeof source.id === 'string' && source.id.length <= 80
    && typeof source.url === 'string' && source.url.length <= 4000
    && typeof source.title === 'string' && source.title.length <= 160
    && typeof source.text === 'string' && source.text.length > 0 && source.text.length <= 8000
    && source.kind !== undefined && ['section', 'table', 'code', 'card', 'selection'].includes(source.kind);
}

interface PageDocumentIdentity { document: string; url: string }

export function isPageDocumentIdentity(value: unknown): value is PageDocumentIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<PageDocumentIdentity>;

  return typeof identity.document === 'string' && identity.document.length > 0 && identity.document.length <= 80
    && typeof identity.url === 'string' && identity.url.length > 0 && identity.url.length <= 4000;
}

export function isPageInteractionMessage(value: unknown): value is PageInteractionMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<PageInteractionMessage>;
  const token = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 80;
  const tab = (input: number | undefined) => input !== undefined && Number.isSafeInteger(input) && input > 0;

  if (message.type === 'PINPOINT_DOM_TARGET') {
    if (!tab(message.tabId)) return false;

    if (message.action === 'reveal') return isPageElementSource(message.source);

    if (message.action === 'identity') return typeof message.url === 'string' && message.url.length > 0 && message.url.length <= 4000;

    return message.action === 'resolve' && token(message.document) && typeof message.url === 'string' && message.url.length <= 4000
      && typeof message.query === 'string' && message.query.length > 0 && message.query.length <= 200;
  }

  if (message.type === 'MEMORY_FIELD_MARK') {
    const memory = message.memory;

    return token(message.token) && !!memory && typeof memory === 'object' && token(memory.id) && typeof memory.text === 'string' && Number.isFinite(memory.createdAt);
  }

  if (message.type === 'MEMORY_FIELD_FORGET') return token(message.id) && token(message.requestId);

  if (message.type === 'CIRCLE_EXIT') return true;

  if (message.type === 'CIRCLE_DRAWN') {
    const rect = message.rect;
    const size = (v: number) => Number.isFinite(v) && v >= 0;

    if (message.text !== undefined && (typeof message.text !== 'string' || message.text.length > CIRCLE_NOTE_MAX)) return false;

    return Number.isSafeInteger(message.n) && (message.n ?? 0) > 0 && !!rect && typeof rect === 'object'
      && size(rect.x) && size(rect.y) && size(rect.width) && size(rect.height) && size(rect.viewportWidth) && size(rect.viewportHeight) && rect.viewportWidth > 0 && rect.viewportHeight > 0;
  }

  if (message.type === 'GHOST_QUICK_ACTION') return message.action === 'probe' || GHOST_QUICK_ACTIONS.includes(message.action as GhostQuickAction);

  if (message.type === 'FEED_DROPPED_ELEMENT') {
    if (message.action === 'validate') return isPageElementSource(message.source);

    if (message.action === 'consume') return token(message.token);

    return message.action === 'offer' && token(message.token) && isPageElementSource(message.source);
  }

  if (message.type !== 'VIEWPORT_ACTIVE_SECTION') return false;

  if (message.action === 'ready' || message.action === 'clear') return true;

  if (message.action === 'track') return 'enabled' in message ? typeof message.enabled === 'boolean' : 'tabId' in message && 'mode' in message && tab(message.tabId) && ['off', 'source', 'ai'].includes(message.mode ?? '');

  return message.action === 'update' && isPageElementSource(message.source) && message.position !== undefined && Number.isFinite(message.position)
    && message.position >= 0 && message.position <= 1 && message.viewportHeight !== undefined && Number.isFinite(message.viewportHeight) && message.viewportHeight > 0 && message.viewportHeight <= 20000 && message.index !== undefined && Number.isInteger(message.index) && message.index > 0 && message.index <= 2000;
}
