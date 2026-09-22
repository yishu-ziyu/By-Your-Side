/** User outcomes are separate from the execution ledger and its replay locks. */
export interface TaskGoal {
  id: string;
  description: string;
  criterion: string;
  requirements: string[];
  kind: 'material' | 'field' | 'condition' | 'answer';
  materialId?: string;
  /** A copied field may append its observed source URL when the user requests it. */
  appendSourceUrl?: boolean;
  status: 'pending' | 'satisfied' | 'blocked';
  reason?: string;
  evidence?: { observationId: string; tabId: number | null; verifiedAt: number; materialId?: string };
}

export interface TaskGoalPlan {
  revision: string;
  coverage: 'unplanned' | 'verified';
  goals: TaskGoal[];
  /** Audit trail for revising an already-fixed plan without dropping user requirements; code enforces the rules, this only records why. */
  amendments?: Array<{ at: number; reason: string; removed: string[]; added: string[] }>;
}

export type TaskGoalDefinition = Pick<TaskGoal, 'id' | 'description' | 'criterion' | 'requirements' | 'kind' | 'materialId' | 'appendSourceUrl'>;

export function isTaskGoalPlan(value: unknown): value is TaskGoalPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as TaskGoalPlan;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32 && v.every(id => text(id, 64));
  return text(plan.revision, 64) && ['unplanned', 'verified'].includes(plan.coverage)
    && Array.isArray(plan.goals) && plan.goals.length > 0 && plan.goals.length <= 32
    && new Set(plan.goals.map(g => g?.id)).size === plan.goals.length
    && plan.goals.every(g => !!g && text(g.id, 64) && text(g.description, 160) && text(g.criterion, 2000)
      && ['material', 'field', 'condition', 'answer'].includes(g.kind)
      && ['pending', 'satisfied', 'blocked'].includes(g.status)
      && Array.isArray(g.requirements) && g.requirements.length > 0 && g.requirements.length <= 64
      && g.requirements.every(id => typeof id==='string' && /^requirement-([1-9]|[1-5][0-9]|6[0-4])$/.test(id))
      && (g.materialId === undefined || text(g.materialId, 64))
      && (g.appendSourceUrl === undefined || g.kind === 'field' && typeof g.appendSourceUrl === 'boolean')
      && (['condition','answer'].includes(g.kind) || text(g.materialId,64))
      && (g.reason === undefined || text(g.reason, 500))
      && (g.evidence === undefined || !!g.evidence && text(g.evidence.observationId, 200)
        && (g.kind==='answer'&&g.evidence.tabId===null || typeof g.evidence.tabId==='number'&&Number.isSafeInteger(g.evidence.tabId)&&g.evidence.tabId>0)
        && Number.isFinite(g.evidence.verifiedAt) && g.evidence.verifiedAt >= 0
        && (g.evidence.materialId === undefined || text(g.evidence.materialId, 64)))
      && (g.status !== 'satisfied' || g.evidence !== undefined))
    && (plan.amendments === undefined || (Array.isArray(plan.amendments) && plan.amendments.length <= 16
      && plan.amendments.every(a => !!a && Number.isFinite(a.at) && a.at >= 0 && text(a.reason, 500) && ids(a.removed) && ids(a.added))));
}

export function goalsSatisfied(plan: TaskGoalPlan): boolean {
  return plan.coverage === 'verified' && plan.goals.length > 0 && plan.goals.every(g => g.status === 'satisfied');
}

export const taskRequirementId = (index:number):string => `requirement-${index+1}`;

/** Pending answers are fulfilled by the final delivery itself; browser goals must already be verified. */
export function goalsReadyForDelivery(plan:TaskGoalPlan):boolean {
  return plan.coverage==='verified'&&plan.goals.length>0&&plan.goals.every(g=>g.kind==='answer'||g.status==='satisfied');
}
