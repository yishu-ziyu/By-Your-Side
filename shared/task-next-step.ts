import { goalsReadyForDelivery } from './task-goals.js';
import { isWriteTool } from './control.js';
import { isHostPageProbe, requiresControlGate } from './effect-policy.js';
import { extractResultTarget, isSupersededUnknown, selectResultBinding, MAX_TASK_RESULTS } from './task-results.js';
import { taskId } from './task-actions.js';
import type { TaskProgressSnapshot } from './voice.js';

// verify_unknown、unknown_with_baseline、unknown_without_baseline 自 10-10 起不再产生，只为读入旧任务存档保留。
export const TASK_NEXT_ACTIONS = ['continue', 'change_method', 'verify_unknown', 'ask_user', 'verify_result', 'deliver', 'wait', 'stop'] as const;

export const TASK_NEXT_REASONS = ['cancelled', 'human_control', 'restart_checkpoint', 'failure_limit', 'unknown_with_baseline', 'unknown_without_baseline', 'in_flight', 'tool_failed', 'remaining', 'readback_required', 'receipts_reviewed', 'open_task', 'runtime_error'] as const;

/** A host decision about execution and delivery, never a claim of business success. */
export interface TaskNextStep {
  action: typeof TASK_NEXT_ACTIONS[number];
  reason: typeof TASK_NEXT_REASONS[number];
  allowWrites: boolean;
  /** report permits a sourced final report, not verified_success. */
  delivery: 'none' | 'partial' | 'report';
  resultIds: string[];
}

export function isTaskNextStep(value: unknown): value is TaskNextStep {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const d = value as TaskNextStep;

  return TASK_NEXT_ACTIONS.includes(d.action) && TASK_NEXT_REASONS.includes(d.reason)
    && typeof d.allowWrites === 'boolean' && ['none', 'partial', 'report'].includes(d.delivery)
    && Array.isArray(d.resultIds) && d.resultIds.length <= 64 && d.resultIds.every(taskId);
}

export interface NextStepFacts {
  inFlight?: boolean;
  readbackRequired?: boolean;
  /** 原地打转被宿主停下（no-progress）。 */
  failureLimit?: boolean;
  toolFailed?: boolean;
}

/** Priority is shared by progress, model context, execution guards and final delivery. */
export function decideTaskNextStep(snapshot: TaskProgressSnapshot, facts: NextStepFacts = {}): TaskNextStep {
  const results = snapshot.results ?? [];
  const decide = (action: TaskNextStep['action'], reason: TaskNextStep['reason'], allowWrites: boolean, delivery: TaskNextStep['delivery'], resultIds: string[] = []): TaskNextStep => ({ action, reason, allowWrites, delivery, resultIds });

  if (snapshot.state === 'aborted') {
    return decide('stop', 'cancelled', false, 'none');
  }

  if (snapshot.state === 'paused') {
    return decide('wait', 'human_control', false, 'none');
  }

  if (snapshot.state === 'interrupted') {
    return decide('wait', 'restart_checkpoint', false, 'none');
  }

  if (facts.failureLimit) {
    return decide('ask_user', 'failure_limit', false, facts.inFlight ? 'none' : 'partial');
  }

  if (facts.inFlight) {
    return decide('wait', 'in_flight', true, 'none');
  }

  if (snapshot.state === 'error') {
    return decide('ask_user', 'runtime_error', false, 'partial');
  }

  if (snapshot.goalPlan) {
    // Goal verification supersedes obsolete known-failed attempts. Unknown effects and control
    // boundaries were handled above; they can never be cleared by an outcome judgment.
    if (goalsReadyForDelivery(snapshot.goalPlan)&&snapshot.goalPlan.goals.some(goal=>goal.kind!=='answer')) {
      return decide('deliver','receipts_reviewed',true,'report');
    }

    if (facts.toolFailed ?? snapshot.lastAction?.failed) return decide('change_method','tool_failed',true,'partial');

    if (!goalsReadyForDelivery(snapshot.goalPlan)) {
      return decide('continue','remaining',true,'partial',snapshot.goalPlan.goals.filter(goal=>goal.status!=='satisfied').map(goal=>goal.id));
    }
  } else {
    // 结果未知与失败同样处理：重读页面后重做或换方法，不暂停写入（10-10 用户裁决）。
    const blocked=results.filter(item=>item.status==='blocked'||item.status==='unknown'&&!isSupersededUnknown(item,results));

    if(blocked.length)return decide('change_method','tool_failed',true,'partial',blocked.map(item=>item.id));
    const pending=results.filter(item=>item.status==='pending');

    if(pending.length)return decide('continue','remaining',true,'partial',pending.map(item=>item.id));
  }

  if (facts.readbackRequired) {
    return decide('verify_result', 'readback_required', true, 'partial');
  }

  if (facts.toolFailed ?? snapshot.lastAction?.failed) return decide('change_method','tool_failed',true,'partial');

  if (snapshot.goalPlan && goalsReadyForDelivery(snapshot.goalPlan)) return decide('deliver', 'receipts_reviewed', true, 'report');

  return results.length ? decide('deliver', 'receipts_reviewed', true, 'report') : decide('continue', 'open_task', true, 'report');
}

/**
 * The next step as the model and the delivery should see it. An unplanned goal plan is only a
 * placeholder, not a user goal list: when it is the sole reason for "remaining" and no real
 * execution is still open, judge from execution results alone instead of demanding a plan.
 */
export function nextStepIgnoringPlaceholder(snapshot: TaskProgressSnapshot): TaskNextStep {
  const next = snapshot.nextStep ?? decideTaskNextStep(snapshot);

  if (snapshot.goalPlan?.coverage === 'verified' || next.reason !== 'remaining') return next;
  const openWork = (snapshot.results ?? []).some(item => ['pending', 'blocked', 'unknown'].includes(item.status));

  return openWork ? next : decideTaskNextStep({ ...snapshot, goalPlan: undefined });
}

export function nextStepInstruction(decision: TaskNextStep): string {
  switch (decision.reason) {
    case 'cancelled': return '原任务已取消，操作未执行。';
    case 'human_control': return '页面现在归你，等待明确交还，不执行写入。';
    case 'restart_checkpoint': return '原任务保留在重启检查点，等待用户明确继续，不自动执行。';
    case 'failure_limit': return '原地打转，已停下；说明卡点并请用户决定。';
    case 'unknown_with_baseline':
    case 'unknown_without_baseline': return '有一步的结果未知（可能已经生效）。先重新读页面：没生效就重做或换方法，已经生效就继续。';
    case 'in_flight': return '仍有浏览器步骤在执行，等待真实回执后再交付，不能提前结束。';
    case 'runtime_error': return '运行遇到错误，保留已有事实，只能如实交付部分结果。';
    case 'tool_failed': return '有一步失败或结果未知；先重新读页面，再重做这一步或换方法，复用原待办 id。无法恢复时明确交付部分结果。';
    case 'remaining': return '用户目标仍有未完成或未核验项；用 task_goals 检查具体目标，不把动作回执当成完成。';
    case 'readback_required': return '已有执行回执，但缺少动作后的页面读回；先用 snapshot 或 read_element 核对实际用户目标，再交付。';
    case 'receipts_reviewed': return '已取得执行回执与所需读回；对照用户要求交付有来源的报告。读回不自动证明全部业务目标成功。';
    case 'open_task': return '继续回答用户或执行所需步骤，不强制预登记。纯问答可直接交付；不能靠省略登记隐藏未完成项。';
  }
}

/** 模型说做完了、宿主知道没做完时补在回答后的一句：说用户能理解的事实，不用账本口吻。 */
export function partialResultNote(decision: TaskNextStep): string {
  if (decision.reason.startsWith('unknown_')) return '（有一步已经做了，但还没确认结果，所以没算作完成。）';

  if (decision.reason === 'readback_required') return '（改动还没在页面上核对过。）';

  if (decision.reason === 'failure_limit' || decision.reason === 'tool_failed') return '（有一步没做成，这件事还没全部完成。）';

  return '（还有没做完或没核对的部分。）';
}

/** 写入前的控制与生命周期闸门：取消、接管、重启检查点、运行错误、原地打转停下时不写。
 * 结果未知和已有成功回执都不拦：重做同一步由模型读页后决定（10-10 用户裁决）。
 * freshDirect：直连的新用户请求（display-* 调用）不为旧任务的“已取消”生命周期买单。 */
export function assertTaskStepExecution(snapshot: TaskProgressSnapshot | null, name: string, params: Record<string, unknown> = {}, freshDirect = false): void {
  // Host-authored read-only probes (exact code match) read like snapshot.
  if (!snapshot || isHostPageProbe(name, params)) {
    return;
  }

  const write = isWriteTool(name) || requiresControlGate(name, params);

  if (!write) {
    return;
  }

  const decision = decideTaskNextStep(snapshot, { failureLimit: snapshot.nextStep?.reason === 'failure_limit' });

  if (!(freshDirect && decision.reason === 'cancelled') && !decision.allowWrites) {
    throw new Error(nextStepInstruction(decision));
  }

  const target = extractResultTarget(params, name);

  if ((snapshot.results?.length ?? 0) >= MAX_TASK_RESULTS) {
    const binding = selectResultBinding(snapshot.results!, name, target);
    const ownsSlot = snapshot.results!.some(item => item.tool === name && item.target === target && item.status === 'pending');

    if (!ownsSlot && binding.kind !== 'exact' && binding.kind !== 'rebind') {
      throw new Error('结果账本已满，无法可靠记录新的写入结果；本次操作未执行，请先交付已有结果。');
    }
  }
}
