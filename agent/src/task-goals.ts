import { createHash } from 'node:crypto';
import { taskRequirementId, isTaskGoalPlan, type TaskGoal, type TaskGoalDefinition, type TaskGoalPlan } from '../../shared/task-goals.js';

export function goalRevision(requirements: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(requirements)).digest('hex');
}

/** Owns outcome transitions only; never changes execution facts or write permissions. */
export class TaskGoalBook {
  private plan: TaskGoalPlan | undefined;

  clear(): void { this.plan = undefined; }

  snapshot(): TaskGoalPlan | undefined { return this.plan ? structuredClone(this.plan) : undefined; }

  require(requirements: readonly string[]): void {
    if (!requirements.length) return;
    const revision = goalRevision(requirements);
    if (this.plan?.revision === revision) return;
    this.plan = {
      revision, coverage: 'unplanned',
      goals: [{ id: 'user-request', description: (requirements.at(-1)!.length > 160 ? requirements.at(-1)!.slice(0,159)+'…' : requirements.at(-1)!) || '核对用户要求',
        criterion: '尚未核对全部用户要求及完成条件', requirements: requirements.map((_, i) => taskRequirementId(i)), kind: 'condition', status: 'pending' }],
    };
  }

  restore(plan: TaskGoalPlan | undefined, refresh = true): void {
    if (plan !== undefined && !isTaskGoalPlan(plan)) throw new Error('用户目标检查点无效');
    this.plan = plan ? structuredClone(plan) : undefined;
    for (const goal of this.plan?.goals ?? []) {
      if (refresh && goal.status === 'satisfied' && !['material','answer'].includes(goal.kind)) {
        goal.status = 'pending';
        goal.reason = '恢复后需要重新核对当前页面';
        delete goal.evidence;
      }
    }
  }

  install(revision: string, definitions: readonly TaskGoalDefinition[], requirementCount: number): void {
    if (!this.plan || this.plan.revision !== revision) throw new Error('用户要求已变化，旧目标方案未应用');
    if (this.plan.coverage === 'verified') throw new Error('本版目标已固定；改变做法不能删除未完成要求');
    if(definitions.length>1&&definitions.some(g=>g.id==='user-request'))throw new Error('首次 plan 请用具体目标替换 user-request 占位项，不要同时保留总目标与重复子目标。');
    const goals = definitions.map(g => ({ ...g, status: 'pending' as const }));
    this.assertCoverage(revision, goals, requirementCount);
    this.plan = structuredClone({ revision, coverage: 'verified', goals });
  }

  /**
   * Revise an already-fixed plan without dropping any user-visible requirement.
   * Every condition/field/answer goal and any already-satisfied goal (including material)
   * is carried over byte-for-byte; only a still-pending material with no field referencing
   * its materialId may be dropped or replaced. New goals may be added. Requires a reason.
   */
  amend(revision: string, definitions: readonly TaskGoalDefinition[], requirementCount: number, reason: string): void {
    if (!this.plan || this.plan.revision !== revision) throw new Error('用户要求已变化，旧目标方案未应用');
    if (this.plan.coverage !== 'verified') throw new Error('尚无已固定的目标方案可修订，请先用 plan 建立完整目标');
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error('修订已固定的目标方案必须说明理由：为什么调整内部做法，用户要求如何仍被覆盖');
    const current = this.plan.goals;
    const proposed = new Map(definitions.map(g => [g.id, g] as const));
    const referencedMaterialIds = new Set(current.filter(g => g.kind === 'field').map(g => g.materialId));
    const removable = (g: TaskGoal) => g.kind === 'material' && g.status === 'pending' && !referencedMaterialIds.has(g.materialId);
    const missing = current.filter(g => !removable(g) && !proposed.has(g.id));
    if (missing.length) throw new Error(`修订不能删除或改动这些目标；改变做法不能删除用户要求：${missing.map(g => g.id).join(', ')}`);
    const removedIds = current.filter(g => !proposed.has(g.id)).map(g => g.id);
    const addedIds = definitions.filter(d => !current.some(g => g.id === d.id)).map(d => d.id);
    const goals: TaskGoal[] = [
      ...current.filter(g => proposed.has(g.id)).map(g => removable(g) ? { ...proposed.get(g.id)!, status: 'pending' as const } : structuredClone(g)),
      ...definitions.filter(d => addedIds.includes(d.id)).map(d => ({ ...d, status: 'pending' as const })),
    ];
    this.assertCoverage(revision, goals, requirementCount);
    const amendments = [...(this.plan.amendments ?? []), { at: Date.now(), reason: trimmedReason.slice(0, 500), removed: removedIds, added: addedIds }].slice(-16);
    const next: TaskGoalPlan = { revision, coverage: 'verified', goals, amendments };
    if (!isTaskGoalPlan(next)) throw new Error('修订后的目标方案无效');
    this.plan = structuredClone(next);
  }

  /** Shared by install/amend: every requirement covered, field->material references resolve, material ids unique. */
  private assertCoverage(revision: string, goals: TaskGoal[], requirementCount: number): void {
    const required = Array.from({ length: requirementCount }, (_, i) => taskRequirementId(i));
    if (!isTaskGoalPlan({ revision, coverage: 'verified', goals }) || goals.some(g => g.requirements.some(id => !required.includes(id)))
      || required.some(id => !goals.some(g => g.requirements.includes(id)))
      || goals.some(g=>g.kind==='field'&&!goals.some(source=>source.kind==='material'&&source.materialId===g.materialId))
      || new Set(goals.filter(g=>g.kind==='material').map(g=>g.materialId)).size!==goals.filter(g=>g.kind==='material').length) {
      throw new Error(`目标方案无效或遗漏用户要求。requirements 必须引用这些用户要求编号：${required.join(', ')}；不是目标序号。material/field 必须提供 materialId。`);
    }
  }

  verify(revision: string, id: string, result: { matched: boolean; reason: string; evidence: NonNullable<TaskGoal['evidence']> }): void {
    const goal = this.plan?.goals.find(g => g.id === id);
    if (!goal || this.plan?.coverage !== 'verified' || this.plan.revision !== revision) throw new Error('目标或用户要求已变化，核验未应用');
    if (result.matched && ['field','material'].includes(goal.kind) && goal.materialId && result.evidence.materialId !== goal.materialId) throw new Error('核验材料与目标不一致');
    const next = { ...goal, status: result.matched ? 'satisfied' as const : 'pending' as const,
      reason: result.reason.slice(0, 500), evidence: result.matched ? result.evidence : undefined };
    if (!isTaskGoalPlan({ ...this.plan, goals: this.plan.goals.map(g => g.id === id ? next : g) })) throw new Error('核验证据无效');
    Object.assign(goal, next);
  }

  bindPendingMaterial(revision:string,previousId:string,materialId:string):void {
    if(previousId===materialId)return;
    const source=this.plan?.goals.find(goal=>goal.kind==='material'&&goal.materialId===previousId);
    if(!source||source.status!=='pending'||this.plan?.revision!==revision)throw new Error('已核验的来源不能被替换；保留原目标与证据');
    for(const goal of this.plan.goals)if(goal.materialId===previousId){
      goal.materialId=materialId;
      goal.status='pending';
      delete goal.evidence;
      goal.reason='来源材料已绑定，需按这份原文核对结果';
    }
  }

  recordAnswerDelivery(id:string,at:number):void {
    if(this.plan?.coverage!=='verified')return;
    for(const goal of this.plan.goals)if(goal.kind==='answer'&&goal.status!=='satisfied')this.verify(this.plan.revision,goal.id,{matched:true,reason:'答复已正式交付',evidence:{observationId:id,tabId:null,verifiedAt:at}});
  }

  invalidatePage(tabId: number | null): void {
    for (const goal of this.plan?.goals ?? []) {
      if (['material','answer'].includes(goal.kind) || goal.status !== 'satisfied' || (tabId !== null && goal.evidence?.tabId !== tabId)) continue;
      goal.status = 'pending';
      goal.reason = '页面发生后续操作，需要重新核对';
      delete goal.evidence;
    }
  }
}
