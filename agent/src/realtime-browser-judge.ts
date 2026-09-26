import { isBrowserObservation, type BrowserActionGuard, type BrowserContinueHint, type BrowserDecisionReasonCode, type BrowserObservation } from '../../shared/browser-decision.js';
import {
  goalConcernsBrowserTabs,
  humanReasonForCode,
  nextObservationExpansion,
  observationCheckKey,
  realtimeContinueHint,
  type BrowserToolGate,
  type ObservationCheckKey,
  type RealtimeContinueMount,
} from './browser-action-selection.js';
import { InvalidAnswer, actKind, buildActRequest, buildLocateRequest, composeAct, composeLocate, questionRequest } from './browser-questions.js';
import { JEV_MODEL, askJev, type AskJev, type JevTrace } from './jev-client.js';
import type { ToolRpc } from './rpc.js';

export type RealtimeJudgeContinueMount = RealtimeContinueMount;

/** What the voice layer receives: one guarded suggestion, or a typed reason with a continue hint. */
export type RealtimeBrowserJudgment = {
  observationId: string;
  tabId: number;
  confidence: number;
  model: string;
  status: 'suggestion' | 'needs_context' | 'uncertain' | 'needs_verification';
  reasonCode?: BrowserDecisionReasonCode;
  reason?: string;
  continue?: BrowserContinueHint;
  suggestion?: { tool: string; arguments: Record<string, unknown>; note?: string; missingArguments?: string[] };
};

/** Jev requests one judgment may spend, including reads of unread windows and the per-action request. */
const JUDGE_CALL_BUDGET = 6;

/**
 * Reads the page (and its unread windows) and answers with one guarded suggestion or a typed reason.
 * Never executes the suggested action; the voice layer runs it with the existing tool afterwards.
 */
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
  ask: AskJev = askJev,
  diagnostics?: { onTrace?: (event: JevTrace) => void },
): Promise<RealtimeBrowserJudgment> {
  signal.throwIfAborted();
  let tabId = input.tabId ?? rpc.getPageTarget();

  if (!tabId) {
    const active = await rpc.call('get_active_tab', {}) as { tab?: { id: number } };
    tabId = active.tab?.id ?? null;
  }

  if (!tabId) throw new Error('没有可观察的浏览器页面。');

  const mount: RealtimeContinueMount = {
    directBrowser: input.continueMount?.directBrowser ?? true,
    taskAction: input.continueMount?.taskAction ?? false,
    browserRequest: input.continueMount?.browserRequest ?? true,
  };

  const observe = async (params: Record<string, unknown>): Promise<BrowserObservation> => {
    signal.throwIfAborted();
    const raw = await rpc.call('snapshot', { tabId, decision: true, ...params }) as { observation?: unknown };
    signal.throwIfAborted();

    if (!isBrowserObservation(raw?.observation) || raw.observation.tabId !== tabId) throw new Error('页面没有返回有效候选，未调用 Jev。');

    return raw.observation;
  };

  const request = questionRequest(input.request, input.userTask);
  const goalText = `${input.request}\n${input.userTask}`;
  const allowed = (tool: string) => !input.canExecute || input.canExecute(tool);
  const checked = new Set<ObservationCheckKey>();
  let page = await observe({});
  let calls = 0;
  let confidence = 0;

  const evidence = () => ({ observationId: page.id, tabId: page.tabId, confidence, model: JEV_MODEL });

  const uncertain = (reasonCode: BrowserDecisionReasonCode, reason = humanReasonForCode(reasonCode)) =>
    ({ ...evidence(), status: 'uncertain' as const, reasonCode, reason, continue: realtimeContinueHint(reasonCode, page, mount) });

  const guard = (operation: BrowserActionGuard['operation'], target: string): BrowserActionGuard => ({ observationId: page.id, operation, target });

  const judge = async (jevRequest: Parameters<AskJev>[0]) => {
    calls++;

    return ask(jevRequest, signal, diagnostics?.onTrace ? { onTrace: diagnostics.onTrace } : undefined);
  };

  const track = (next: BrowserObservation) => {
    checked.add(observationCheckKey('observation', next.id));

    if (next.viewScopeId) checked.add(observationCheckKey('scope', next.viewScopeId));

    // The whole page in one complete view already shows every partition: none is left to read.
    if (!next.viewScopeId && !next.hasMore) for (const scope of next.scopes ?? []) checked.add(observationCheckKey('scope', scope.id));
  };

  track(page);

  try {
    for (;;) {
      if (calls >= JUDGE_CALL_BUDGET) {
        const hint = realtimeContinueHint('observation_incomplete', page, mount);

        return { ...evidence(), status: 'needs_context' as const, reasonCode: 'observation_incomplete' as const, reason: humanReasonForCode('observation_incomplete'), continue: hint };
      }

      const unreadScopes = (page.scopes ?? []).filter(s => s.id !== page.viewScopeId && !checked.has(observationCheckKey('scope', s.id)));
      const tabs = goalConcernsBrowserTabs(goalText, page) && allowed('tabs') ? (page.tabs ?? []).filter(t => t.id !== page.tabId) : [];
      const located = buildLocateRequest({ request, page, actionsDone: input.history, acted: new Set(), unreadScopes, tabs });
      const verdict = composeLocate(await judge(located.request), located, { hasActions: input.history.length > 0, hovered: new Set(), hoverShowedNothing: new Set() });
      signal.throwIfAborted();
      confidence = verdict.confidence;

      if (verdict.kind === 'done') return { ...evidence(), status: 'needs_verification' as const, reason: 'Jev判断已有动作完成了这一步，但这不是完成证明，请根据页面核对。' };

      if (verdict.kind === 'unsure') return uncertain('low_confidence');

      if (verdict.kind === 'switch_tab') {
        if (!allowed('tabs')) return uncertain('unsupported_action');

        return { ...evidence(), status: 'suggestion' as const, suggestion: { tool: 'tabs', arguments: { action: 'switch', tabId: verdict.tab.id, decisionGuard: { observationId: page.id, operation: 'switch_tab', sourceTabId: page.tabId } } } };
      }

      if (verdict.kind === 'reveal') {
        if (!allowed('hover')) return uncertain('unsupported_action');

        return { ...evidence(), status: 'suggestion' as const, suggestion: { tool: 'hover', arguments: { tabId: page.tabId, target: verdict.control.ref, decisionGuard: guard('hover', verdict.control.ref) },
          note: '悬停只为展开菜单；采纳后重新判断再点击，不能把悬停当作完成。' } };
      }

      if (verdict.kind === 'act' || verdict.kind === 'open') {
        const control = verdict.control;
        const kind = verdict.kind === 'open' ? 'click' : actKind(control);

        if (kind === 'fill') {
          // No materials on the voice surface: Jev never writes the text; the caller supplies it.
          if (!allowed('fill')) return uncertain('unsupported_action');

          return { ...evidence(), status: 'suggestion' as const, suggestion: { tool: 'fill', arguments: { tabId: page.tabId, target: control.ref, decisionGuard: guard('fill', control.ref) },
            missingArguments: ['value'], note: '由用户原话或已有材料提供填写内容，Jev未生成内容。' } };
        }

        const asked = buildActRequest({ request, control, kind, actionsDone: input.history, materials: [] })!;
        const act = composeAct(kind, control, await judge(asked.request), asked);
        signal.throwIfAborted();

        if (act.kind === 'risky') return uncertain('permission_required', `${control.name} 可能删除、付款、发送或发布内容，需要用户确认。`);

        if (act.kind === 'unsure') return uncertain('low_confidence');

        if (act.kind === 'already') return { ...evidence(), status: 'needs_verification' as const, reason: `「${control.name}」已经是${act.on ? '开启' : '关闭'}状态，不需要点击；请根据页面核对。` };

        if (act.kind === 'select') {
          const element = await rpc.call('read_element', { tabId: page.tabId, target: control.ref }) as { tagName?: string };
          signal.throwIfAborted();

          if (element.tagName?.toLowerCase() === 'select') {
            if (!allowed('fill')) return uncertain('unsupported_action');

            return { ...evidence(), status: 'suggestion' as const, suggestion: { tool: 'fill', arguments: { tabId: page.tabId, target: control.ref, value: act.option.label, decisionGuard: guard('fill', control.ref) } } };
          }

          if (!allowed('click')) return uncertain('unsupported_action');

          if (!page.controls.some(c => c.ref === act.option.ref && !c.disabled)) return uncertain('no_match', '选项不是当前可执行对象，未执行。');

          return { ...evidence(), status: 'suggestion' as const, suggestion: { tool: 'click', arguments: { tabId: page.tabId, target: act.option.ref, decisionGuard: guard('click', act.option.ref) } } };
        }

        if (!allowed('click')) return uncertain('unsupported_action');

        return { ...evidence(), status: 'suggestion' as const, suggestion: { tool: 'click', arguments: { tabId: page.tabId, target: control.ref, decisionGuard: guard('click', control.ref) } } };
      }

      // Not in this view: read the next unread window (read-only), most likely part first.
      const preferred = verdict.kind === 'read' ? verdict.order.find(id => !checked.has(observationCheckKey('scope', id))) : undefined;
      let params: Record<string, unknown> | undefined;

      if (page.hasMore && page.nextCursor && !checked.has(observationCheckKey('cursor', page.nextCursor))) {
        checked.add(observationCheckKey('cursor', page.nextCursor));
        params = { cursor: page.nextCursor, ...(page.viewScopeId ? { viewScopeId: page.viewScopeId } : {}) };
      } else if (preferred) {
        checked.add(observationCheckKey('scope', preferred));
        params = { viewScopeId: preferred };
      } else {
        const expansion = nextObservationExpansion(page, checked);

        if (expansion) {
          checked.add(expansion.checkKey);
          params = expansion.params;
        }
      }

      if (!params) return uncertain('no_match');
      page = await observe(params);
      track(page);
    }
  } catch (e) {
    signal.throwIfAborted();

    if (e instanceof InvalidAnswer) return uncertain('invalid_decision', e.message);
    const reasonCode: BrowserDecisionReasonCode = e instanceof Error && e.message.includes('候选资料超过当前决策预算') ? 'candidate_budget' : 'provider_error';

    return uncertain(reasonCode, e instanceof Error ? e.message : humanReasonForCode(reasonCode));
  }
}
