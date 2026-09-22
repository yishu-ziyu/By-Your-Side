import { browserCandidates, isBrowserObservation, type BrowserActionGuard } from '../../shared/browser-decision.js';
import { decideBrowserCandidate } from './browser-decision-model.js';
import type { ToolRpc } from './rpc.js';

/** One read + one existing Jev judgment. Never executes the suggested action. */
export async function judgeRealtimeBrowserAction(
  rpc: ToolRpc,
  input: { request: string; userTask: string; tabId?: number; history: string[] },
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
  const candidates = browserCandidates(page, [], true);
  if (candidates.length > 256) return {status:'uncertain',reason:'候选过多，请缩小当前要求；没有执行操作。'};
  const decision = await decide({
    goal:JSON.stringify({userTask:input.userTask,localGoal:input.request}),
    page,candidates,materials:[],history:input.history,
  },signal);
  signal.throwIfAborted();
  const candidate = candidates.find(c => c.id === decision.candidateId);
  const evidence = {observationId:page.id,tabId:page.tabId,confidence:decision.confidence,model:decision.model};
  if (decision.observationId !== page.id || !candidate || !Number.isFinite(decision.confidence)
    || decision.confidence < .85 || decision.confidence > 1) {
    return {...evidence,status:'uncertain',reason:'没有可靠的当前对象；请补充观察或澄清，未执行。'};
  }
  if (['done','handoff','wait','reobserve'].includes(candidate.operation)) {
    return {...evidence,status:candidate.operation === 'done' ? 'needs_verification' : 'needs_context',
      reason:candidate.operation === 'done' ? 'Jev建议结果已满足，但这不是完成证明，请根据页面核对。' : '当前缺少可靠的可执行对象或需要新观察，未执行。'};
  }
  if (candidate.operation === 'switch_tab') {
    return {...evidence,status:'suggestion',suggestion:{tool:'tabs',arguments:{action:'switch',tabId:candidate.tabId,
      decisionGuard:{observationId:page.id,operation:'switch_tab',sourceTabId:page.tabId}}}};
  }
  let operation = candidate.operation === 'select' ? 'fill' : candidate.operation;
  let target = candidate.target;
  if (candidate.operation === 'select') {
    const element = await rpc.call('read_element',{tabId:page.tabId,target}) as {tagName?:string};
    signal.throwIfAborted();
    if (element.tagName?.toLowerCase() !== 'select') {
      if (!candidate.optionRef || !page.controls.some(c => c.ref === candidate.optionRef && !c.disabled)) {
        return {...evidence,status:'uncertain',reason:'选项不是当前可执行对象，未执行。'};
      }
      operation = 'click'; target = candidate.optionRef;
    }
  }
  const guard: BrowserActionGuard = {observationId:page.id,operation:operation as BrowserActionGuard['operation'],...(target?{target}:{})};
  return {...evidence,status:'suggestion',suggestion:{tool:operation,arguments:{tabId:page.tabId,
    ...(target?{target}:{}),...(candidate.key?{key:candidate.key}:{}),...(candidate.dy?{dy:candidate.dy}:{}),
    ...(operation === 'fill' && candidate.optionLabel !== undefined ? {value:candidate.optionLabel}:{}),decisionGuard:guard},
    ...(operation === 'fill' && candidate.optionLabel === undefined ? {missingArguments:['value'],note:'由用户原话或已有材料提供填写内容，Jev未生成内容。'}:{})}};
}
