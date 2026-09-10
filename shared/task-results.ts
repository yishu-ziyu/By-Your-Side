import { taskId } from "./task-actions.js";

export const TASK_RESULT_STATES = ["unregistered", "pending", "satisfied", "blocked", "unknown"] as const;
export type TaskResultState = (typeof TASK_RESULT_STATES)[number];
export const TASK_RESULT_ITEM_STATUSES = ["pending", "satisfied", "blocked", "unknown"] as const;
export type TaskResultItemStatus = (typeof TASK_RESULT_ITEM_STATUSES)[number];

/** Intent-only registration. Status/completion cannot be declared here. */
export interface TaskResultRegistration {
  id: string;
  description: string;
  tool: string;
  target: string | null;
}

export interface TaskResultEvidence {
  toolCallId: string;
  tool: string;
  target: string | null;
  member: string;
  runId: string;
  /** 该结果被判定为未决的时刻；核查读数必须晚于它。旧快照可缺省。 */
  observedAt?: number;
}

export interface TaskResultItem extends TaskResultRegistration {
  status: TaskResultItemStatus;
  evidence: TaskResultEvidence | null;
}

export const TASK_RESULT_META_TOOLS = ["record_task_results", "send_user_message", "resolve_unknown_result"] as const;

/** 只有这些真实只读工具回执可以充当解除未决的页面证据。 */
export const RESULT_VERIFY_READ_TOOLS = ["read_element", "snapshot"] as const;

/** 页面身份类工具：执行后当前文档/工作页可能改变，此前读数不能再当作前后对比基线。 */
export const PAGE_IDENTITY_TOOLS = ["navigate", "open_tab", "switch_tab", "close_tab", "worker_tabs", "page_operation", "js"] as const;

/** 单条读数的完整文本上限；超过即标记截断，不能作为前后对比基线。 */
export const RESULT_OBSERVATION_TEXT_MAX = 50_000;
/** 账本保留的最近读数条数。 */
export const RESULT_OBSERVATION_KEEP = 8;

export interface ResultPageObservation {
  toolCallId: string;
  tool: string;
  target: string | null;
  tabId: number | null;
  /** 读数发生在该成员的工作页（未显式指定 tabId）；写入只发生在工作页，只有这种读数可作基线。 */
  workingTab: boolean;
  text: string;
  truncated: boolean;
  at: number;
  member: string;
  runId: string;
}

export function isPageIdentityTool(name: string): boolean {
  return (PAGE_IDENTITY_TOOLS as readonly string[]).includes(name);
}

export function normalizeResultEvidence(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length >= 1 && v.length <= max;

export function isTaskResultEvidence(v: unknown): v is TaskResultEvidence {
  if (!v || typeof v !== "object") return false;
  const e = v as TaskResultEvidence;
  return taskId(e.toolCallId) && text(e.tool, 100) && text(e.member, 128) && taskId(e.runId)
    && (e.target === null || text(e.target, 500))
    && (e.observedAt === undefined || Number.isFinite(e.observedAt));
}

export function isTaskResultItem(v: unknown): v is TaskResultItem {
  if (!v || typeof v !== "object") return false;
  const r = v as TaskResultItem;
  return taskId(r.id) && text(r.description, 600) && text(r.tool, 100)
    && (r.target === null || text(r.target, 500))
    && TASK_RESULT_ITEM_STATUSES.includes(r.status)
    && (r.evidence === null || isTaskResultEvidence(r.evidence));
}

export function isTaskResultState(v: unknown): v is TaskResultState {
  return typeof v === "string" && (TASK_RESULT_STATES as readonly string[]).includes(v);
}

export function resultStateOf(items: readonly TaskResultItem[]): TaskResultState {
  if (items.length === 0) return "unregistered";
  if (items.some(item => item.status === "unknown")) return "unknown";
  if (items.some(item => item.status === "blocked")) return "blocked";
  if (items.some(item => item.status === "pending")) return "pending";
  return "satisfied";
}

export function isResultMetaTool(name: string): boolean {
  return (TASK_RESULT_META_TOOLS as readonly string[]).includes(name);
}

export function normalizeTaskResultRegistration(v: unknown): TaskResultRegistration | null {
  if (!v || typeof v !== "object") return null;
  const r = v as TaskResultRegistration;
  if (!taskId(r.id) || !text(r.description, 600) || !text(r.tool, 100) || isResultMetaTool(r.tool)) return null;
  const rawTarget = r.target == null || r.target === 'null' || r.target === '' ? null : r.target;
  if (!(rawTarget === null || text(rawTarget, 500))) return null;
  return { id: r.id, description: r.description.trim(), tool: r.tool, target: typeof rawTarget === "string" ? normalizeResultTarget(rawTarget) : null };
}

export function normalizeResultTarget(target: string): string {
  const clean = target.trim();
  return clean.startsWith('loc=css:') ? clean.slice('loc=css:'.length).trim() : clean;
}

export function extractResultTarget(params: Record<string, unknown> | undefined): string | null {
  const target = params?.target;
  return typeof target === "string" && target.trim() ? normalizeResultTarget(target) : null;
}

export function resultCanUseExecution(item: Pick<TaskResultItem, "tool" | "target" | "status">, tool: string, target: string | null): boolean {
  if (item.status !== "pending" || item.tool !== tool || isResultMetaTool(tool)) return false;
  return item.target === target;
}

// ── 执行事实到账本项的绑定（记账下沉） ────────────────────────────────

/** 自动登记项的 id 前缀；模型之后用 record_task_results 声明同一目标时应吸收它，而不是新增一条待办。 */
export const AUTO_RESULT_ID_PREFIX = "auto-";

/** 账本项上限；自动登记达到上限后不再新增，但已登记项的绑定与回执照常。 */
export const MAX_TASK_RESULTS = 64;

export type ResultBinding =
  /** 已有同工具同目标、尚无证据（或上次失败）的待办项：直接绑定。 */
  | { kind: "exact"; itemId: string }
  /** 登记了意图但还没定位的同工具待办项（target=null，且尚无证据）：可把实际目标改绑到它。 */
  | { kind: "rebind"; itemId: string }
  /** 没有可复用的待办：调用方决定是否按真实动作新建自动项。 */
  | { kind: "create" }
  /** 同工具同目标已有在途/已满足/未决的项：不新建、不改绑，交给执行闸门与核查流程。 */
  | { kind: "none" };

/**
 * 从真实工具调用派生账本绑定（纯函数）。
 * 只复用「尚无证据的 pending」与「上次失败的 blocked」项；satisfied 是历史回执，
 * unknown 的身份必须留给核查，二者都不参与改绑。已写明 target 的登记项不静默漂移：
 * 实际目标不同时新建自动项，原登记保持待办。歧义（多个未定位待办）不猜，交给调用方新建。
 */
export function selectResultBinding(items: readonly TaskResultItem[], tool: string, target: string | null): ResultBinding {
  if (isResultMetaTool(tool)) return { kind: "none" };
  const exact = items.find(item => (!item.evidence || item.status === "blocked")
    && resultCanUseExecution(item.status === "blocked" ? { ...item, status: "pending" } : item, tool, target));
  if (exact) return { kind: "exact", itemId: exact.id };
  if (items.some(item => item.tool === tool && item.target === target)) return { kind: "none" };
  const unlocated = items.filter(item => item.status === "pending" && item.evidence === null && item.tool === tool && item.target === null);
  if (unlocated.length === 1) return { kind: "rebind", itemId: unlocated[0]!.id };
  return { kind: "create" };
}

const RESULT_ACTION_LABELS: Record<string, string> = {
  click: "点击", hover: "悬停", fill: "填写", page_operation: "修改字段", type_text: "输入文字",
  press_key: "按键", navigate: "打开页面", open_tab: "打开标签页", switch_tab: "切换标签页",
  close_tab: "关闭标签页", scroll: "滚动页面", mark: "标注页面", clear_marks: "清除标注",
  js: "执行页面脚本", worker_tabs: "调整页面归属", share_tab: "设置协作页面",
};

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/g, " ");
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * 自动账本项的人话说明：模型没登记时用它填回执。只从调用参数与目标派生，
 * 不读页面、不加推测；信息不足时回退到动作名。
 */
export function deriveResultDescription(name: string, params: Record<string, unknown> | undefined, target: string | null): string {
  const p = params ?? {};
  const action = RESULT_ACTION_LABELS[name] ?? name;
  const label = shortText(p.label, 40);
  const url = shortText(p.url, 80);
  const key = shortText(p.key, 20);
  let text: string;
  switch (name) {
    case "click":
    case "hover":
    case "mark":
      text = label ? `${action}「${label}」` : shortText(target, 120) ? `${action} ${shortText(target, 120)}` : action;
      break;
    case "navigate":
    case "open_tab":
      text = url ? `${action} ${url}` : action;
      break;
    case "press_key":
      text = key ? `${action} ${key}` : action;
      break;
    default:
      text = shortText(target, 120) ? `${action} ${shortText(target, 120)}` : action;
      break;
  }
  return text.length > 600 ? text.slice(0, 599) : text;
}
