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
