import { executionEffectsFullyKnown } from '../../shared/voice.js';
import { isCopyRequest } from '../../shared/copy-request.js';
import { wrapPageContent } from '../../shared/untrusted.js';
import type { GoalReviewStage, GoalEvidenceReview } from './goal-evidence-judge.js';
import { defineTool } from './define-tool.js';
import { Type } from 'typebox';
import type { TaskProgressSnapshot } from '../../shared/voice.js';
import { taskRequirementId, type TaskGoalDefinition } from '../../shared/task-goals.js';
import { TaskGoalBook } from './task-goals.js';
import { TaskEvidence, elementText, fieldMaterialValue, type ObservedMaterial, type TaskObservation } from './task-evidence.js';

export interface GoalToolHost {
  snapshot(): TaskProgressSnapshot;
  book(): TaskGoalBook;
  evidence: TaskEvidence;
  review(stage:GoalReviewStage,data:unknown,signal:AbortSignal):Promise<GoalEvidenceReview>;
  current(): () => boolean;
  persist(material?: ObservedMaterial): void;
  read(tabId: number, target: string | undefined, signal: AbortSignal, elements?: { selector: string }): Promise<{ id: string; data: Record<string, unknown> }>;
}

interface GoalOperationInput {
  action:'inspect'|'plan'|'read_observation'|'capture'|'verify';
  goals?:TaskGoalDefinition[]; reason?:string;
  observationId?:string; materialId?:string; purpose?:string;
  firstFragment?:string; lastFragment?:string; quote?:string; spans?:Array<{start:number;end:number}>;
  goalId?:string; tabId?:number; target?:string; elements?:{selector:string};
}

/** inspect 里直接附片段的上限：片段数与总字数都小才附，大页面仍用 read_observation。 */
const INLINE_FRAGMENTS_MAX = 24;

const INLINE_FRAGMENT_CHARS_MAX = 2000;

function inlineFragments(observation: TaskObservation): Array<{ id: string; text: string }> | undefined {
  const raw = observation.fragments;

  if (!raw || raw.truncated || raw.fragments.length > INLINE_FRAGMENTS_MAX) return undefined;

  if (raw.fragments.reduce((sum, fragment) => sum + fragment.text.length, 0) > INLINE_FRAGMENT_CHARS_MAX) return undefined;

  return raw.fragments.map(fragment => ({ id: fragment.id, text: fragment.text }));
}

async function executeGoalOperation(getHost:()=>GoalToolHost,input:GoalOperationInput,cancel?:AbortSignal) {
  const host = getHost(), snapshot = host.snapshot(), revision = snapshot.goalPlan?.revision, runId = snapshot.runId;

  if (!runId || !revision || ['aborted', 'interrupted'].includes(snapshot.state)) throw new Error('当前没有可核验的任务');
  const current = host.current(), signal = cancel ?? new AbortController().signal;
  const assertCurrent = () => { if (signal.aborted || !current() || host.snapshot().runId !== runId || host.snapshot().goalPlan?.revision !== revision) throw new Error('任务已变化，旧核验未应用'); };

  const reviewEvidence=host.review;
  const requirements = snapshot.recoveryInput?.requirements ?? (snapshot.goal ? [snapshot.goal] : []);
  const result = (details: unknown,untrusted=false) => ({ content: [{ type: 'text' as const, text: untrusted?wrapPageContent(JSON.stringify(details),{}):JSON.stringify(details) }], details });

  const fieldValues = () => {
    const materials=host.evidence.list(runId,revision).materials;

    return (host.book().snapshot()?.goals??[]).filter(goal=>goal.kind==='field').flatMap(goal=>{
      const material=materials.find(item=>item.id===goal.materialId);
      const value=material&&fieldMaterialValue(goal,material);

      return value===undefined?[]:[{goalId:goal.id,materialId:goal.materialId,value}];
    });
  };

  assertCurrent();

  if (input.action === 'inspect') {
    const listed=host.evidence.list(runId, revision);

    // 小观察直接附上片段编号与原文：capture 要的正是这些编号，免得再调一次 read_observation 或去猜。
    const observations=listed.observations.map(observation=>{
      const fragments=observation.historical?undefined:inlineFragments(host.evidence.read(observation.id,runId));

      return fragments?{...observation,fragments}:observation;
    });

    return result({ requirements:requirements.map((text,i)=>({id:taskRequirementId(i),text})), plan: snapshot.goalPlan, ...listed, observations, fieldValues:fieldValues() },true);
  }

  if (input.action === 'read_observation') return result(host.evidence.read(input.observationId ?? '', runId),true);

  if (input.action === 'plan') {
    const goals = input.goals ?? [];

    // 逐字搬运这套（material 原文 + field 逐字填写）只给用户明说要照原文搬运的请求；其他请求登记了也核对不了（如导出成文件），只会空转并误报未完成。
    if (!isCopyRequest(requirements) && goals.some(goal => goal.kind === 'material' || goal.kind === 'field')) {
      throw new Error('这次用户没有要求照原文搬运（没说复制、粘贴、原文、一字不差等），不要登记 material 或 field 目标。导出文件、整理、调研、改写直接读页面后完成并交付；需要跟踪多步骤页面状态时只用 condition 目标。');
    }

    const revising = snapshot.goalPlan?.coverage === 'verified';

    if (revising && !input.reason?.trim()) throw new Error('这版目标已固定；修订需要一个非空理由，说明为什么调整内部做法、用户要求如何仍被覆盖。');
    // Validate before invoking any model, without changing the live book.
    const candidate = new TaskGoalBook(); candidate.restore(snapshot.goalPlan, false);

    if (revising) candidate.amend(revision, goals as TaskGoalDefinition[], requirements.length, input.reason!);
    else candidate.install(revision, goals as TaskGoalDefinition[], requirements.length);
    // 计划只做上面的确定性覆盖检查（每项要求都被引用、材料与字段成对等），不再让模型复核计划：
    // 复核在 0.5 附近摇摆，只会反复驳回同一份计划，不提高正确性。
    assertCurrent();

    if (revising) host.book().amend(revision, goals as TaskGoalDefinition[], requirements.length, input.reason!);
    else host.book().install(revision, goals as TaskGoalDefinition[], requirements.length);
    host.persist();

    return result(host.book().snapshot());
  }

  if (input.action === 'capture') {
    if(!input.observationId)throw new Error('缺少 observationId：capture_page_material 必须引用 inspect/read_observation 返回的完整来源观察编号。');
    const goal=snapshot.goalPlan?.goals.find(g=>g.kind==='material'&&g.materialId===input.materialId);

    if(snapshot.goalPlan?.coverage!=='verified')throw new Error('先为这个来源材料登记完整目标');

    if(!goal)throw new Error('当前目标没有绑定这个材料编号；用 task_goals inspect 查看当前 materialId，不要重建已有目标');

    if(goal.status==='satisfied') {
      const saved=host.evidence.list(runId,revision).materials.find(material=>material.id===goal.materialId);

      if(!saved)throw new Error('已核验的来源材料不可用，请保留检查点');

      return result(saved,true);
    }

    const observation = host.evidence.read(input.observationId ?? '', runId);

    const material = input.firstFragment || input.lastFragment
      ? host.evidence.prepareFragments(input.materialId ?? '', input.purpose ?? '', observation, input.firstFragment ?? '', input.lastFragment ?? '',input.quote)
      : host.evidence.prepare(input.materialId ?? '', input.purpose ?? '', observation, input.spans ?? []);

    const previousSources=host.evidence.list(runId,revision).materials.filter(saved=>saved.observation.revision!==revision);
    const review = await reviewEvidence('source', { requirements, goal, observation, material, previousSources, historicalObservation:observation.revision!==revision }, signal);
    assertCurrent();

    if (!review.matched) return result(review);
    const currentGoal=host.book().snapshot()?.goals.find(current=>current.id===goal.id);

    if(currentGoal?.status==='satisfied') {
      const saved=host.evidence.list(runId,revision).materials.find(item=>item.id===currentGoal.materialId);

      if(!saved)throw new Error('已核验的来源材料不可用，请保留检查点');

      return result(saved,true);
    }

    const captured={...host.evidence.canonicalMaterial(material),verification:{goalId:goal.id,revision,criterion:goal.criterion,description:goal.description,probability:review.probability,at:Date.now(),reviewedBy:review.reviewedBy}};
    host.evidence.assertSave(captured); host.persist(captured); host.evidence.save(captured);
    host.book().bindPendingMaterial(revision,material.id,captured.id);
    host.book().verify(revision,goal.id,{...review,evidence:{observationId:observation.id,tabId:observation.tabId,verifiedAt:captured.verification.at,materialId:captured.id}});
    host.persist();

    return result({...captured,fieldValues:fieldValues()},true);
  }

  if (snapshot.goalPlan?.coverage !== 'verified') throw new Error('先用 plan 登记完整目标，再按目标标识核验');
  const planned = snapshot.goalPlan.goals;
  const known = planned.map(g => g.id).join('、');
  // verify 按单个目标核验；只给了一个目标的 goals 数组时，它的 id 就是要核验的目标。
  const goalId = input.goalId ?? (input.goals?.length === 1 ? input.goals[0]!.id : undefined);

  if (!goalId) throw new Error(`verify 一次核验一个目标：传 goalId，可选 ${known}。不要传 goals 数组。`);
  const goal = planned.find(g => g.id === goalId);

  if (!goal) throw new Error(`没有目标 ${goalId}；goalId 可选 ${known}。`);

  if(goal.kind==='answer')return result({pending:true,reason:'直接写出回答即可；回答交付时这个目标自动完成。'});
  const material = host.evidence.list(runId, revision).materials.find(m => m.id === goal.materialId);
  let review: { matched: boolean; reason: string }, evidence;

  if (goal.kind === 'material') {
    if (!material) throw new Error('尚未取得这个目标的原文材料');

    if (!material.verification) throw new Error('材料尚未核对来源范围');
    review=material.verification.revision===revision&&material.verification.goalId===goal.id
      ?{matched:true,reason:'已捕获并核对本项目标的完整原文'}
      :await reviewEvidence('reuse',{requirements,goal,material},signal);
    evidence = { observationId: material.observation.id, tabId: material.observation.tabId, verifiedAt: Date.now(), materialId: material.id };
  } else {
    if (!input.tabId) throw new Error('核验缺少 tabId，请指定目标页；condition 可省略 target，用整页观察核验，不必猜选择器。');

    if (goal.kind === 'field' && !input.target) throw new Error('字段核验还需要 target，请指定已观察到的编辑器或字段。');
    const read = await host.read(input.tabId, input.target, signal, goal.kind === 'condition' ? input.elements : undefined);
    assertCurrent();
    const data = read.data;
    const actual = elementText(data);

    if (goal.kind === 'field' && (!material || typeof actual !== 'string' || actual !== fieldMaterialValue(goal,material))) review = { matched: false, reason: !material ? '缺少待写入的原文材料' : actual === '' ? '目标编辑器仍为空' : '目标内容与原文及所要求的来源网址不一致' };
    else review = await reviewEvidence(goal.kind==='field'?'target':'condition', { requirements, goal, target: input.target, page: data, material, executionFacts: host.snapshot().results, executionAuditComplete:executionEffectsFullyKnown(host.snapshot()) }, signal);
    evidence = material ? { observationId: read.id, tabId: input.tabId, verifiedAt: Date.now(), materialId: material.id } : { observationId: read.id, tabId: input.tabId, verifiedAt: Date.now() };
  }

  assertCurrent(); host.book().verify(revision, goal.id, { ...review, evidence }); host.persist();

  return result({ ...review, plan: host.book().snapshot() });
}

export function createTaskGoalsTool(getHost: () => GoalToolHost) {
  return defineTool({
    name: 'task_goals', label: '核对任务目标',
    description: 'Track USER OUTCOMES separately from action receipts. Use this when the user explicitly asks to copy page text verbatim into a field or document (their words say copy, paste, 复制, 粘贴, 原文, 一字不差 and the like), or when a multi-step page task benefits from tracked outcomes; questions, chat and page reading do not need it. Call inspect, then plan with all requirements. An unplanned user-request is only a placeholder: replace it with concrete goals; do not retain it as an extra umbrella goal. Cover all constraints, including source acquisition and destination content for copying. material and field goals are only accepted for such copy requests; exports to files, summaries, research and edits use no material/field goals. Both material and field goals MUST have materialId; a copied field references the same materialId as its source. Use condition for user-provided/generated values and other page states. For an information-only question use one answer goal, with the question and restrictions as its criterion. Read host observations directly; do not invent a material capture requirement or materialId for an answer. An answer completes when your reply is delivered. Never substitute answer for a requested browser change or copied source. Do not create click/switch goals as intermediate steps. Plan is checked for coverage and fixed for this requirement revision: do not replace unmet goals with successful actions. To revise an already-fixed plan without a new user requirement (for example dropping an internal-only source that keeps failing), call plan again with a non-empty reason explaining the method change. Every existing condition/field/answer goal and any already-satisfied goal, including material, then carries over unchanged and cannot be removed or altered; only a still-pending material goal with no field referencing its materialId may be dropped or replaced; new goals may be added. Omitting reason, or touching a locked goal, is rejected before any model review. Inspect lists host-recorded observations and exact saved materials; small observations include their fragments (id + text) inline, so capture directly from those ids; read_observation retrieves source text for larger ones. Use capture_page_material with REQUIRED observationId and a selection; it copies the inclusive first/last fragment range from observation.fragments, preserving original text and explicit line breaks. These IDs are immutable source labels, NEVER live click/fill targets. Prefer fragments over compact snapshot text, which may normalize or clip content. For raw read_element text only, ordered character spans are also supported (joined with newline); code copies exact text after independent source/completeness review. Materials survive task amendments. To reuse an earlier captured source, reference its materialId in the new source goal and verify that goal; the host checks the old source certificate against the new requirement before accepting it. Reuse saved material values verbatim in fill/browser_loop. verify checks ONE goal: pass goalId (not a goals array). It reads a fresh target/page itself, independently checks that goal, and for fields requires exact material equality. For a condition goal only, optionally pass elements:{selector} to have the host itself freshly read every element currently matching that selector (text, visibility, position, computed style, bounded count) as evidence for an on-page annotation/highlight; never fabricate this evidence yourself, and the selector alone does not prove the goal. Marks drawn by the mark tool live in a private host layer that page selectors, read_elements and page JS cannot see; every condition verify automatically includes them as host-read marks, so after marking call verify directly instead of searching the DOM for them. It cannot resolve unknown writes or authorize retries. Never mark yourself done using action receipts. If evidence is insufficient, keep the goal pending and report partial with the actual missing requirement.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('inspect'),Type.Literal('plan'),Type.Literal('read_observation'),Type.Literal('verify')]),
      goals: Type.Optional(Type.Array(Type.Object({ id: Type.String(), description: Type.String(), criterion: Type.String(), requirements: Type.Array(Type.String({description:"Copy requirement IDs from inspect.requirements, e.g. requirement-1. These refer to USER inputs, not goal numbers."})), kind: Type.Union([Type.Literal('material'), Type.Literal('field'), Type.Literal('condition'),Type.Literal('answer')]), materialId: Type.Optional(Type.String()), appendSourceUrl:Type.Optional(Type.Boolean({description:'Field goals only: set true when the user requests the source URL. Expected field value is exact material.value + newline + its observed source URL; no other additions.'})) }), { maxItems: 32 })),
      reason: Type.Optional(Type.String({minLength:1,maxLength:500,description:'Required only when revising an already-fixed (verified) plan with the same requirement revision; explain the method change.'})),
      observationId: Type.Optional(Type.String({description:'Exact source observation id from inspect.'})),
      goalId: Type.Optional(Type.String()), tabId: Type.Optional(Type.Integer({ minimum: 1, description: 'verify: REQUIRED for condition and field goals. The tab to read, e.g. the tabId in the browser_run result or inspect observations.' })), target: Type.Optional(Type.String()),
      elements: Type.Optional(Type.Object({selector:Type.String({minLength:1,description:'Native CSS selector; the host freshly reads every current match as verify evidence for a condition goal.'})})),
    }),
    execute: (_id,input,cancel)=>executeGoalOperation(getHost,input,cancel),
  });
}

/** A source capture is a first-class operation with an explicit, required observation identity. */
export function createCapturePageMaterialTool(getHost:()=>GoalToolHost) {
  return defineTool({
    name:'capture_page_material',label:'保存页面原文',
    description:'Capture exact source text already read by this task. First inspect/read_observation through task_goals, then pass its observationId here. Fragment IDs are scoped to THAT observation, not live page selectors. Select the complete requested BODY, excluding author names, pin badges and UI controls unless the user asked for them. The host copies the raw text and line breaks; do not regenerate it or use JavaScript to re-extract it. Capture is independently checked, satisfies the linked source goal, and returns an observed material for exact filling. Use the returned material id: the host gives a newly captured source its own id when an older task revision already used that name. If rejected, correct the selection instead of filling your own reconstructed text.',
    parameters:Type.Object({
      observationId:Type.String({minLength:1,description:'Required: exact observation id from task_goals inspect/read_observation.'}),
      materialId:Type.String({minLength:1,description:'materialId of the already planned source goal.'}),
      purpose:Type.String({minLength:1,maxLength:500}),
      selection:Type.Union([
        Type.Object({kind:Type.Literal('fragments'),first:Type.String({minLength:1}),last:Type.String({minLength:1}),quote:Type.Optional(Type.String({minLength:1,maxLength:8000,description:'Exact unique substring within these raw fragments. Required when the user requests only a sentence or excerpt inside a larger fragment. Copy it verbatim; the host locates and copies the original characters. Omit only when the entire fragment range is requested.'}))}),
        Type.Object({kind:Type.Literal('text'),spans:Type.Array(Type.Object({start:Type.Integer({minimum:0}),end:Type.Integer({minimum:1})}),{minItems:1,maxItems:128})}),
      ]),
    }),
    execute:(_id,input,signal)=>executeGoalOperation(getHost,{action:'capture',observationId:input.observationId,materialId:input.materialId,purpose:input.purpose,...(input.selection.kind==='fragments'?{firstFragment:input.selection.first,lastFragment:input.selection.last,quote:input.selection.quote}:{spans:input.selection.spans})},signal),
  });
}
