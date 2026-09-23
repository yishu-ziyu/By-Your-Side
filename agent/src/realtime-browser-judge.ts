import { isBrowserObservation, type BrowserActionGuard, type BrowserDecisionReasonCode } from '../../shared/browser-decision.js';
import { decideBrowserCandidate } from './browser-decision-model.js';
import {
  humanReasonForCode,
  realtimeContinueHint,
  resolveBrowserDecision,
  selectBrowserActionCandidates,
  type BrowserToolGate,
  type RealtimeContinueMount,
} from './browser-action-selection.js';
import type { ToolRpc } from './rpc.js';

export type RealtimeJudgeContinueMount = RealtimeContinueMount;

/** One read + one existing Jev judgment. Never executes the suggested action. */
export async function judgeRealtimeBrowserAction(
  rpc: ToolRpc,
  input: {
    request: string;
    userTask: string;
    tabId?: number;
    history: string[];
    canExecute?: BrowserToolGate;
    /**
     * Which continue entries actually exist for this voice session.
     * Defaults: direct browser tools on (judge is only mounted with them);
     * browser_request on; task_action off unless the host says otherwise.
     * Never invent browser_loop — it is not on the realtime surface.
     */
    continueMount?: Partial<RealtimeContinueMount>;
  },
  signal: AbortSignal,
  decide = decideBrowserCandidate,
) {
  signal.throwIfAborted();
  let tabId = input.tabId ?? rpc.getPageTarget();

  if (!tabId) {
    const active = await rpc.call('get_active_tab', {}) as {tab?: {id: number}};
    tabId = active.tab?.id ?? null;
  }

  if (!tabId) throw new Error('没有可观察的浏览器页面。');
  signal.throwIfAborted();
  const raw = await rpc.call('snapshot', {tabId, decision:true}) as {observation?: unknown};
  signal.throwIfAborted();
  const page = raw.observation;

  if (!isBrowserObservation(page) || page.tabId !== tabId) throw new Error('页面没有返回有效候选，未调用 Jev。');

  const mount: RealtimeContinueMount = {
    directBrowser: input.continueMount?.directBrowser ?? true,
    taskAction: input.continueMount?.taskAction ?? false,
    browserRequest: input.continueMount?.browserRequest ?? true,
  };

  const selection = selectBrowserActionCandidates({
    goal: JSON.stringify({userTask:input.userTask,localGoal:input.request}),
    page,
    materials: [],
    history: input.history,
    canGenerateText: true,
    canExecute: input.canExecute,
  });

  const candidates = selection.candidates;
  let decision;

  try {
    decision = await decide({
      goal:JSON.stringify({userTask:input.userTask,localGoal:input.request}),
      page,candidates,materials:selection.decisionMaterials,history:input.history,
    },signal);
  } catch (e) {
    signal.throwIfAborted();
    const reasonCode: BrowserDecisionReasonCode = 'provider_error';

    return {
      observationId: page.id,
      tabId: page.tabId,
      status: 'uncertain' as const,
      reasonCode,
      reason: e instanceof Error ? e.message : humanReasonForCode(reasonCode),
      continue: realtimeContinueHint(reasonCode, page, mount),
    };
  }

  signal.throwIfAborted();
  const evidence = {observationId:page.id,tabId:page.tabId,confidence:decision.confidence,model:decision.model};
  const verdict = resolveBrowserDecision(decision, candidates, page.id);

  if (verdict.kind === 'reject') {
    return {
      ...evidence,
      status: 'uncertain' as const,
      reasonCode: verdict.reasonCode,
      reason: verdict.reason,
      continue: realtimeContinueHint(verdict.reasonCode, page, mount),
    };
  }

  const candidate = verdict.candidate;

  if (['done','handoff','wait','reobserve','continue_read','select_scope','select_materials'].includes(candidate.operation)) {
    if (candidate.operation === 'done') {
      return {
        ...evidence,
        status: 'needs_verification' as const,
        reason: 'Jev建议结果已满足，但这不是完成证明，请根据页面核对。',
      };
    }

    const reasonCode: BrowserDecisionReasonCode =
      candidate.operation === 'handoff'
        ? (selection.bounded ? 'candidate_budget' : 'unsupported_action')
        : candidate.operation === 'select_materials'
          ? 'candidate_budget'
          : 'observation_incomplete';

    const tools: string[] = [];

    if (mount.directBrowser && (candidate.operation === 'continue_read' || candidate.operation === 'select_scope' || candidate.operation === 'reobserve' || candidate.operation === 'wait')) {
      tools.push('snapshot');
    }

    if (reasonCode === 'unsupported_action' || reasonCode === 'candidate_budget') {
      if (mount.taskAction) tools.push('task_action');
      else if (mount.browserRequest) tools.push('browser_request');
    }

    return {
      ...evidence,
      status: 'needs_context' as const,
      reasonCode,
      reason: humanReasonForCode(reasonCode),
      continue: {
        ...realtimeContinueHint(reasonCode, page, mount),
        ...(candidate.cursor ? { cursor: candidate.cursor } : {}),
        ...(candidate.viewScopeId ? { viewScopeId: candidate.viewScopeId } : {}),
        tools: [...new Set([...(realtimeContinueHint(reasonCode, page, mount).tools ?? []), ...tools])],
      },
      ...(candidate.cursor || candidate.viewScopeId || candidate.materialIds
        ? { view: {
          ...(candidate.cursor ? { cursor: candidate.cursor } : {}),
          ...(candidate.viewScopeId ? { viewScopeId: candidate.viewScopeId } : {}),
          ...(candidate.materialIds ? { materialIds: candidate.materialIds } : {}),
        } }
        : {}),
    };
  }

  if (candidate.operation === 'switch_tab') {
    return {...evidence,status:'suggestion',suggestion:{tool:'tabs',arguments:{action:'switch',tabId:candidate.tabId,
      decisionGuard:{observationId:page.id,operation:'switch_tab',sourceTabId:page.tabId}}}};
  }

  if (candidate.operation === 'hover') {
    if (!candidate.target) {
      return {
        ...evidence,
        status: 'uncertain' as const,
        reasonCode: 'invalid_decision' as const,
        reason: '悬停目标不在当前观察中，未执行。',
        continue: realtimeContinueHint('invalid_decision', page, mount),
      };
    }

    const guard: BrowserActionGuard = {observationId:page.id,operation:'hover',target:candidate.target};

    return {...evidence,status:'suggestion',suggestion:{tool:'hover',arguments:{tabId:page.tabId,target:candidate.target,decisionGuard:guard},
      note:'悬停只为揭示控件；采纳后必须重新观察再点击，不能把悬停前的证据当作完成。'}};
  }

  let operation = candidate.operation === 'select' ? 'fill' : candidate.operation;
  let target = candidate.target;

  if (candidate.operation === 'select') {
    const element = await rpc.call('read_element',{tabId:page.tabId,target}) as {tagName?:string};
    signal.throwIfAborted();

    if (element.tagName?.toLowerCase() !== 'select') {
      if (!candidate.optionRef || !page.controls.some(c => c.ref === candidate.optionRef && !c.disabled)) {
        return {
          ...evidence,
          status: 'uncertain' as const,
          reasonCode: 'no_match' as const,
          reason: '选项不是当前可执行对象，未执行。',
          continue: realtimeContinueHint('no_match', page, mount),
        };
      }

      operation = 'click'; target = candidate.optionRef;
    }
  }

  if (operation !== 'click' && operation !== 'fill' && operation !== 'press_key' && operation !== 'scroll') {
    // drag/upload/CDP are not Jev candidates — hand back via approved delegate, never claim the product lacks the capability.
    const reasonCode: BrowserDecisionReasonCode = 'unsupported_action';

    return {
      ...evidence,
      status: 'uncertain' as const,
      reasonCode,
      reason: humanReasonForCode(reasonCode),
      continue: realtimeContinueHint(reasonCode, page, mount),
    };
  }

  const guard: BrowserActionGuard = {observationId:page.id,operation:operation as BrowserActionGuard['operation'],...(target?{target}:{})};

  return {...evidence,status:'suggestion',suggestion:{tool:operation,arguments:{tabId:page.tabId,
    ...(target?{target}:{}),...(candidate.key?{key:candidate.key}:{}),...(candidate.dy?{dy:candidate.dy}:{}),
    ...(operation === 'fill' && candidate.optionLabel !== undefined ? {value:candidate.optionLabel}:{}),decisionGuard:guard},
    ...(operation === 'fill' && candidate.optionLabel === undefined ? {missingArguments:['value'],note:'由用户原话或已有材料提供填写内容，Jev未生成内容。'}:{})}};
}
