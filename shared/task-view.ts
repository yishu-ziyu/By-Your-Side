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
import { isUnfinishedItem, USER_DELIVERY_KINDS, type TaskProgressSnapshot, type UserDelivery, type UserDeliveryKind } from "./voice.js";
import { nextStepIgnoringPlaceholder, TASK_NEXT_REASONS, type TaskNextStep } from "./task-next-step.js";
import { isSupersededUnknown, TASK_RESULT_ITEM_STATUSES, type TaskResultItemStatus } from "./task-results.js";
import { isTaskMaterials, type TaskMaterialReference } from './task-recovery.js';

export const TASK_VIEW_STATES = ["none", "running", "paused", "interrupted", "idle", "aborted", "error"] as const;

export interface TaskViewPage { tabId: number; urlHash: string }

export interface TaskViewResultItem { id: string; description: string; status: TaskResultItemStatus; }

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
  /** outstanding 是否来自用户目标清单；false 表示没有列目标，里面只是动作记录。旧视图缺省按目标处理。 */
  goalsListed?: boolean;
  /** 最近一次正式交付引用；没有则为 null。unfinished 是模型自己列的未完成项（用户原话口吻），不是宿主核验结果。 */
  latestDelivery: { kind: UserDeliveryKind; unfinished?: string[] } | null;
  /** 是否有可恢复的真实依据（中断并留有恢复输入；或已结束但只交付了部分结果）；「继续」按钮只能以此为凭 */
  resumable: boolean;
  /**
   * 最近一次目标核对：done 做完；waiting 等用户（回答、确认、登录）；open 还差、助手没做成；
   * blocked 原因在助手和用户之外（网站连不上等），remaining 是给用户看的原因。remaining 是用户口吻的一句。没核对过时缺省。
   */
  goalStatus?: { status: "done" | "waiting" | "open" | "blocked"; remaining: string | null };
  /** 有写入步骤说不清是否已执行（中断时没登记结果）。只在为真时出现。 */
  unresolvedEffect?: true;
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
  const executionResults = snapshot.results ?? [];
  // 未列计划时的占位目标不是用户目标清单：只看执行记录，占位目标不算未完成项（与 nextStepIgnoringPlaceholder 同口径）。
  const rawResults = snapshot.goalPlan?.coverage === 'verified' ? [...snapshot.goalPlan.goals, ...executionResults.filter(item => item.status === 'unknown' && !isSupersededUnknown(item, executionResults))] : executionResults;

  const results = rawResults.map((item): TaskViewResultItem => ({ id: item.id, description: item.description, status: item.status }));

  const outstanding=results.filter((item,i)=>OPEN_STATUSES.has(item.status)&&!('tool' in rawResults[i]!&&isSupersededUnknown(rawResults[i] as import('./task-results.js').TaskResultItem,executionResults)));

  const view: TaskView = {
    conversationId: snapshot.conversationId,
    runId: snapshot.runId ?? null,
    controlVersion: snapshot.controlVersion ?? 0,
    observedAt: snapshot.observedAt,
    state: snapshot.state,
    goal: snapshot.goal ?? requirements[0] ?? null,
    revisions: requirements.slice(1),
    page: snapshot.recoveryInput?.page ? { tabId: snapshot.recoveryInput.page.tabId, urlHash: snapshot.recoveryInput.page.urlHash } : null,
    active: (snapshot.active ?? []).map((a) => ({ member: a.member, action: a.action, since: a.since })),
    lastAction: snapshot.lastAction ? { ...snapshot.lastAction } : null,
    waiting: waitingFor(snapshot, snapshot.nextStep),
    results,
    // 与 decideTaskNextStep 同口径：已被取代的 unknown 不再算未完成项
    outstanding,
    goalsListed: snapshot.goalPlan?.coverage === 'verified',
    latestDelivery: latestDeliveryRef(snapshot.conversationContext?.latestDelivery),
    resumable: (snapshot.state === "interrupted" || (["idle", "error"].includes(snapshot.state) && ((snapshot.nextStep ? nextStepIgnoringPlaceholder(snapshot).delivery : undefined) === "partial"||outstanding.length>0||(!!snapshot.goalCheck&&snapshot.goalCheck.status!=="done")))) && !!snapshot.recoveryInput,
    ...(snapshot.goalCheck ? { goalStatus: { status: snapshot.goalCheck.status === "done" ? "done" as const : snapshot.goalCheck.status === "needs_user" ? "waiting" as const : snapshot.goalCheck.status === "blocked" ? "blocked" as const : "open" as const, remaining: snapshot.goalCheck.remaining } } : {}),
  };

  if (snapshot.unresolvedEffect || snapshot.untrackedWritePending) view.unresolvedEffect = true;
  const materials = snapshot.recoveryInput?.materials;

  if (materials) view.materials = materials.map(item => ({ ...item }));

  return view;
}

/**
 * 后台（offscreen）重启后能否不等用户、自己接着做：被重启或断连打断、没有说不清是否已执行的步骤、
 * 可恢复、并且知道原页面。页面是否还开着由调用方核对；不满足就照旧等用户点「继续原任务」。
 */
export function canAutoResume(view: TaskView): boolean {
  return view.state === "interrupted"
    && view.waiting?.reason === "restart_checkpoint"
    && (view.waiting.detail === "host_restart" || view.waiting.detail === "connection_lost")
    && view.resumable
    && !view.unresolvedEffect
    && !view.outstanding.some((item) => item.status === "unknown")
    && !!view.runId
    && view.page !== null;
}

function latestDeliveryRef(delivery: UserDelivery | null | undefined): TaskView["latestDelivery"] {
  if (!delivery) return null;

  return delivery.unfinished?.length ? { kind: delivery.kind, unfinished: [...delivery.unfinished] } : { kind: delivery.kind };
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

  const itemOk = (x: unknown): boolean => {
    if (!x || typeof x !== "object") return false;
    // SAFETY: 下面逐个字段核对类型，不信任断言本身。
    const item = x as TaskViewResultItem;

    return typeof item.id === "string" && typeof item.description === "string" && TASK_RESULT_ITEM_STATUSES.includes(item.status);
  };

  if (!Array.isArray(v.results) || !v.results.every(itemOk)) return false;

  if (!Array.isArray(v.outstanding) || !v.outstanding.every(itemOk)) return false;
  const activeOk = (x: unknown): boolean => !!x && typeof x === "object" && typeof (x as { member?: unknown }).member === "string" && typeof (x as { action?: unknown }).action === "string" && typeof (x as { since?: unknown }).since === "number";

  if (!Array.isArray(v.active) || !v.active.every(activeOk)) return false;

  if (v.lastAction !== null && (!v.lastAction || typeof v.lastAction.action !== "string" || typeof v.lastAction.failed !== "boolean" || typeof v.lastAction.at !== "number")) return false;

  if (v.waiting !== null && v.waiting !== undefined && (typeof v.waiting !== "object" || !TASK_NEXT_REASONS.includes(v.waiting.reason) || (v.waiting.detail !== null && typeof v.waiting.detail !== "string"))) return false;

  if (v.latestDelivery !== null && (!v.latestDelivery || !USER_DELIVERY_KINDS.includes(v.latestDelivery.kind))) return false;

  if (v.latestDelivery?.unfinished !== undefined && !(Array.isArray(v.latestDelivery.unfinished) && v.latestDelivery.unfinished.every(isUnfinishedItem))) return false;

  if (typeof v.resumable !== "boolean") return false;

  if (v.goalsListed !== undefined && v.goalsListed !== true && v.goalsListed !== false) return false;

  if (v.unresolvedEffect !== undefined && v.unresolvedEffect !== true) return false;

  if (v.goalStatus !== undefined && (!v.goalStatus || !["done", "waiting", "open", "blocked"].includes(v.goalStatus.status) || (v.goalStatus.remaining !== null && (typeof v.goalStatus.remaining !== "string" || v.goalStatus.remaining.length > 200)))) return false;

  return true;
}
