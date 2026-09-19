/**
 * 统一任务视图（T02）：由真实状态生成的只读展示投影。
 *
 * 规则：
 * - 只从 TaskProgressSnapshot 等正式事实投影，不是第二套任务状态机；
 * - 不产生模型调用、不作为可执行命令或新权限来源；
 * - successVerified 恒 false 的语义保留：视图不含任何「业务已成功」字段；
 * - 旧快照缺新增字段时按未知处理，不用猜测填满；
 * - 作用页面来自任务绑定的 recoveryInput.page，不跟随当前选中 tab。
 */
import { USER_DELIVERY_KINDS, type TaskProgressSnapshot, type UserDeliveryKind } from "./voice.js";
import { TASK_NEXT_REASONS, type TaskNextStep } from "./task-next-step.js";
import { isSupersededUnknown, TASK_RESULT_ITEM_STATUSES, type TaskResultItemStatus } from "./task-results.js";
import { isTaskMaterials, type TaskMaterialReference } from './task-recovery.js';

export const TASK_VIEW_STATES = ["none", "running", "paused", "interrupted", "idle", "aborted", "error"] as const;

export interface TaskViewPage { tabId: number; urlHash: string }
export interface TaskViewResultItem { id: string; description: string; status: TaskResultItemStatus }

export interface TaskView {
  conversationId: string;
  runId: string | null;
  controlVersion: number;
  /** 投影所依据事实的观察时刻 */
  observedAt: number;
  state: (typeof TASK_VIEW_STATES)[number];
  /** 目标原文 */
  goal: string | null;
  /** 已接受的修订原文（按接受顺序；首条之外的要求） */
  revisions: string[];
  /** 任务绑定的作用页面；无可靠依据时为 null */
  page: TaskViewPage | null;
  /** 已接受请求的材料摘要，身份由本视图 conversationId/runId 绑定。旧记录可缺省。 */
  materials?: TaskMaterialReference[];
  /** 当前进行中的活动 */
  active: { member: string; action: string; since: number }[];
  lastAction: { action: string; failed: boolean; at: number } | null;
  /**
   * 当前等待/阻塞：reason 直接取 nextStep.reason 或中断原因，不合并成含糊「思考中」。
   * 正常执行中（running 且仅 in_flight/remaining/continue）为 null。
   */
  waiting: { reason: TaskNextStep['reason']; detail: string | null } | null;
  /** 已有成果引用（账本条目；状态原样，不升级） */
  results: TaskViewResultItem[];
  /** 未完成项（pending/blocked/unknown，未被取代者） */
  outstanding: TaskViewResultItem[];
  /** 最近一次正式交付引用；没有则为 null */
  latestDelivery: { kind: UserDeliveryKind } | null;
  /** 是否有可恢复的真实依据（中断并留有恢复输入；或已结束但只交付了部分结果）；「继续」按钮只能以此为凭 */
  resumable: boolean;
}

const OPEN_STATUSES = new Set(["pending", "blocked", "unknown"]);

function waitingFor(snapshot: TaskProgressSnapshot, nextStep: TaskNextStep | undefined): TaskView["waiting"] {
  if (snapshot.state === "paused") return { reason: "human_control", detail: null };
  if (snapshot.state === "interrupted") return { reason: "restart_checkpoint", detail: snapshot.interruptionReason ?? null };
  if (snapshot.state === "aborted") return { reason: "cancelled", detail: null };
  // 与 decideTaskNextStep 同优先级：failure_limit/unknown 先于 runtime_error
  if (nextStep) {
    switch (nextStep.reason) {
      case "failure_limit":
        return { reason: "failure_limit", detail: null };
      case "unknown_with_baseline":
      case "unknown_without_baseline":
        return { reason: nextStep.reason, detail: null };
      case "readback_required":
        return { reason: "readback_required", detail: null };
      case "tool_failed":
        return { reason: "tool_failed", detail: null };
      case "runtime_error":
        return { reason: "runtime_error", detail: null };
      default:
        break;
    }
  }
  if (snapshot.state === "error") return { reason: "runtime_error", detail: null };
  return null;
}

/** 只读投影：同一份事实（实时或重放恢复的快照）必须得到同一份视图。 */
export function projectTaskView(snapshot: TaskProgressSnapshot): TaskView {
  const requirements = snapshot.recoveryInput?.requirements ?? [];
  const rawResults = snapshot.results ?? [];
  const results = rawResults.map((item) => ({ id: item.id, description: item.description, status: item.status }));
  return {
    conversationId: snapshot.conversationId,
    runId: snapshot.runId ?? null,
    controlVersion: snapshot.controlVersion ?? 0,
    observedAt: snapshot.observedAt,
    state: snapshot.state,
    goal: snapshot.goal ?? requirements[0] ?? null,
    revisions: requirements.slice(1),
    page: snapshot.recoveryInput?.page ? { tabId: snapshot.recoveryInput.page.tabId, urlHash: snapshot.recoveryInput.page.urlHash } : null,
    ...(snapshot.recoveryInput?.materials ? { materials: snapshot.recoveryInput.materials.map(item => ({ ...item })) } : {}),
    active: (snapshot.active ?? []).map((a) => ({ member: a.member, action: a.action, since: a.since })),
    lastAction: snapshot.lastAction ? { ...snapshot.lastAction } : null,
    waiting: waitingFor(snapshot, snapshot.nextStep),
    results,
    // 与 decideTaskNextStep 同口径：已被取代的 unknown 不再算未完成项
    outstanding: results.filter((r, i) => OPEN_STATUSES.has(r.status) && !isSupersededUnknown(rawResults[i]!, rawResults)),
    latestDelivery: snapshot.conversationContext?.latestDelivery ? { kind: snapshot.conversationContext.latestDelivery.kind } : null,
    resumable: (snapshot.state === "interrupted" || (["idle", "error"].includes(snapshot.state) && snapshot.nextStep?.delivery === "partial")) && !!snapshot.recoveryInput,
  };
}

/** 结构校验：供协议解析；坏数据明确失败，不回退到更早状态。 */
export function isTaskView(value: unknown): value is TaskView {
  if (!value || typeof value !== "object") return false;
  const v = value as TaskView;
  if (typeof v.conversationId !== "string" || !v.conversationId) return false;
  if (v.runId !== null && typeof v.runId !== "string") return false;
  if (typeof v.controlVersion !== "number" || !Number.isSafeInteger(v.controlVersion)) return false;
  if (typeof v.observedAt !== "number" || !Number.isFinite(v.observedAt)) return false;
  if (!TASK_VIEW_STATES.includes(v.state)) return false;
  if (v.goal !== null && typeof v.goal !== "string") return false;
  if (!Array.isArray(v.revisions) || v.revisions.length > 64 || !v.revisions.every((r) => typeof r === "string")) return false;
  if (v.page !== null && (!v.page || typeof v.page !== "object" || !Number.isSafeInteger(v.page.tabId) || typeof v.page.urlHash !== "string")) return false;
  if (v.materials !== undefined && !isTaskMaterials(v.materials)) return false;
  const itemOk = (x: unknown): boolean => !!x && typeof x === "object" && typeof (x as TaskViewResultItem).id === "string" && typeof (x as TaskViewResultItem).description === "string" && TASK_RESULT_ITEM_STATUSES.includes((x as TaskViewResultItem).status);
  if (!Array.isArray(v.results) || !v.results.every(itemOk)) return false;
  if (!Array.isArray(v.outstanding) || !v.outstanding.every(itemOk)) return false;
  const activeOk = (x: unknown): boolean => !!x && typeof x === "object" && typeof (x as { member?: unknown }).member === "string" && typeof (x as { action?: unknown }).action === "string" && typeof (x as { since?: unknown }).since === "number";
  if (!Array.isArray(v.active) || !v.active.every(activeOk)) return false;
  if (v.lastAction !== null && (!v.lastAction || typeof v.lastAction.action !== "string" || typeof v.lastAction.failed !== "boolean" || typeof v.lastAction.at !== "number")) return false;
  if (v.waiting !== null && v.waiting !== undefined && (typeof v.waiting !== "object" || !TASK_NEXT_REASONS.includes(v.waiting.reason) || (v.waiting.detail !== null && typeof v.waiting.detail !== "string"))) return false;
  if (v.latestDelivery !== null && (!v.latestDelivery || !USER_DELIVERY_KINDS.includes(v.latestDelivery.kind))) return false;
  if (typeof v.resumable !== "boolean") return false;
  return true;
}
