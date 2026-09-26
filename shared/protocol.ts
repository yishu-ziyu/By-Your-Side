import { isReadingClientMessage, isReadingEvent, isReadingTranscript, type ReadingClientMessage, type ReadingEvent, type ReadingTranscript } from "./reading.js";
import { isExecutionFeedback } from "./execution-feedback.js";
/**
 * SideAgent 桥接协议（扩展 side panel ⇆ 本地伴随进程）。
 * 传输：WebSocket，JSON 文本帧，一帧一条消息。
 * 服务端 = 伴随进程（agent 包），客户端 = side panel 页面。
 * 本文件是两侧共用的唯一权威定义；修改需两侧同步。
 */

import { isMemoryEntry, isMemoryScope, validMemoryId, validMemoryText, validMemoryVersion, type MemoryEntry, type MemoryScope } from "./memory.js";
import { isUserDelivery, isVoiceClientMessage, isVoiceServerMessage, type UserDelivery, type VoiceClientMessage, type VoiceServerMessage } from "./voice.js";
import { isTaskActionRequest, isTaskReceipt, taskId, type TaskActionRequest, type TaskReceipt } from "./task-actions.js";
import { isTaskView } from "./task-view.js";
import { isConsentRequest, type ConsentStatus, type ConsentRequest } from "./consent.js";
import { isSkillInputs, isSkillCandidate, validSkillId } from "./skill.js";

export const PROTOCOL_VERSION = 1;

export const STORAGE_SCHEMA_VERSION = 1;

export const HOST_VERSION = "0.2.0";

export const DEFAULT_PORT = 7758;

export const DEFAULT_HOST = "127.0.0.1";

/** Lead / 单会话路径的 sessionId；省略该字段即视为 Lead。 */
export const LEAD_SESSION_ID = "main";

export const DEFAULT_CONVERSATION_ID = "default";

export function normalizeConversationId(id?: string | null): string { return id ?? DEFAULT_CONVERSATION_ID; }

export interface ConversationSummary {
  id: string; title: string; createdAt: number; updatedAt: number;
  state: AgentRunState; model?: string; mode: AgentMode; runId?: string | null;
  /** A durable task checkpoint exists after the local host stopped mid-run. */
  checkpoint?: "interrupted" | "unavailable";
}

export function isLeadSession(sessionId?: string | null): boolean {
  return sessionId == null || sessionId === "" || sessionId === LEAD_SESSION_ID;
}

export function normalizeSessionId(sessionId?: string | null): string {
  return isLeadSession(sessionId) ? LEAD_SESSION_ID : sessionId!;
}

/** Agent 运行模式：act = 直接操作页面；teach = 教学倾向增强（默认引导用户手动操作，能力不裁剪）。 */
export type AgentMode = "act" | "teach";

// ── 客户端（扩展）→ 服务端（伴随进程） ──────────────────────────────

/** 用户消息附带的页面上下文：发送那一刻用户正在看的标签页（"这页面"类指代的锚点）。 */
export interface PageContext {
  tabId: number;
  title: string;
  url: string;
  /** 选中即问：用户划出来交给 Agent 的那段正文。缺省则行为与现在一样。 */
  selection?: { text: string };
}

/** 用户消息附带的附件材料（截图、粘贴图或上传图片）。 */
export interface ImageAttachment {
  id: string;
  type: "image";
  name: string;
  dataBase64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export type Attachment = ImageAttachment;

export function isAttachment(v: unknown): v is Attachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;

  if (typeof a.id !== "string" || !a.id || a.id.length > 128) return false;

  if (a.type !== "image") return false;

  if (typeof a.name !== "string" || a.name.length > 256) return false;

  if (typeof a.dataBase64 !== "string" || !a.dataBase64) return false;

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

/** idle = 无任务；running = Agent 在操作页面；user = 现在归你（任务还在，不是中止）。 */
export type AgentRunState = "idle" | "running" | "user";

export function isAgentRunState(v: unknown): v is AgentRunState {
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

export interface AcceptanceContinuityEvidence {
  sessionId: string;
  instanceId: string;
  taskId: string;
  step: "before" | "continued";
  active: boolean;
  expectedSnapshotMarker: string;
  resumedTabId?: number;
  snapshotMarkerFound?: boolean;
  preTaskPrompted?: boolean;
  preTaskAgentStarted?: boolean;
  contextTaskFound?: boolean;
  resumeRequested?: boolean;
  resumeAgentStarted?: boolean;
  resumeSnapshotToolCalled?: boolean;
  resumeSnapshotMarkerFound?: boolean;
  resumeContinuationMarkerFound?: boolean;
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

export type ClientMessage = ConversationEnvelope & (
  | VoiceClientMessage
  | ReadingClientMessage
  | { type: "memory_list"; requestId: string }
  | { type: "memory_update"; requestId: string; id: string; expectedVersion: number; text: string; scope: MemoryScope }
  | { type: "memory_forget"; requestId: string; id: string; expectedVersion: number }
  /** 示范录制编译成技能；steps 是示范期间用户自己的动作记录。
   *  updateId 存在时是"重新示范同一个技能"：内容替换、版本 +1，旧版本归档。 */
  | { type: "skill_compile"; requestId: string; intent: string; hostname: string; demoId: string; steps: import('./demo-record.js').DemoStep[]; updateId?: string; expectedVersion?: number }
  /** 忘记一份技能：删掉之后不再被检索到 */
  | { type: "skill_forget"; requestId: string; id: string }
  /** 列出某个站点上的技能（hostname 为空则列全部） */
  | { type: "skill_list"; requestId: string; hostname?: string }
  /** 按技能跑一遍：不叫模型，跑完写运行记录 */
  | { type: "skill_run"; requestId: string; id: string; expectedVersion?: number; inputs?: Record<string, string>; allowStale?: boolean }
  | { type: "skill_candidate_save"; requestId: string; id: string; sourceRunId: string }
  | { type: "skill_candidate_dismiss"; requestId: string; id: string; sourceRunId: string }
  /** 记一条修订线索（"这次不太对"），不改做法，下次重新示范时提醒 */
  | { type: "skill_note"; requestId: string; id: string; note: string }
  /** 回到上一版 */
  | { type: "skill_rollback"; requestId: string; id: string; expectedVersion?: number }
  | { type: "conversation_create"; requestId: string; title?: string; reading?: ReadingTranscript }
  | { type: "conversation_list"; requestId?: string }
  | { type: "hello"; token: string; client: "sidepanel"; protocol?: number; extensionVersion?: string; storageSchema?: number }
  | { type: "user_message"; text: string; context?: PageContext; attachments?: Attachment[] }
  | { type: "task_action"; request: TaskActionRequest }
  | { type: "task_receipt_query"; requestId: string }
  /** 重开侧栏/重连/切回会话时补取当前只读任务视图；不产生任务或权限。 */
  | { type: "task_view_query"; requestId: string }
  | { type: "steer"; text: string; context?: PageContext; attachments?: Attachment[] }
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
  | {
      /** 本地真实浏览器验收专用：先装配真实 worker session，再走正常接管协议。 */
      type: "acceptance_prepare_team";
      requestId: string;
      capability: string;
      live?:{leadGoal:string;workerGoal:string;leadContext?:PageContext;workerContext?:PageContext};
      worker: { sessionId: string; tabId: number };
      tasks: {
        lead: { taskId: string; expectedSnapshotMarker: string };
        worker: { taskId: string; expectedSnapshotMarker: string };
      };
    }
  | { type: "set_mode"; mode: AgentMode }
  | { type: "set_model"; model: string }
  | { type: "page_event"; event: "url_changed"; url: string; sessionId?: string }
  /** 授权选择：只允许现有请求的 id，参数与票据都在伴随进程手里（见 agent/src/fetch-consent.ts）。 */
  | { type: "consent_decision"; requestId: string; allow: boolean }
  /** 问一次本会话还在等待的授权请求（用于面板重连/重开时恢复卡片）。 */
  | { type: "consent_list" }
  | { type: "tool_result"; id: string; ok: boolean; data?: unknown; error?: string; executionFact?: ToolExecutionFact });

export interface ConversationEnvelope { conversationId?: string }

// ── 服务端 → 客户端 ────────────────────────────────────────────────

/** 可供选择的模型（已配置凭据的 provider 下），面板按 provider 分组展示。 */
export interface ModelOption {
  /** "provider/modelId" 形式，set_model 的取值 */
  id: string;
  provider: string;
  modelId: string;
  /** 展示名（SDK 目录里的 name） */
  name: string;
  /**
   * 是否在默认精选集内。agent 下发的是**全量**可达模型并逐个打标，
   * UI 默认只显示 featured，用户可展开查看全部；缺失视为 false。
   */
  featured?: boolean;
}

/** 宿主能提供的可选功能：没有存储的功能，侧栏不给入口。 */
export interface HostFeatures { memory: boolean; skills: boolean }

export type ServerMessage = ConversationEnvelope & {epochs?:Record<string,number>;runId?:string|null} & (
  | ReadingEvent
  | {type:'task_control';requestId:string;action:'pause'|'resume'|'abort';runId:string;scope?:'task'|'page';tabId?:number}
  | {type:'task_control_ack';requestId:string;action:'abort';ok:boolean}
  /** 有请求在等用户选择：目标、method、headers（敏感值已打码）与 body 原文，只展示这一次。 */
  | { type: "consent_request"; request: ConsentRequest }
  /** 一次确认的结局：allowed 只表示「已允许本次请求」，不代表已经发送或成功。 */
  | { type: "consent_result"; requestId: string; status: ConsentStatus; message: string }
  /** 本会话仍在等待的授权请求；按请求即时的期限，不被这次查询延长。 */
  | { type: "consent_list"; requests: ConsentRequest[] }
  | VoiceServerMessage
  | { type: "memory_result"; requestId: string; action: "list" | "update" | "forget"; ok: boolean; entries?: MemoryEntry[]; entry?: MemoryEntry; deletedId?: string; error?: string }
  | { type: "skill_result"; requestId: string; action: "compile" | "forget" | "list" | "run" | "note" | "rollback" | "candidate_save" | "candidate_dismiss"; ok: boolean; skill?: import('./skill.js').Skill; skills?: import('./skill.js').Skill[]; candidates?: import('./skill.js').SkillCandidate[]; runs?: Record<string, import('./skill.js').SkillRun[]>; run?: import('./skill.js').SkillRun; deletedId?: string; error?: string }
  | { type: "conversation_created"; requestId: string; conversation: ConversationSummary }
  | { type: "conversation_list"; requestId?: string; conversations: ConversationSummary[] }
  | { type: "conversation_updated"; conversation: ConversationSummary }
  | { type: "hello_ok"; version: number; model?: string; models?: ModelOption[]; hostVersion?: string; extensionVersion?: string; storageSchema?: number; /** 本伴随进程的剪贴板服务端口（127.0.0.1）；没有服务时省略 */ clipboardPort?: number; /** 这个宿主有没有记忆、技能存储（只装扩展时都没有）；缺省按有处理 */ features?: HostFeatures }
  | { type: "hello_error"; error: string }
  | { type: "model_info"; model?: string; models: ModelOption[] }
  | { type: "status"; state: AgentRunState; sessionId?: string }
  /** 只读任务视图投影（T02）：由真实状态生成，不是可执行命令，不证明业务成功。 */
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
  | { type: "team_status"; team: TeamView }
  | {
      type: "acceptance_team_ready";
      requestId: string;
      ok: boolean;
      members: string[];
      models?:Record<string,string>;
      continuity: AcceptanceContinuityEvidence[];
      reason?: string;
    }
  | {
      type: "acceptance_team_evidence";
      requestId: string;
      continuity: AcceptanceContinuityEvidence[];
    }
  | { type: "tool_call"; id: string; name: ToolName; params: Record<string, unknown>; sessionId?: string; programId?: string; /** 直连 display 调用身份；宿主区分帧族用，扩展不消费 */ sdkId?: string }
  | { type: "agent_event"; event: AgentUiEvent; sessionId?: string });

/** 渲染到聊天 UI 的 Agent 事件流（由 Pi SDK 事件映射而来）。 */
export type AgentUiEvent =
  | { kind: "worker_task"; task: string; output: string; spawnToolCallId?: string }
  | { kind: "memory"; action: "saved" | "used" | "updated" | "forgotten"; entries: MemoryEntry[]; message?: string }
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "tool_start"; toolCallId: string; name: string; params: Record<string, unknown>; valueHash?: string }
  | { kind: "tool_end"; toolCallId: string; name: string; isError: boolean; resultText: string; executionFact?: ToolExecutionFact; /** 用户在授权卡上拒绝了这一步：没执行，但不是失败。 */ declined?: true }
  /** 成功的只读页面读数，供结果账本建立写入前基线；只在伴随进程内使用，不下发侧栏。 */
  | { kind: "tool_observation"; toolCallId: string; name: string; target: string | null; tabId: number | null; workingTab: boolean; text: string; truncated: boolean; tabIds?: number[]; url?:string }
  /** 晚到/重复回执只按原调用身份关联；不携带页面内容。 */
  | { kind: "tool_late_result"; toolCallId: string; name: string; ok: boolean; executionFact: ToolExecutionFact }
  /**
   * 宿主执行反馈出口（V2）：简单成功进胶囊、失败／未知／等待确认保留可找到的文字入口。
   * 事实与文案由宿主生成，不由模型叙述；身份复用 inputId/toolCallId，便于去重与过期判断；
   * 频道（胶囊／语音／无）由 shared/execution-feedback 的事实规则决定。
   */
  | { kind: "execution_feedback"; feedback: import('./execution-feedback.js').ExecutionFeedback }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "agent_start"; deliveryMode?: "explicit" }
  | { kind: "agent_end" }
  | { kind: "run_stopped" }
  | { kind: "user_delivery"; delivery: UserDelivery }
  /** 模型为用户写的文本文件（artifacts 工具）：saved 带全文，侧栏画成可下载的卡片；deleted 只带文件名。 */
  | { kind: "artifact"; action: "saved" | "deleted"; filename: string; content?: string }
  | { kind: "user_delivery_stream"; stream: import('./voice.js').UserDeliveryStream }
  | { kind: "notice"; message: string; receipt?: TaskReceipt;plan?:import("./voice.js").VoicePlanSummary;
      /** 运行中的进度说明：只替换过程行标题，不进消息流，回合结束即被结果标题取代。 */
      progress?: true }
  | { kind: "error"; message: string };

// ── 工具契约 ───────────────────────────────────────────────────────

export const TOOL_NAMES = [
  "fetch",
  "network",
  "worker_tabs",
  "share_tab",
  "page_operation",
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
  "click",
  "hover",
  "fill",
  "type_text",
  "press_key",
  "scroll",
  "js",
  "screenshot",
  "observe_page",
  "ask_user_to_point",
  "mark",
  "clear_marks",
  "double_click",
  "drag",
  "upload_file",
  "cdp",
  /** CAP-02A：宿主签发 token 的事件订阅（popup/download/filechooser）。 */
  "arm_event",
  "wait_event",
  "disarm_event",
  "consume_events",
  "accept_dialog",
  "dismiss_dialog",
  "dialog_info",
  "file_chooser_set_files",
  "download_stat",
  "download_cancel",
  "download_delete",
  /** CAP-02B：扩展侧输入原语的正式 RPC（右键/偏移/wheel/按住/paste/HTML5 DnD）。 */
  "wheel",
  "mouse_down",
  "mouse_up",
  "key_down",
  "key_up",
  "release_held_inputs",
  "paste",
  "html5_drag",
  /** CAP-02C：原生 select 的 value/label/index、多选、清空（≠ 单值 fill）。 */
  "select_option",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** 就地确认按钮（长在拿住目标的光标名牌上）。id 决定点下去发给 Agent 的文本（confirm→确认，cancel→取消）。 */
export type MarkActionId = "confirm" | "cancel";

export interface MarkAction {
  id: MarkActionId;
  /** 按钮上的短文案，如「删除」「取消」 */
  label: string;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  /** 是否为 Agent 当前认领的工作标签页 */
  working: boolean;
}

/**
 * switch_tab 执行后读回的浏览器事实：只证明核验这一刻的状态——目标标签是其所属
 * 已聚焦窗口的活动标签、工作目标仍指向它；不宣称页面已加载、内容已读取或之后不会被切走。
 * 读取失败（目标消失/查询异常）时只有 verified:false，不伪造事实字段。
 * 旧回执没有该字段，仍按原 tabId 提供工作目标，但不能授权成功胶囊。
 */
export interface SwitchTabVerification {
  /** true 仅当：目标标签是其所属窗口的活动标签、该窗口处于聚焦状态、工作目标仍指向它 */
  verified: boolean;
  /** 核验时刻目标窗口内实际活动的标签页；读不到时缺省 */
  activeTabId?: number;
  windowId?: number;
  windowFocused?: boolean;
  /** 核验时刻的工作目标；null = 已无工作目标 */
  workingTabId?: number | null;
}

/**
 * 各工具的 params 与成功时 tool_result.data 形状。
 * 失败时 ok=false，error 为人类可读的一行描述。
 *
 * click/fill/select_option 的 target 支持：
 *   "@N" / "loc=css:..." / "loc=role:…[name=…]" / "loc=href:..." / "xpath=" / "text=" / 原生 CSS
 * click 也可用 point: [x, y] 视口坐标代替 target。
 */
export interface ToolContract {
  page_translation: { params: import('./page-translation.js').TranslationCommand; data: import('./page-translation.js').TranslationReceipt };
  /** 带着浏览器登录态取接口；只读，不改页面。响应体经 RPC 回伴随进程，不回侧栏。 */
  fetch: {
    params: { url: string; method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; savePath?: string; pages?: { from: number; to: number; step?: number } };
    data: { url: string; status: number; ok: boolean; contentType: string; bytes: number; truncated: boolean; text: string; readBytes?: number; totalBytes?: number | null; stoppedReason?: "complete" | "limit" | "deadline" | "abort" };
  };
  /** 被动看当前工作页真实发出过哪些请求（CDP Network 域环形缓冲）；只读，不改页面。 */
  network: {
    params: { tabId?: number; urlContains?: string; types?: string[] | "all"; limit?: number; clear?: boolean };
    /** inFlight/integrity：waitForNetworkIdle 的证据面；clear 只清展示 ring，不抹在途。 */
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
  worker_tabs: { params: { action: "inspect" | "release" | "claim"; tabId?: number; workerId?: string; expectedConversationId?: string | null }; data: { tabId?: number; tabIds?: number[]; workers: string[]; owned?: boolean; conversationId?: string | null; foreign?: boolean; members?: string[] } };
  share_tab: { params: { tabId: number; collaborators: string[]; remove?: string[] }; data: { tabId: number; collaborators: string[] } };
  page_operation: { params: { tabId?: number; target: string; expectedValue: string; value: string }; data: { tabId: number; target: string; previousValue: string; value: string; verified: true } };
  read_element: {
    params: { tabId?: number; target: string; /** Host-only adjunct read; never exposed in provider schemas. */ readback?: {documentId:string;deadline:number;nodeIdentity?: {kind:'ax';backendNodeId:number}} } & import('./element-state.js').ElementReadOptions;
    data: { tabId: number; target: string; tagName: string; textContent: string; editableText?: string; value?: string; scopeLabels?:string[]; documentId?: string; nodeIdentity?: {kind:'ax';backendNodeId:number}; anchorSource?: import('./demo-record.js').AnchorSource; properties?: Partial<Record<import('./element-state.js').ElementProperty, import('./element-state.js').ElementValue>>; check?: { matched: true; property: import('./element-state.js').ElementProperty; elapsedMs: number } };
  };
  /** 宿主自己读取一个选择器命中的全部元素（有界），供目标核验取证；不改页面，不能由模型替代提供。 */
  read_elements: {
    params: { tabId?: number; selector: string; limit?: number };
    data: {
      tabId: number; documentId?: string; selector: string;
      total: number; truncated: boolean;
      elements: Array<{
        index: number; tagName: string; text: string; visible: boolean;
        /** 只指向这一个元素的定位串（loc=css:），可直接交给 click/mark/read_element；页面上生成不出唯一路径时缺省。 */
        target?: string;
        rect: { x: number; y: number; width: number; height: number };
        style: { backgroundColor: string; color: string; outline: string; border: string; textDecoration: string; fontWeight: string };
        scopeLabels?: string[];
      }>;
    };
  };
  list_tabs: { params: Record<string, never>; data: { tabs: TabInfo[] } };
  /** 用户此刻正盯着的标签页（纯查询，不认领）；无活动标签时 tab 为 null */
  get_active_tab: { params: Record<string, never>; data: { tab: TabInfo | null } };
  open_tab: { params: { url?: string }; data: { tabId: number; url: string; title: string; readiness?: "interactive" | "complete" | "timeout"; waitMs?:number; documentId?:string } };
  switch_tab: { params: { tabId: number }; data: { tabId: number; verification?: SwitchTabVerification } };
  close_tab: { params: { tabId?: number }; data: { closed: true } };
  navigate: { params: { tabId?: number; url: string; timeout?: number }; data: { url: string; title: string; readiness?: "interactive" | "complete" | "timeout"; waitMs?:number; documentId?:string } };
  snapshot: { params: { tabId?: number; scope?: "full_page" | "viewport";decision?:boolean; /** Host continue-read cursor from a prior observation. */ cursor?: string; /** Host partition id from observation.scopes. */ viewScopeId?: string }; data: { text: string; tabId: number; documentId?:string; textEvidence?:import("./page-text-evidence.js").PageTextEvidence; url?:string; translation?:import("./page-translation.js").TranslationDisplayState|null;marks?:import("./host-marks.js").HostDrawnMark[];observation?:import('./browser-decision.js').BrowserObservation } };
  click: {
    params: {
      tabId?: number;
      target?: string;
      point?: [number, number];
      /** 相对 target 左上角的 CSS 像素；有绝对 point 时忽略。 */
      position?: import('./pointer-input.js').ElementPosition;
      button?: import('./pointer-input.js').MouseButton;
      clickCount?: number;
      force?: boolean;
      label?: string;
    };
    /** effect = 页面侧的效果证据（强证据才改变 changed）；拿不到读数时缺省。newTab = 点击开出的新标签页（已跟随）。 */
    data: { clicked: true; effect?: import('./effect.js').EffectReport; newTab?: { tabId: number; url?: string } } | { clicked: false; held: true };
  };
  /** 真实双击：与 click 同一解析/命中核对/effect 管线，CDP clickCount 1→2；destructive 目标同样先拿住等确认。 */
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
    data: { doubleClicked: true; effect?: import('./effect.js').EffectReport; newTab?: { tabId: number; url?: string } } | { doubleClicked: false; held: true };
  };
  /** 真实拖拽：from/to 各为 target 或视口 point；mousePressed→有界 mouseMoved 序列→release；destructive 源同样先拿住等确认。 */
  drag: {
    params: { tabId?: number; from: { target?: string; point?: [number, number] }; to: { target?: string; point?: [number, number] }; label?: string };
    data: { dragged: true; effect?: import('./effect.js').EffectReport } | { dragged: false; held: true };
  };
  /** CAP-02B：真实 mouseWheel；坐标来自 point/target(+position) 或会话指针。 */
  wheel: {
    params: {
      tabId?: number;
      deltaX?: number;
      deltaY?: number;
      point?: [number, number];
      target?: string;
      position?: import('./pointer-input.js').ElementPosition;
      label?: string;
    };
    /**
     * wheeled:true 只在整段手势（mouseMoved → 主 mouseWheel → 零 delta 收尾）的
     * blocking ACK 全部在预算内返回时出现。任何一步 ACK 超时都直接抛错、不返回成功包，
     * 也不得以 scrollTop= 或合成事件冒充。ackMs/attempts 供验收判据核对真实性。
     */
    data: { wheeled: true; point: [number, number]; ackMs: number; attempts: number };
  };
  mouse_down: {
    params: {
      tabId?: number;
      button?: import('./pointer-input.js').MouseButton;
      clickCount?: number;
      point?: [number, number];
      target?: string;
      position?: import('./pointer-input.js').ElementPosition;
    };
    data: { down: true; point: [number, number]; button: import('./pointer-input.js').MouseButton };
  };
  mouse_up: {
    params: {
      tabId?: number;
      button?: import('./pointer-input.js').MouseButton;
      clickCount?: number;
      point?: [number, number];
    };
    data: { up: true; point: [number, number]; button: import('./pointer-input.js').MouseButton };
  };
  key_down: {
    params: { tabId?: number; key: string };
    data: { down: true; key: string };
  };
  key_up: {
    params: { tabId?: number; key: string };
    data: { up: true; key: string };
  };
  /** 松开本会话仍按住的键与鼠标键（取消/异常安全路径）。 */
  release_held_inputs: {
    params: Record<string, never>;
    data: { releasedKeys: string[]; releasedButtons: import('./pointer-input.js').MouseButton[] };
  };
  /**
   * 富文本粘贴：经剪贴板桥写入 text/html 再 ControlOrMeta+V。
   * 无桥时扩展侧 BLOCKED；禁止合成 paste/innerHTML 冒充成功。
   */
  paste: {
    params: { tabId?: number; content: import('./pointer-input.js').PasteContent };
    data: { pasted: true; clipboard: import('./pointer-input.js').ClipboardFinishStatus };
  };
  /**
   * HTML5 DataTransfer 拖放。无 intercept 载荷时 data.gap，不得报成功。
   * syntheticData 仅测试桩，正式路径勿默认使用。
   */
  html5_drag: {
    params: {
      tabId?: number;
      from: { target?: string; point?: [number, number]; position?: import('./pointer-input.js').ElementPosition };
      to: { target?: string; point?: [number, number]; position?: import('./pointer-input.js').ElementPosition };
      label?: string;
      syntheticData?: {
        items: Array<{ mimeType: string; data: string; title?: string }>;
        files?: string[];
        dragOperationsMask?: number;
      };
    };
    data:
      | { dragged: true; path: "intercept" | "synthetic-data"; effect?: import('./effect.js').EffectReport }
      | { dragged: false; gap: "no_intercept_payload"; detail: string };
  };
  /** 给唯一 <input[type=file]> 设置授权路径（DOM.setFileInputFiles），以读回的 files 列表为证；不点系统文件选择器。 */
  upload_file: {
    params: { tabId?: number; target: string; paths: string[] };
    data: { uploaded: true; files: Array<{ name: string; size: number }>; documentId?: string };
  };
  /** 通用 CDP escape hatch：只绑当前 working tab，按 power tool 全走写闸门；越权 method 拒绝；结果有界截断。
   * （ToolContract 键名与 TOOL_NAMES、扩展 handlers、WRITE_TOOLS 同步扩展：double_click / drag / upload_file / cdp / CAP-02A 事件面 / CAP-02B 输入原语。） */
  cdp: {
    params: { tabId?: number; method: string; params?: Record<string, unknown>; timeoutMs?: number };
    data: { result: unknown; truncated: boolean };
  };
  /**
   * CAP-02A：在触发动作前 arm 事件。返回宿主签发的 token（模型不可伪造）。
   * download 由 Chrome 存进用户的下载文件夹；完成与否只看 chrome.downloads。
   */
  arm_event: {
    params: {
      tabId?: number;
      type: "popup" | "download" | "filechooser";
      timeoutMs?: number;
    };
    data: { token: string; type: "popup" | "download" | "filechooser"; tabId: number; timeoutMs: number };
  };
  /**
   * 等待已 arm 的 token 匹配并一次消费；未匹配前阻塞到超时。
   * download 匹配后再等 chrome.downloads 报完成或中断（默认最多 60 秒）；completed 只在 Chrome 报 complete 时为 true。
   */
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
        /** chrome.downloads 的错误码（如 NETWORK_FAILED、USER_CANCELED）；null 表示没有中断。 */
        failure: string | null;
        completed: boolean;
        /** 完成后 Chrome 写入的绝对路径与字节数。 */
        path?: string;
        bytes?: number;
        /** Chrome 判为可能有害、等用户确认保留时的 danger 值。 */
        danger?: string;
      };
      fileChooser?: { chooserId: string; multiple: boolean; backendNodeId: number };
    };
  };
  /** 取消尚未消费的 arm；停止任务后迟到事件不得再匹配。 */
  disarm_event: {
    params: { token: string };
    data: { disarmed: true; token: string; status: string };
  };
  /** 读清本页缓冲的协议事件（popup/download/dialog/filechooser），非常规 EventEmitter。 */
  consume_events: {
    params: { tabId?: number; clear?: boolean };
    data: { tabId: number; events: Array<{ kind: string; at: number; payload: Record<string, unknown> }> };
  };
  /** 接受当前网页 JS dialog（alert/confirm/prompt）；无 dialog 返回 accepted:false。不等于危险业务授权。 */
  accept_dialog: {
    params: { tabId?: number; promptText?: string };
    data: { accepted: boolean; dialog?: { type: string; message: string; tabId: number; url?: string } };
  };
  dismiss_dialog: {
    params: { tabId?: number };
    data: { dismissed: boolean; dialog?: { type: string; message: string; tabId: number; url?: string } };
  };
  /** 观察当前未处理的网页 JS dialog（类型/消息/页面归属）；不含浏览器权限/设备提示。 */
  dialog_info: {
    params: { tabId?: number };
    data: { dialog: null | { type: string; message: string; tabId: number; url?: string; defaultPrompt?: string } };
  };
  /**
   * 动态 file chooser：对已 wait 到的 chooser 设文件。路径须经宿主 TaskUploadLedger 授权；
   * 禁止经 raw cdp DOM.setFileInputFiles 绕过。上传后若立刻弹 JS dialog，回执含 dialog。
   */
  file_chooser_set_files: {
    params: { tabId?: number; chooserId: string; paths: string[] };
    data: {
      set: true;
      multiple: boolean;
      files: Array<{ name: string; size: number }>;
      dialog?: { type: string; message: string; tabId: number; url?: string };
    };
  };
  /**
   * 宿主侧 download.saveAs（非 extension RPC）：等待下载完成后复制到获准绝对路径。
   * browser_run helper / tools.ts 实现；不把 fetch(GET) 当下载。
   */
  download_save_as: {
    params: { downloadId: string; path: string; timeoutMs?: number };
    data: { saved: true; path: string; bytes: number; suggestedFilename: string; url: string; tabId: number };
  };
  download_stat: {
    params: { downloadId: string };
    data: {
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
    };
  };
  download_cancel: {
    params: { downloadId: string };
    /** cancelled 只在 Chrome 报 USER_CANCELED 时为 true；已下完的不会被取消。 */
    data: { cancelled: boolean; completed: boolean; downloadId: string; failure: string | null };
  };
  download_delete: {
    params: { downloadId: string };
    data: { deleted: true; downloadId: string };
  };
  /** 真实鼠标移动；hovered 仅表示事件已派发，页面变化需另行观察。 */
  hover: {
    params: { tabId?: number; target?: string; point?: [number, number]; label?: string };
    data: { hovered: true };
  };
  fill: { params: { tabId?: number; target: string; value: string; /** Bound by the host from a pre-write observation. */ expectedDocumentId?: string; expectedBackendNodeId?: number }; data: { filled: true } };
  /** CAP-02C：原生 <select>；values 为 string/{value,label,index}/数组；null 或 [] 清空。 */
  select_option: {
    params: {
      tabId?: number;
      target: string;
      values: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }> | null;
      expectedDocumentId?: string;
      expectedBackendNodeId?: number;
    };
    data: { selected: string[]; labels: string[] };
  };
  type_text: { params: { tabId?: number; text: string }; data: { typed: true } };
  press_key: { params: { tabId?: number; key: string }; data: { pressed: true } };
  scroll: { params: { tabId?: number; dy?: number; toBottom?: boolean }; data: { atBottom: boolean } };
  js: { params: { tabId?: number; code: string }; data: { value: unknown } };
  observe_page: {params:{token:string;mode?:'text'|'image'};data:unknown};
  screenshot: {
    params: {
      tabId?: number;
      /** 可滚动全页；与 clip 互斥时 clip 优先。 */
      fullPage?: boolean;
      /** 文档 CSS 坐标矩形。click 的 point 使用视口坐标，须扣除当前滚动。 */
      clip?: { x: number; y: number; width: number; height: number; scale?: number };
      /** css=按 CSS 像素尺寸输出（默认）；raw=设备像素。 */
      scale?: "css" | "raw";
    };
    data: {
      imageBase64: string;
      mediaType: "image/png";
      /** PNG 解码实测的正数像素宽高；解码失败则整个调用失败。 */
      width: number;
      height: number;
      pixelWidth: number;
      pixelHeight: number;
      /** 捕获区域的 CSS 宽高；并非该区域在视口中的原点。查不到为 0。 */
      cssWidth: number;
      cssHeight: number;
      /** 查不到为 0。 */
      devicePixelRatio: number;
      tabId: number;
      url: string;
      title: string;
      capturedAt: number;
      /** cdp = 后台页直接捕获；visible-tab = 已核对工作页在前台后的可见捕获。 */
      source: "cdp" | "visible-tab";
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number; scale?: number };
      scale?: "css" | "raw";
      documentId?: string;
      /** viewportPoint = imagePixel / density + origin - scroll。新文档/滚动后须重新观察。 */
      coordinates?: {
        origin: { x: number; y: number };
        scroll: { x: number; y: number };
        viewport: { width: number; height: number };
        pixelsPerCssPixel: number;
        space: "document";
      } | null;
    };
  };
  /** 等待用户指出主文档里的元素；选择本身不激活网页控件。 */
  ask_user_to_point: { params: { tabId?: number; message?: string }; data: import("./point-selection.js").PointSelectionReceipt };
  /** 在元素处画持久标注（描边框+名牌），锚定文档坐标，滚动不漂移；through 为同一行的结束 ref，一个框从 target 圈到它 */
  mark: { params: { tabId?: number; target: string; through?: string; label?: string; actions?: MarkAction[] }; data: { marked: true } };
  /** 清除全部 mark 标注 */
  clear_marks: { params: {tabId?: number}; data: { cleared: true } };
}

// ── 编解码守卫 ─────────────────────────────────────────────────────

const CONSENT_STATUSES: ReadonlySet<string> = new Set(["allowed", "rejected", "expired", "cancelled"]);

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;

    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;

    if (msg.conversationId !== undefined && !validConversationId(msg.conversationId)) return null;

    if (msg.type === "reading_request" || msg.type === "reading_cancel") return isReadingClientMessage(msg) ? msg : null;

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
        && (r.attachments === undefined || Array.isArray(r.attachments) && r.attachments.every(isAttachment)) ? msg : null;
    }

    if (msg.type === "task_receipt_query") return validRequestId(msg.requestId) ? msg : null;

    if (msg.type === "task_view_query") return validRequestId(msg.requestId) ? msg : null;

    if(msg.type==='task_control_result')return validRequestId(msg.requestId)&&taskId(msg.runId)&&['pause','resume','abort'].includes(msg.action)&&typeof msg.ok==='boolean'
      &&(msg.reason===undefined||typeof msg.reason==='string'&&msg.reason.length<=1000)&&(msg.uncertain===undefined||typeof msg.uncertain==='boolean')&&(msg.partial===undefined||typeof msg.partial==='boolean')?msg:null;

    if((msg.type==='takeover'||msg.type==='handback'||msg.type==='abort')&&msg.taskRequestId!==undefined&&!validRequestId(msg.taskRequestId))return null;

    if (msg.type.startsWith("memory_")) {
      if (msg.type !== "memory_list" && msg.type !== "memory_update" && msg.type !== "memory_forget") return null;

      if (!validRequestId(msg.requestId)) return null;

      if (msg.type !== "memory_list" && (!validMemoryId(msg.id) || !validMemoryVersion(msg.expectedVersion))) return null;

      if (msg.type === "memory_update" && (!validMemoryText(msg.text) || !isMemoryScope(msg.scope))) return null;
    }

    if (msg.type === "skill_compile") {
      if (!validRequestId(msg.requestId) || typeof msg.intent !== "string" || msg.intent.length > 500) return null;

      if (typeof msg.hostname !== "string" || typeof msg.demoId !== "string") return null;

      if (!Array.isArray(msg.steps) || msg.steps.length < 1 || msg.steps.length > 200) return null;
    }

    if (msg.type === "skill_forget" && (!validRequestId(msg.requestId) || typeof msg.id !== "string")) return null;

    if (msg.type === "skill_list" && (!validRequestId(msg.requestId) || (msg.hostname !== undefined && typeof msg.hostname !== "string"))) return null;

    if (msg.type === "skill_run") {
      if (!validRequestId(msg.requestId) || typeof msg.id !== "string") return null;

      if (msg.expectedVersion !== undefined && !Number.isInteger(msg.expectedVersion)) return null;

      if (msg.inputs !== undefined && !isSkillInputs(msg.inputs)) return null;

      if (msg.allowStale !== undefined && typeof msg.allowStale !== "boolean") return null;
    }

    if (msg.type === "skill_candidate_save" || msg.type === "skill_candidate_dismiss") {
      if (!validRequestId(msg.requestId) || !validSkillId(msg.id) || typeof msg.sourceRunId !== "string" || !msg.sourceRunId || msg.sourceRunId.length > 128) return null;
    }

    if (msg.type === "skill_note") {
      if (!validRequestId(msg.requestId) || typeof msg.id !== "string") return null;

      if (typeof msg.note !== "string" || !msg.note.trim() || msg.note.length > 300) return null;
    }

    if (msg.type === "skill_rollback") {
      if (!validRequestId(msg.requestId) || typeof msg.id !== "string") return null;

      if (msg.expectedVersion !== undefined && !Number.isInteger(msg.expectedVersion)) return null;
    }

    if (msg.type === "conversation_create" && (!validRequestId(msg.requestId) || (msg.title !== undefined && (typeof msg.title !== "string" || msg.title.length > 120)))) return null;

    if (msg.type === "conversation_list" && msg.requestId !== undefined && !validRequestId(msg.requestId)) return null;

    if (msg.type === "set_mode" && msg.mode !== "teach" && msg.mode !== "act") return null;

    if (msg.type === "set_model" && (typeof msg.model !== "string" || !msg.model)) return null;

    if (msg.type === "consent_decision") return validRequestId(msg.requestId) && typeof msg.allow === "boolean" ? msg : null;

    if (msg.type === "consent_list") return msg;

    if (msg.type === "page_event") {
      if (msg.event !== "url_changed" || typeof msg.url !== "string") return null;

      if (!validOptionalSessionId(msg.sessionId)) return null;
    }

    if (
      (msg.type === "user_message" || msg.type === "steer") &&
      msg.context !== undefined &&
      !isPageContext(msg.context)
    ) {
      return null;
    }

    if (
      (msg.type === "user_message" || msg.type === "steer") &&
      msg.attachments !== undefined &&
      (!Array.isArray(msg.attachments) || !msg.attachments.every(isAttachment))
    ) {
      return null;
    }

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

    if (msg.type === "acceptance_prepare_team") {
      if (!validRequestId(msg.requestId)) return null;

      if (typeof msg.capability !== "string" || msg.capability.length < 32 || msg.capability.length > 128) return null;

      if (!msg.worker || typeof msg.worker !== "object") return null;

      if (!validOptionalSessionId(msg.worker.sessionId) || msg.worker.sessionId === undefined) return null;

      if (typeof msg.worker.tabId !== "number" || !Number.isFinite(msg.worker.tabId)) return null;

      if (!isAcceptanceTask(msg.tasks?.lead) || !isAcceptanceTask(msg.tasks?.worker)) return null;

      if(msg.live!==undefined&&(!msg.live||typeof msg.live.leadGoal!=='string'||!msg.live.leadGoal.trim()||msg.live.leadGoal.length>12000||typeof msg.live.workerGoal!=='string'||!msg.live.workerGoal.trim()||msg.live.workerGoal.length>12000||(msg.live.leadContext!==undefined&&!isPageContext(msg.live.leadContext))||(msg.live.workerContext!==undefined&&!isPageContext(msg.live.workerContext))))return null;
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

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw) as ServerMessage;

    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;

    if (msg.conversationId !== undefined && !validConversationId(msg.conversationId)) return null;

    if(msg.runId!==undefined&&msg.runId!==null&&!taskId(msg.runId))return null;

    if(msg.epochs!==undefined&&(!msg.epochs||typeof msg.epochs!=='object'||Array.isArray(msg.epochs)||!Object.entries(msg.epochs).every(([id,n])=>validOptionalSessionId(id)&&Number.isSafeInteger(n)&&n>=0)))return null;

    if (msg.type === 'reading_event') return isReadingEvent(msg) ? msg : null;

    if(msg.type==='task_control')return validRequestId(msg.requestId)&&taskId(msg.runId)&&['pause','resume','abort'].includes(msg.action)&&(msg.scope===undefined||msg.scope==='task'||msg.scope==='page')&&(msg.tabId===undefined||Number.isSafeInteger(msg.tabId)&&msg.tabId>0)?msg:null;

    if(msg.type==='task_control_ack')return validRequestId(msg.requestId)&&msg.action==='abort'&&typeof msg.ok==='boolean'?msg:null;

    if (msg.type === "consent_request") {
      return isConsentRequest(msg.request) && msg.request.conversationId === msg.conversationId ? msg : null;
    }

    if (msg.type === "consent_result") {
      return validRequestId(msg.requestId) && CONSENT_STATUSES.has(msg.status)
        && typeof msg.message === "string" && msg.message.length > 0 && msg.message.length <= 500 ? msg : null;
    }

    if (msg.type === "consent_list") {
      return Array.isArray(msg.requests) && msg.requests.every(isConsentRequest) ? msg : null;
    }

    if (msg.type === "voice") return isVoiceServerMessage(msg) ? msg : null;

    if(msg.type==='agent_event'&&msg.event?.kind==='notice'&&msg.event.plan!==undefined){
      const p=msg.event.plan;

      if(!p||!validRequestId(p.id)||p.conversationId!==msg.conversationId||!Number.isFinite(p.updatedAt)||!Array.isArray(p.steps)||p.steps.length<1||p.steps.length>3||!p.steps.every(s=>s&&typeof s.action==='string'&&typeof s.text==='string'&&s.text.length<=12000&&validConversationId(s.targetId)&&(s.targetTitle===undefined||typeof s.targetTitle==='string'&&s.targetTitle.length<=120)&&['pending','complete','unexecuted'].includes(s.status)&&(s.receipt===undefined||isTaskReceipt(s.receipt)&&s.receipt.conversationId===s.targetId)))return null;
    }

    if (msg.type === "agent_event" && msg.event?.kind === "user_delivery") {
      if (!isUserDelivery(msg.event.delivery)) return null;

      if (msg.conversationId === undefined || msg.event.delivery.conversationId !== msg.conversationId) return null;
    }

    if (msg.type === 'agent_event' && msg.event?.kind === 'user_delivery_stream') {
      const s = msg.event.stream;

      if (!msg.conversationId || !s || !validRequestId(s.id) || (s.runId !== null && !validRequestId(s.runId))
        || !['ack','finding','reply'].includes(s.kind) || !['streaming','cancelled'].includes(s.phase)
        || typeof s.text !== 'string' || s.text.length > 2000) return null;
    }

    if (msg.type === "agent_event" && msg.event?.kind === "notice" && msg.event.receipt !== undefined
      && (!isTaskReceipt(msg.event.receipt) || (msg.event.receipt.conversationId !== msg.conversationId && msg.event.receipt.originConversationId !== msg.conversationId))) return null;

    if (msg.type === 'agent_event' && msg.event?.kind === 'notice' && msg.event.receipt?.newConversationRequest) {
      const input = msg.event.receipt.newConversationRequest;

      if (input.context !== undefined && !isPageContext(input.context)) return null;

      if (input.attachments !== undefined && (!Array.isArray(input.attachments) || !input.attachments.every(isAttachment))) return null;
    }

    if (msg.type === "memory_result") {
      if (!validRequestId(msg.requestId) || typeof msg.ok !== "boolean" || !["list", "update", "forget"].includes(msg.action)) return null;

      if (msg.entries !== undefined && (!Array.isArray(msg.entries) || !msg.entries.every(isMemoryEntry))) return null;

      if (msg.entry !== undefined && !isMemoryEntry(msg.entry)) return null;

      if (msg.deletedId !== undefined && !validMemoryId(msg.deletedId)) return null;

      if (msg.error !== undefined && typeof msg.error !== "string") return null;

      if (msg.ok && ((msg.action === "list" && !msg.entries) || (msg.action === "update" && !msg.entry) || (msg.action === "forget" && !msg.deletedId))) return null;

      if (!msg.ok && (typeof msg.error !== "string" || !msg.error)) return null;
    }

    if (msg.type === "skill_result") {
      if (!validRequestId(msg.requestId) || typeof msg.ok !== "boolean" || !["compile", "forget", "list", "run", "note", "rollback", "candidate_save", "candidate_dismiss"].includes(msg.action)) return null;

      if (msg.ok && (msg.action === "compile" || msg.action === "run" || msg.action === "note" || msg.action === "rollback") && (!msg.skill || typeof msg.skill.program !== "string" || !Array.isArray(msg.skill.steps))) return null;

      if (msg.ok && msg.action === "forget" && typeof msg.deletedId !== "string") return null;

      if (msg.ok && msg.action === "list" && (!Array.isArray(msg.skills) || (msg.runs !== undefined && typeof msg.runs !== "object"))) return null;

      if (msg.candidates !== undefined && (!Array.isArray(msg.candidates) || msg.candidates.length > 30 || !msg.candidates.every(isSkillCandidate))) return null;

      if (msg.ok && msg.action === "candidate_save" && (!msg.skill || !validSkillId(msg.skill.id))) return null;

      if (!msg.ok && (typeof msg.error !== "string" || !msg.error)) return null;
    }

    if (msg.type === "agent_event" && msg.event?.kind === "worker_task") {
      const e = msg.event;

      if (!msg.sessionId || isLeadSession(msg.sessionId)) return null;

      if (![e.task, e.output].every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 80)) return null;

      if (e.spawnToolCallId !== undefined && !validRequestId(e.spawnToolCallId)) return null;
    }

    if (msg.type === "agent_event" && msg.event?.kind === "execution_feedback") {
      if (!isExecutionFeedback(msg.event.feedback)) return null;
    }

    if (msg.type === "agent_event" && msg.event?.kind === "memory") {
      const event = msg.event;

      if (!["saved", "used", "updated", "forgotten"].includes(event.action) || !Array.isArray(event.entries) || !event.entries.every(isMemoryEntry)) return null;

      if (event.message !== undefined && typeof event.message !== "string") return null;
    }

    if ("sessionId" in msg && !validOptionalSessionId((msg as { sessionId?: unknown }).sessionId)) return null;

    if ((msg.type === "conversation_created" || msg.type === "conversation_updated") && !isConversationSummary(msg.conversation)) return null;

    if (msg.type === "conversation_created" && !validRequestId(msg.requestId)) return null;

    if (msg.type === "conversation_list" && (!Array.isArray(msg.conversations) || !msg.conversations.every(isConversationSummary))) return null;

    if (msg.type === "tool_call" && msg.programId !== undefined && !validRequestId(msg.programId)) return null;

    if (msg.type === "status" && !isAgentRunState(msg.state)) return null;

    if (msg.type === "task_view" && !isTaskView(msg.view)) return null;

    if (msg.type === "control_result") {
      if (!validRequestId(msg.requestId)) return null;

      if (msg.action !== "takeover" && msg.action !== "handback") return null;

      if (typeof msg.ok !== "boolean" || !isAgentRunState(msg.state)) return null;

      if (msg.reason !== undefined && typeof msg.reason !== "string") return null;

      if (msg.team !== undefined && !isTeamView(msg.team)) return null;
    }

    if (msg.type === "team_status") {
      if (!isTeamView(msg.team)) return null;
    }

    if (msg.type === "acceptance_team_ready") {
      if(msg.models!==undefined&&(!msg.models||typeof msg.models!=="object"||Array.isArray(msg.models)||!Object.entries(msg.models).every(([id,model])=>validOptionalSessionId(id)&&typeof model==="string"&&model.length<=200)))return null;

      if (!validRequestId(msg.requestId) || typeof msg.ok !== "boolean") return null;

      if (!Array.isArray(msg.members) || !msg.members.every((id) => validOptionalSessionId(id) && id !== undefined)) return null;

      if (!Array.isArray(msg.continuity) || !msg.continuity.every(isAcceptanceContinuityEvidence)) return null;

      if (msg.reason !== undefined && typeof msg.reason !== "string") return null;
    }

    if (msg.type === "acceptance_team_evidence") {
      if (!validRequestId(msg.requestId)) return null;

      if (!Array.isArray(msg.continuity) || !msg.continuity.every(isAcceptanceContinuityEvidence)) return null;
    }

    return msg;
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

function isAcceptanceTask(value: unknown): value is { taskId: string; expectedSnapshotMarker: string } {
  if (!value || typeof value !== "object") return false;
  const task = value as { taskId?: unknown; expectedSnapshotMarker?: unknown };

  return validRequestId(task.taskId) && typeof task.expectedSnapshotMarker === "string" && task.expectedSnapshotMarker.length > 0;
}

function isAcceptanceContinuityEvidence(value: unknown): value is AcceptanceContinuityEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<AcceptanceContinuityEvidence>;

  if (!validOptionalSessionId(evidence.sessionId) || evidence.sessionId === undefined) return false;

  if (typeof evidence.instanceId !== "string" || !evidence.instanceId) return false;

  if (!validRequestId(evidence.taskId)) return false;

  if (evidence.step !== "before" && evidence.step !== "continued") return false;

  if (typeof evidence.active !== "boolean") return false;

  if (typeof evidence.expectedSnapshotMarker !== "string" || !evidence.expectedSnapshotMarker) return false;

  if (evidence.resumedTabId !== undefined && typeof evidence.resumedTabId !== "number") return false;

  if (evidence.snapshotMarkerFound !== undefined && typeof evidence.snapshotMarkerFound !== "boolean") return false;

  for (const field of [
    "preTaskPrompted",
    "preTaskAgentStarted",
    "contextTaskFound",
    "resumeRequested",
    "resumeAgentStarted",
    "resumeSnapshotToolCalled",
    "resumeSnapshotMarkerFound",
    "resumeContinuationMarkerFound",
  ] as const) {
    if (evidence[field] !== undefined && typeof evidence[field] !== "boolean") return false;
  }

  return true;
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

  if (!Array.isArray(t.members) || t.members.length === 0) return false;

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

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as ConversationSummary;

  return validConversationId(item.id) && typeof item.title === "string" && item.title.length <= 120 &&
    Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt) && isAgentRunState(item.state) &&
    (item.mode === "act" || item.mode === "teach") && (item.model === undefined || typeof item.model === "string")
    && (item.runId === undefined || item.runId === null || taskId(item.runId))
    && (item.checkpoint === undefined || item.checkpoint === "interrupted" || item.checkpoint === "unavailable");
}
