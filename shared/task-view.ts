import { isUnfinishedItem, USER_DELIVERY_KINDS, type TaskProgressSnapshot, type UserDelivery, type UserDeliveryKind } from "./voice.js";
import { nextStepIgnoringPlaceholder, TASK_NEXT_REASONS, type TaskNextStep } from "./task-next-step.js";
import { isSupersededUnknown, TASK_RESULT_ITEM_STATUSES, type TaskResultItemStatus } from "./task-results.js";
import { isTaskMaterials, type TaskMaterialReference } from './task-recovery.js';
import { isTaskContinuation, type TaskContinuation } from './task-continuation.js';

export const TASK_VIEW_STATES = ["none", "running", "paused", "interrupted", "idle", "aborted", "error"] as const;

export interface TaskViewPage { tabId: number; urlHash: string }

export interface TaskViewResultItem { id: string; description: string; status: TaskResultItemStatus; }

export interface TaskView {
  conversationId: string;
  runId: string | null;
  controlVersion: number;
  observedAt: number;
  state: (typeof TASK_VIEW_STATES)[number];
  goal: string | null;
  revisions: string[];
  page: TaskViewPage | null;
  materials?: TaskMaterialReference[];
  continuation?: TaskContinuation;
  active: { member: string; action: string; since: number }[];
  lastAction: { action: string; failed: boolean; at: number } | null;
  waiting: { reason: TaskNextStep['reason']; detail: string | null } | null;
  results: TaskViewResultItem[];
  outstanding: TaskViewResultItem[];
  goalsListed?: boolean;
  latestDelivery: { kind: UserDeliveryKind; unfinished?: string[] } | null;
  resumable: boolean;
  goalStatus?: { status: "done" | "waiting" | "open" | "blocked"; remaining: string | null };
  failureReason?: string;
  unresolvedEffect?: true;
}

const OPEN_STATUSES = new Set(["pending", "blocked", "unknown"]);

function waitingFor(snapshot: TaskProgressSnapshot, nextStep: TaskNextStep | undefined): TaskView["waiting"] {
  if (snapshot.state === "paused") return { reason: "human_control", detail: null };

  if (snapshot.state === "interrupted") return { reason: "restart_checkpoint", detail: snapshot.interruptionReason ?? null };

  if (snapshot.state === "aborted") return { reason: "cancelled", detail: null };

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
      case "condition_wait":
        return { reason: "condition_wait", detail: snapshot.continuation?.condition.description ?? null };
      case "condition_invalid":
        return { reason: "condition_invalid", detail: snapshot.continuation?.lastError ?? null };
      case "deadline":
      case "budget":
        return { reason: nextStep.reason, detail: null };
      case "continuation_stopped":
        return { reason: nextStep.reason, detail: snapshot.continuation?.stopReason ?? null };
      default:
        break;
    }
  }

  if (snapshot.state === "error") return { reason: "runtime_error", detail: null };

  return null;
}

export function projectTaskView(snapshot: TaskProgressSnapshot): TaskView {
  const requirements = snapshot.recoveryInput?.requirements ?? [];
  const executionResults = snapshot.results ?? [];
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
    waiting: waitingFor(snapshot, snapshot.nextStep ?? nextStepIgnoringPlaceholder(snapshot)),
    results,
    outstanding,
    goalsListed: snapshot.goalPlan?.coverage === 'verified',
    latestDelivery: latestDeliveryRef(snapshot.conversationContext?.latestDelivery),
    resumable: (snapshot.state === "interrupted" || (["idle", "error"].includes(snapshot.state) && ((snapshot.nextStep ? nextStepIgnoringPlaceholder(snapshot).delivery : undefined) === "partial"||outstanding.length>0||(!!snapshot.goalCheck&&snapshot.goalCheck.status!=="done")))) && !!snapshot.recoveryInput,
    ...(snapshot.goalCheck ? { goalStatus: { status: snapshot.goalCheck.status === "done" ? "done" as const : snapshot.goalCheck.status === "needs_user" ? "waiting" as const : snapshot.goalCheck.status === "blocked" ? "blocked" as const : "open" as const, remaining: snapshot.goalCheck.remaining } } : {}),
  };

  const failed = executionResults.find(item => item.reason && (item.status === 'blocked' || item.status === 'unknown' && !isSupersededUnknown(item, executionResults)));

  if (failed?.reason) view.failureReason = failed.reason;

  if (snapshot.unresolvedEffect || snapshot.untrackedWritePending) view.unresolvedEffect = true;
  const materials = snapshot.recoveryInput?.materials;

  if (materials) view.materials = materials.map(item => ({ ...item }));

  if (snapshot.continuation) {
    view.continuation = { ...snapshot.continuation, condition: { ...snapshot.continuation.condition } };
    const state = snapshot.continuation.state;

    view.resumable = state === 'SUSPENDED' && !!snapshot.recoveryInput;

    if (state !== 'COMPLETED') delete view.goalStatus;
  }

  return view;
}

function latestDeliveryRef(delivery: UserDelivery | null | undefined): TaskView["latestDelivery"] {
  if (!delivery) return null;

  return delivery.unfinished?.length ? { kind: delivery.kind, unfinished: [...delivery.unfinished] } : { kind: delivery.kind };
}

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

  if (v.continuation !== undefined && !isTaskContinuation(v.continuation)) return false;

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

  if (v.failureReason !== undefined && (typeof v.failureReason !== "string" || v.failureReason.length > 100)) return false;

  if (v.goalsListed !== undefined && v.goalsListed !== true && v.goalsListed !== false) return false;

  if (v.unresolvedEffect !== undefined && v.unresolvedEffect !== true) return false;

  if (v.goalStatus !== undefined && (!v.goalStatus || !["done", "waiting", "open", "blocked"].includes(v.goalStatus.status) || (v.goalStatus.remaining !== null && (typeof v.goalStatus.remaining !== "string" || v.goalStatus.remaining.length > 200)))) return false;

  return true;
}
