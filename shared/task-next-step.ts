import { goalsReadyForDelivery } from './task-goals.js';
import { isWriteTool } from './control.js';
import { isHostPageProbe, requiresControlGate } from './effect-policy.js';
import { extractResultTarget, isSupersededUnknown, repeatsHarm, resultLocksWhenUnknown, selectResultBinding, MAX_TASK_RESULTS } from './task-results.js';
import { taskId } from './task-actions.js';
import type { TaskProgressSnapshot } from './voice.js';

export const TOOL_FAILURE_LIMIT = 3;

/** 重复一步已有成功回执的写入被拦下：没执行，但原来那步已经做成，这件事不算失败。 */
export class RepeatRefusedError extends Error {}

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
  verifiableUnknownIds?: readonly string[];
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

  const incompleteDelivery = facts.inFlight ? 'none' : 'partial';

  if (facts.failureLimit) {
    return decide('ask_user', 'failure_limit', false, incompleteDelivery);
  }

  if (snapshot.unresolvedEffect) {
    return decide('ask_user', 'unknown_without_baseline', false, incompleteDelivery);
  }

  const unknown = results.filter(item => item.status === 'unknown' && !isSupersededUnknown(item, results));

  if (unknown.length) {
    // 核查过一次仍无法确认的项不再进入核查（10-01 用户裁决：查不清就说明并停下，不反复查）。
    const verifiable = unknown.filter(item => !item.checkFailed && facts.verifiableUnknownIds?.includes(item.id));

    return decide(verifiable.length ? 'verify_unknown' : 'ask_user', verifiable.length ? 'unknown_with_baseline' : 'unknown_without_baseline', !unknown.some(resultLocksWhenUnknown), incompleteDelivery, unknown.map(item => item.id));
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
    const blocked=results.filter(item=>item.status==='blocked');

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
    case 'failure_limit': return '已达到重复失败边界，停止重试，说明卡点并请用户决定。';
    case 'unknown_with_baseline': return '旧操作结果未知；可能重复造成后果的操作（点击、填写、按键、页面脚本、POST 等）已暂停，读页、滚动圈画、打开或切换页面、GET 取数、存文件、处理原生弹窗照常。用 resolve_unknown_result 核查一次；核查不能确认就不要再查，也不要重做或换工具绕过，把这一项作为没确认的部分如实告诉用户。';
    case 'unknown_without_baseline': return '旧操作结果未知，且已无法再核查（缺少写入前的页面读数，或已经核查过一次）：不要再调用 resolve_unknown_result，也不要重做或换工具绕过。可能重复造成后果的操作（点击、填写、按键、页面脚本、POST 等）已暂停；读页、滚动圈画、打开或切换页面、GET 取数、存文件、处理原生弹窗照常，不必为这些再问用户。做完其余独立步骤后，如实告诉用户这一步没确认、没有重复执行，由用户在对话里决定是否继续。';
    case 'in_flight': return '仍有浏览器步骤在执行，等待真实回执后再交付，不能提前结束。';
    case 'runtime_error': return '运行遇到错误，保留已有事实，只能如实交付部分结果。';
    case 'tool_failed': return '存在失败步骤；依据新观察修正目标或换方法，复用原待办 id。不能盲试同一失败；无法恢复时明确交付部分结果。';
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

/** Both lead and worker use the same control/uncertainty policy; replay checks retain their original scope.
 * freshDirect：直连的新用户请求（display-* 调用）不为旧任务的“已取消”生命周期买单；
 * 只豁免 cancelled 这一条原因，未知写入、运行时错误、重复回执与失败边界照常生效。 */
export function assertTaskStepExecution(snapshot: TaskProgressSnapshot | null, name: string, params: Record<string, unknown> = {}, worker = false, freshDirect = false, fillValueHash?: string): void {
  // Host-authored read-only probes (exact code match) read like snapshot: they
  // neither redo nor extend an unknown page script.
  if (!snapshot || isHostPageProbe(name, params)) {
    return;
  }

  const write = isWriteTool(name) || requiresControlGate(name, params);
  // 结果不确定时只拦再做一次可能重复造成后果的调用（10-01 用户裁决）。读页、滚动圈画、
  // 打开/切换/关闭页面、GET 取数、等页面事件、处理原生弹窗照常；它们仍要过下面的控制权与生命周期闸门。
  const harmful = repeatsHarm(name, params);

  if (worker && !write) {
    return;
  }

  const decision = decideTaskNextStep(snapshot, { failureLimit: snapshot.nextStep?.reason === 'failure_limit' });
  const cancelledForFreshDirect = freshDirect && decision.reason === 'cancelled';

  if (write && !cancelledForFreshDirect && ['cancelled', 'human_control', 'restart_checkpoint', 'runtime_error', 'failure_limit'].includes(decision.reason)) {
    throw new Error(nextStepInstruction(decision));
  }

  const target = extractResultTarget(params, name);

  for (const item of snapshot.results ?? []) {
    if (item.status === 'unknown' && !isSupersededUnknown(item, snapshot.results ?? []) && resultLocksWhenUnknown(item)) {
      if (!worker && harmful && item.tool === name && (item.target === null || item.target === target)) {
        throw new Error(`「${item.description}」的执行结果未知（结果 ${item.id}，调用 ${item.evidence?.toolCallId ?? '缺失'}），不能自动重做；请先查询结果或由用户决定。`);
      }

      if (harmful) {
        throw new Error(`任务中存在尚未确认结果的操作「${item.description}」（结果 ${item.id}，调用 ${item.evidence?.toolCallId ?? '缺失'}），当前写入已暂停：点击、填写、按键、页面脚本、POST 等可能重复造成后果的操作不能做。读页、滚动圈画、打开或切换页面、GET 取数、存文件、处理原生弹窗仍可继续；不得盲目重试。`);
      }
    }

    if (!write || item.tool !== name || item.status !== 'satisfied' || item.target === null || item.target !== target) {
      continue;
    }

    const observedAfter = typeof snapshot.lastReadAt === 'number' && item.evidence?.observedAt !== undefined && snapshot.lastReadAt > item.evidence.observedAt;

    // A corrected fill is not a repeat: its value differs from the earlier fill, or the page did not keep the earlier value.
    // Only `fill`; clicks, submits and other writes keep the repeat guard (double-submit risk). A select refills only on a bad
    // readback, because a different value would fire its change event (auto-submit) again.
    const badReadback = item.evidence?.readback === 'not_held' || item.evidence?.readback === 'different';
    const newValue = item.evidence?.valueHash !== undefined && fillValueHash !== undefined && item.evidence.valueHash !== fillValueHash;

    if (name === 'fill' && !snapshot.restartRecovery && (badReadback || (newValue && !item.evidence?.selectField))) {
      continue;
    }

    if (snapshot.restartRecovery || (!worker && !observedAfter)) {
      // 重启前填好的也一样：这次没执行，原步骤已做成，不能在账上留成受阻待办。
      if (snapshot.restartRecovery && name === 'fill') throw new RepeatRefusedError(`「${item.description}」已有成功回执（来自重启前），不能直接重放。若当前页面已不满足最新要求，请停下告诉用户，由用户在对话里决定是否重填。`);

      throw new RepeatRefusedError(`「${item.description}」已有成功回执，不重复执行。请继续剩余步骤。`);
    }
  }

  // 未知结果只拦可能重复造成后果的调用；其余 allowWrites=false 的情形（取消、接管、失败边界等）已在上面整体拦下。
  if (write && !cancelledForFreshDirect && !decision.allowWrites && !(decision.reason.startsWith('unknown_') && !harmful)) {
    throw new Error(nextStepInstruction(decision));
  }

  if (write && (snapshot.results?.length ?? 0) >= MAX_TASK_RESULTS) {
    const binding = selectResultBinding(snapshot.results!, name, target);
    const ownsSlot = snapshot.results!.some(item => item.tool === name && item.target === target && item.status === 'pending');

    if (!ownsSlot && binding.kind !== 'exact' && binding.kind !== 'rebind') {
      throw new Error('结果账本已满，无法可靠记录新的写入结果；本次操作未执行，请先交付已有结果。');
    }
  }
}
