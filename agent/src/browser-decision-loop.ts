import { isBrowserObservation, type BrowserActionGuard, type BrowserContinueHint, type BrowserControl, type BrowserDecisionReasonCode, type BrowserLoopOutcome, type BrowserMaterial, type BrowserObservation, type BrowserOperation, type BrowserStepReceipt } from '../../shared/browser-decision.js';
import { browserContextChange } from '../../shared/browser-decision-context.js';
import type { ToolExecutionFact, ToolName } from '../../shared/protocol.js';
import {
  checkedRangeFromKeys,
  goalConcernsBrowserTabs,
  humanReasonForCode,
  modelToolForOperation,
  nextObservationExpansion,
  observationCheckKey,
  piContinueHint,
  type BrowserToolGate,
  type ObservationCheckKey,
} from './browser-action-selection.js';
import type { BrowserMaterialResult } from './browser-material.js';
import {
  InvalidAnswer,
  RISK_BLOCK,
  actKind,
  actionableControls,
  buildActRequest,
  buildLocateRequest,
  composeAct,
  composeLocate,
  controlKey,
  controlSetSignature,
  describeControl,
  loopQuestionRequest,
  markControl,
  nameControl,
} from './browser-questions.js';
import { JEV_MODEL, askJev, type AskJev, type JevAnswers, type JevRequest, type JevTrace } from './jev-client.js';

export interface BrowserLoopOptions {
  /** Actual host tool call ID; child IDs are shared with RPC and step events. */
  parentCallId: string;
  goal: string;
  materials: BrowserMaterial[];
  signal: AbortSignal;
  call: (name: ToolName, params: Record<string, unknown>, toolCallId: string) => Promise<unknown>;
  /** Jev judgment; tests and diagnostics replace it. */
  ask?: AskJev;
  /** Diagnostics only (fixture inputs): every Jev request/response of this loop. */
  onTrace?: (event: JevTrace) => void;
  reserveDecision?: () => void;
  getMaterial?: (goal: string, control: BrowserControl, signal: AbortSignal) => Promise<BrowserMaterialResult>;
  onStep?: (receipt: BrowserStepReceipt) => void;
  /** Model-visible tool gate (canExecute / isToolActive). Hidden tools are a separate concern. */
  canExecute?: BrowserToolGate;
}

/** Jev requests per loop, including the small per-action requests. */
const DECISION_CALL_BUDGET = 16;

const TEXT_HELPER_BUDGET = 8;

/**
 * Bounded browser loop built on narrow Jev questions (browser-questions.ts). Code owns the flow and every
 * side effect; `needs_verification` means Jev judged the request done from code-written action facts,
 * which the caller still treats as a proposal unless direct delivery is switched on.
 */
export async function runBrowserDecisionLoop(options: BrowserLoopOptions): Promise<BrowserLoopOutcome> {
  const ask = options.ask ?? askJev;
  const request = loopQuestionRequest(options.goal);
  const goalText = typeof request.whole_task === 'string' ? `${request.task as string}\n${request.whole_task}` : request.task as string;
  const hostMaterials = options.materials.map(m => ({ ...m }));
  const receipts: BrowserStepReceipt[] = [];
  const decisions: BrowserLoopOutcome['decisions'] = [];
  /** Code-written facts for Jev: what happened, never advice to an executor. */
  const actionsDone: string[] = [];
  const acted = new Set<string>();
  const hovered = new Set<string>();
  const hoverShowedNothing = new Set<string>();
  const checkedKeys = new Set<ObservationCheckKey>();
  const readSignatures = new Set<string>();
  const seenObservationIds: string[] = [];
  const clicks: Array<{ name: string; risk: number }> = [];
  let page: BrowserObservation | undefined;
  let fromRead = false;
  let lastSearchFill: BrowserControl | undefined;
  let modelCalls = 0;
  let textCalls = 0;
  let stale = 0;
  let seq = 0;
  const start = Date.now();
  const hasUnknown = () => receipts.some(r => r.executionFact === 'unknown');

  const finish = (status: BrowserLoopOutcome['status'], reason: string, reasonCode?: BrowserDecisionReasonCode, cont?: BrowserContinueHint): BrowserLoopOutcome => {
    const outcome: BrowserLoopOutcome = { status, reason, receipts, lastObservation: page, modelCalls, decisions };

    if (reasonCode) outcome.reasonCode = reasonCode;
    const range = checkedRangeFromKeys(checkedKeys, seenObservationIds);

    if (cont) outcome.continue = cont;
    else if (reasonCode) outcome.continue = piContinueHint(reasonCode, range, hasUnknown());
    else if (seenObservationIds.length) outcome.continue = { action: 'session_prompt', checkedRange: range, preserveFacts: hasUnknown() };

    return outcome;
  };

  const finishCode = (status: BrowserLoopOutcome['status'], reasonCode: BrowserDecisionReasonCode, reason = humanReasonForCode(reasonCode)) => finish(status, reason, reasonCode);

  const active = () => {
    if (options.signal.aborted) throw new Error('调用已取消');

    if (Date.now() - start > 90000) throw new Error('任务循环时长预算已用完');
  };

  const nextCallId = () => `${options.parentCallId}/decision-${++seq}`;

  const call = async (name: ToolName, params: Record<string, unknown>, toolCallId = nextCallId()) => {
    active();

    return options.call(name, params, toolCallId);
  };

  const note = (r: BrowserStepReceipt) => {
    receipts.push(r);
    options.onStep?.(r);
  };

  const track = (next: BrowserObservation) => {
    if (!seenObservationIds.includes(next.id)) seenObservationIds.push(next.id);
    checkedKeys.add(observationCheckKey('observation', next.id));

    if (next.viewScopeId) checkedKeys.add(observationCheckKey('scope', next.viewScopeId));

    // The whole page in one complete view already shows every partition: none is left to read.
    if (!next.viewScopeId && !next.hasMore) for (const scope of next.scopes ?? []) checkedKeys.add(observationCheckKey('scope', scope.id));
  };

  const observe = async (params: Record<string, unknown>): Promise<BrowserObservation | undefined> => {
    const raw = await call('snapshot', { decision: true, ...params });
    const next = (raw as { observation?: unknown })?.observation;

    return isBrowserObservation(next) ? next : undefined;
  };

  /** Fresh capture of the partition the action happened in, so its result is judged in the same view. */
  const reobserve = (from: BrowserObservation) => observe(from.viewScopeId ? { viewScopeId: from.viewScopeId, fresh: true } : {});

  const allowed = (operation: BrowserOperation) => {
    const tool = modelToolForOperation(operation);

    return !options.canExecute || !tool || options.canExecute(tool);
  };

  /** One Jev request under the shared budget; the answer is recorded as a decision. */
  const judge = async (jevRequest: JevRequest): Promise<JevAnswers> => {
    if (modelCalls >= DECISION_CALL_BUDGET) throw new BudgetSpent();
    active();
    options.reserveDecision?.();
    modelCalls++;

    return ask(jevRequest, options.signal, options.onTrace ? { onTrace: options.onTrace } : undefined);
  };

  const record = (observationId: string, what: string, confidence: number, startedAt: number) => {
    decisions.push({ observationId, candidateId: what, confidence, model: JEV_MODEL, elapsedMs: Date.now() - startedAt });
  };

  /**
   * Execute one guarded write/hover. Stale guards re-observe (bounded); anything else unknown stops.
   * Returns the executor result, or a finished outcome.
   */
  const execute = async (operation: 'click' | 'fill' | 'hover' | 'press_key', control: BrowserControl, params: Record<string, unknown>, reported: BrowserOperation = operation): Promise<{ result: unknown; toolCallId: string } | { stop: BrowserLoopOutcome } | { retry: true }> => {
    const current = page!;
    const guard: BrowserActionGuard = { observationId: current.id, operation, target: control.ref };
    const toolCallId = nextCallId();

    try {
      const result = await call(operation, { tabId: current.tabId, target: control.ref, decisionGuard: guard, ...params }, toolCallId);

      return { result, toolCallId };
    } catch (e) {
      const error = e as Error & { executionFact?: string };
      const executionFact: ToolExecutionFact = error.executionFact === 'not_executed' ? 'not_executed' : 'unknown';
      note({ toolCallId, observationId: current.id, candidateId: control.ref, operation: reported, executionFact, verification: 'unverified', detail: error.message });

      if (executionFact === 'not_executed' && error.message.includes('DECISION_STALE:') && ++stale <= 2) return { retry: true };

      if (options.signal.aborted) return { stop: finish('cancelled', '任务已取消') };

      return { stop: finishCode('handoff', executionFact === 'not_executed' ? 'stale_observation' : 'execution_unknown', '动作失败或结果未知，已停止；核对真实状态后再规划，不重放写入') };
    }
  };

  if (!options.goal.trim() || options.goal.length > 12000 || options.materials.length > 12 || new Set(options.materials.map(m => m.id)).size !== options.materials.length || options.materials.some(m => !m.id || typeof m.value !== 'string' || m.value.length > 8000 || !['user', 'generated', 'observed'].includes(m.source))) {
    return finish('blocked', '目标或材料超出支持边界');
  }

  try {
    for (let step = 0; step < 24; step++) {
      active();

      if (!page) {
        const next = await observe({});

        if (!next) return finishCode('handoff', 'observation_incomplete', '浏览器未返回带身份的结构化观察');
        page = next;
        track(next);
        fromRead = false;
      }

      // A clipped collection with nothing in view is not "no target": read the next window or hand back.
      const legacyConflated = page.truncated && page.textTruncated === undefined && page.controlsTruncated === undefined;

      if ((legacyConflated || page.controlsTruncated) && !page.controls.length && !page.tabs?.length || legacyConflated && !page.tabs?.length) {
        const expansion = nextObservationExpansion(page, checkedKeys);
        const next = expansion ? (checkedKeys.add(expansion.checkKey), await observe(expansion.params)) : undefined;

        if (!next) return finishCode('handoff', 'observation_incomplete', '控件观察被截断，不能把缺失候选当成全部页面');
        page = next;
        track(next);
        fromRead = true;
        continue;
      }

      const signature = controlSetSignature(actionableControls(page, acted));
      const repeatRead = fromRead && readSignatures.has(signature);
      readSignatures.add(signature);
      let verdict: ReturnType<typeof composeLocate> | undefined;

      if (!repeatRead) {
        const unreadScopes = (page.scopes ?? []).filter(s => s.id !== page!.viewScopeId && !checkedKeys.has(observationCheckKey('scope', s.id)));
        const otherTabs = goalConcernsBrowserTabs(goalText, page) && allowed('switch_tab') ? (page.tabs ?? []).filter(t => t.id !== page!.tabId) : [];
        const located = buildLocateRequest({ request, page, actionsDone, acted, unreadScopes, tabs: otherTabs });
        const startedAt = Date.now();
        const answers = await judge(located.request);
        active();
        verdict = composeLocate(answers, located, { hasActions: actionsDone.length > 0, hovered, hoverShowedNothing });
        record(page.id, 'control' in verdict ? `${verdict.kind}:${verdict.control.ref}` : verdict.kind === 'switch_tab' ? `switch_tab:${verdict.tab.id}` : verdict.kind, verdict.confidence, startedAt);

        if (verdict.kind === 'done') {
          const outcome = finish('needs_verification', '完成判断达到门槛（依据代码记录的动作事实）；未经主模型复核');
          outcome.completion = { confidence: verdict.confidence, facts: [...actionsDone], lowRiskWrites: clicks.every(c => c.risk < RISK_BLOCK), clicked: clicks.map(c => c.name) };

          return outcome;
        }

        if (verdict.kind === 'unsure') return finishCode('handoff', 'low_confidence', `不确定是否是 ${describeControl(verdict.control)}（${verdict.confidence.toFixed(2)}），未执行`);

        if (verdict.kind === 'switch_tab') {
          const target = verdict.tab;
          const toolCallId = nextCallId();
          let executed = false;
          let inFront = false;

          try {
            const switched = await call('switch_tab', { tabId: target.id, decisionGuard: { observationId: page.id, operation: 'switch_tab', sourceTabId: page.tabId } }, toolCallId) as { verification?: { workingTabId?: number | null; activeTabId?: number } } | undefined;
            executed = true;

            // The executor reads back which tab the agent now works in; bringing it to front depends on whether the conversation is visible.
            if (switched?.verification?.workingTabId !== target.id) throw new Error('工作标签页没有切到目标');
            inFront = switched.verification.activeTabId === target.id;
            note({ toolCallId, observationId: page.id, candidateId: `browser-tab-${target.id}`, operation: 'switch_tab', executionFact: 'executed', verification: 'unverified', detail: `已把工作标签页切到「${target.title}」${inFront ? '，并在窗口中显示' : ''}` });
          } catch (e) {
            const error = e as Error & { executionFact?: string };
            const executionFact: ToolExecutionFact = executed ? 'executed' : error.executionFact === 'not_executed' ? 'not_executed' : 'unknown';
            note({ toolCallId, observationId: page.id, candidateId: `browser-tab-${target.id}`, operation: 'switch_tab', executionFact, verification: 'unverified', detail: error.message });

            if (executionFact === 'not_executed' && error.message.includes('DECISION_STALE:') && ++stale <= 2) {
              page = undefined;
              continue;
            }

            if (options.signal.aborted) return finish('cancelled', '任务已取消');

            return finishCode('handoff', executionFact === 'unknown' ? 'execution_unknown' : 'stale_observation', '标签切换未核验，保留回执并交回任务模型');
          }

          actionsDone.push(`Switched to the browser tab "${target.title}" (${target.url})${inFront ? '; it is now the active tab' : '; the agent now works in it'}.`);
          page = undefined;
          stale = 0;
          continue;
        }

        if (verdict.kind === 'reveal') {
          const control = verdict.control;

          if (!allowed('hover')) return finishCode('handoff', 'unsupported_action', '需要悬停展开菜单，但悬停工具当前不可用');
          const done = await execute('hover', control, {});

          if ('stop' in done) return done.stop;

          if ('retry' in done) { page = undefined; continue; }

          note({ toolCallId: done.toolCallId, observationId: page.id, candidateId: control.ref, operation: 'hover', executionFact: 'executed', verification: 'unverified', detail: `${describeControl(control)}：已悬停` });
          const before = new Set(page.controls.map(c => `${c.role}|${c.name}`));
          const after = await reobserve(page);

          if (!after) return finishCode('handoff', 'observation_incomplete', '悬停后没有取得可靠的新观察');
          markControl(hovered, control);
          const revealed = after.controls.filter(c => !before.has(`${c.role}|${c.name}`)).map(c => `${c.role} "${c.name}"`);

          if (!revealed.length) markControl(hoverShowedNothing, control);
          actionsDone.push(revealed.length
            ? `Opened ${nameControl(control)} by hovering; it now shows ${revealed.slice(0, 12).join(', ')}${revealed.length > 12 ? ` and ${revealed.length - 12} more` : ''}.`
            : `Hovered ${nameControl(control)}; nothing new appeared.`);
          page = after;
          track(after);
          fromRead = false;
          stale = 0;
          continue;
        }
      }

      if (verdict && (verdict.kind === 'act' || verdict.kind === 'open')) {
        const control = verdict.control;
        const kind = verdict.kind === 'open' ? 'click' : actKind(control);
        const asked = buildActRequest({ request, control, kind, actionsDone, materials: hostMaterials });
        let act: ReturnType<typeof composeAct>;

        if (asked) {
          const startedAt = Date.now();
          const answers = await judge(asked.request);
          active();
          act = composeAct(kind, control, answers, asked);
          record(page.id, `${act.kind}:${control.ref}`, 'confidence' in act ? act.confidence : 'risk' in act ? 1 - act.risk : 1, startedAt);
        } else {
          act = composeAct(kind, control, {}, null);
        }

        if (act.kind === 'risky') return finishCode('handoff', 'permission_required', `${describeControl(control)} 可能删除、付款、发送或发布内容（${act.risk.toFixed(2)}），需用户确认，未执行`);

        if (act.kind === 'unsure') return finishCode('handoff', 'low_confidence', `不确定要对 ${describeControl(control)} 做什么（${act.confidence.toFixed(2)}），未执行`);

        if (act.kind === 'already') {
          markControl(acted, control);
          actionsDone.push(`${nameControl(control)} is already ${act.on ? 'on' : 'off'}; it was not clicked.`);
          fromRead = false;
          continue;
        }

        if (act.kind === 'click' || act.kind === 'toggle') {
          if (!allowed('click')) return finishCode('handoff', 'unsupported_action', '点击工具当前不可用');
          const done = await execute('click', control, {});

          if ('stop' in done) return done.stop;

          if ('retry' in done) { page = undefined; continue; }

          const data = done.result as { clicked?: boolean; held?: boolean; effect?: { evidence?: string[] } } | undefined;

          if (data?.held) {
            note({ toolCallId: done.toolCallId, observationId: page.id, candidateId: control.ref, operation: 'click', executionFact: 'not_executed', verification: 'unverified', detail: '等待现有权限/用户确认，未执行点击' });

            return finishCode('handoff', 'permission_required', '当前动作等待用户确认');
          }

          note({ toolCallId: done.toolCallId, observationId: page.id, candidateId: control.ref, operation: 'click', executionFact: 'executed', verification: 'unverified', detail: `${describeControl(control)}：已点击一次，浏览器确认送达` });

          if (options.signal.aborted) return finish('cancelled', '任务已取消');
          markControl(acted, control);
          clicks.push({ name: control.name, risk: act.risk });
          const after = await reobserve(page);

          if (!after) return finishCode('handoff', 'observation_incomplete', '动作已发生，但没有取得可靠的新观察');
          const now = after.controls.find(c => controlKey(c) === controlKey(control));
          const state = act.kind === 'toggle' && now?.checked !== undefined ? ` It is now ${now.checked === true ? 'checked' : 'not checked'}.` : '';
          const reaction = data?.effect?.evidence?.length ? ` The page reacted: ${data.effect.evidence.slice(0, 3).join('; ')}.` : '';
          actionsDone.push(`Clicked ${nameControl(control)} once; the browser confirmed the click was delivered.${state}${reaction}`);
          page = after;
          track(after);
          fromRead = false;
          stale = 0;
          continue;
        }

        // select / fill: write, then read the field back before recording the fact.
        let value: string;
        let clickOption: string | undefined;

        if (act.kind === 'select') {
          const element = await call('read_element', { tabId: page.tabId, target: control.ref }) as { tagName?: string };

          if (element.tagName?.toLowerCase() === 'select') value = act.option.label;
          else {
            if (!page.controls.some(c => c.ref === act.option.ref && !c.disabled)) return finishCode('handoff', 'no_match', '选项没有可执行的当前对象引用');
            clickOption = act.option.ref;
            value = act.option.label;
          }
        } else if (act.kind === 'fill') {
          value = act.material.value;
        } else {
          if (!options.getMaterial || textCalls >= TEXT_HELPER_BUDGET) return finishCode('handoff', 'unsupported_action', '缺少字段资料或已用完字段生成预算');
          textCalls++;
          const generated = await options.getMaterial(options.goal, control, options.signal);
          active();

          if (generated.kind === 'missing') return finishCode('handoff', 'unsupported_action', generated.reason);
          const refreshed = await observe({});

          if (!refreshed || (refreshed.controlsTruncated && !refreshed.controls.length)) return finishCode('handoff', 'observation_incomplete', '字段资料已准备，但新观察不完整，未写入');
          const changed = browserContextChange(page, refreshed, control.ref);
          page = refreshed;
          track(refreshed);

          if (changed) {
            if (++stale > 2) return finishCode('handoff', 'stale_observation', '生成期间页面持续变化，未写入');
            continue;
          }

          value = generated.material.value;
          hostMaterials.push({ ...generated.material, id: `prepared-${textCalls}-${control.ref}` });
        }

        const target = clickOption ? { ...control, ref: clickOption } : control;
        const operation = clickOption ? 'click' : 'fill';

        if (!allowed(operation)) return finishCode('handoff', 'unsupported_action', `${operation} 工具当前不可用`);

        if (!clickOption && value === control.value) {
          markControl(acted, control);
          actionsDone.push(`${nameControl(control)} already contains the requested text; nothing was typed.`);
          continue;
        }

        const reported: BrowserOperation = act.kind === 'select' ? 'select' : 'fill';
        const done = await execute(operation, target, clickOption ? {} : { value }, reported);

        if ('stop' in done) return done.stop;

        if ('retry' in done) { page = undefined; continue; }

        if ((done.result as { held?: boolean } | undefined)?.held) {
          note({ toolCallId: done.toolCallId, observationId: page.id, candidateId: control.ref, operation: reported, executionFact: 'not_executed', verification: 'unverified', detail: '等待现有权限/用户确认，未执行' });

          return finishCode('handoff', 'permission_required', '当前动作等待用户确认');
        }

        try {
          const element = await call('read_element', { tabId: page.tabId, target: control.ref }) as { tagName?: string };
          const property = element.tagName?.toLowerCase() === 'select' ? 'displayValue' : 'value';
          const verificationToolCallId = nextCallId();
          const verified = await call('read_element', { tabId: page.tabId, target: control.ref, expect: { property, equals: value } }, verificationToolCallId) as { check?: { matched?: boolean } };

          if (verified.check?.matched !== true) throw new Error('字段读回与目标值不一致');
          note({ toolCallId: done.toolCallId, observationId: page.id, candidateId: control.ref, operation: reported, executionFact: 'executed', verification: 'verified', verificationToolCallId, detail: `${describeControl(control)}：本次字段值读回一致` });
        } catch {
          note({ toolCallId: done.toolCallId, observationId: page.id, candidateId: control.ref, operation: reported, executionFact: 'executed', verification: 'unverified', detail: '字段已写入但读回未通过' });

          if (options.signal.aborted) return finish('cancelled', '任务已取消');

          return finishCode('handoff', 'execution_unknown', '写入后的核验失败，不自动重复填写');
        }

        markControl(acted, control);
        actionsDone.push(act.kind === 'select'
          ? `Chose "${value}" in ${nameControl(control)}; the field reads back "${value}".`
          : `Typed "${value.length > 120 ? `${value.slice(0, 119)}…` : value}" into ${nameControl(control)}; the field reads it back.`);
        lastSearchFill = control.role === 'searchbox' || control.role === 'combobox' ? control : undefined;
        const after = await reobserve(page);

        if (!after) return finishCode('handoff', 'observation_incomplete', '动作已发生，但没有取得可靠的新观察');
        page = after;
        track(after);
        fromRead = false;
        stale = 0;
        continue;
      }

      // Nothing to act on in this view. A search box just filled is submitted with Enter once (code rule).
      if (lastSearchFill && allowed('press_key')) {
        const field = page.controls.find(c => controlKey(c) === controlKey(lastSearchFill!)) ?? lastSearchFill;
        lastSearchFill = undefined;
        const done = await execute('press_key', field, { key: 'Enter' });

        if ('stop' in done) return done.stop;

        if ('retry' in done) { page = undefined; continue; }

        note({ toolCallId: done.toolCallId, observationId: page.id, candidateId: field.ref, operation: 'press_key', executionFact: 'executed', verification: 'unverified', detail: `${describeControl(field)}：已按回车` });
        actionsDone.push(`Pressed Enter in ${nameControl(field)} to submit it.`);
        const after = await observe({});

        if (!after) return finishCode('handoff', 'observation_incomplete', '动作已发生，但没有取得可靠的新观察');
        page = after;
        track(after);
        fromRead = false;
        continue;
      }

      // Not in this view: read the next unread window — cursor pages first, then the most likely part.
      const order = verdict?.kind === 'read' ? verdict.order : [];
      const preferred = order.find(id => !checkedKeys.has(observationCheckKey('scope', id)) && id !== page!.viewScopeId);
      let params: Record<string, unknown> | undefined;

      if (page.hasMore && page.nextCursor && !checkedKeys.has(observationCheckKey('cursor', page.nextCursor))) {
        checkedKeys.add(observationCheckKey('cursor', page.nextCursor));
        params = { cursor: page.nextCursor, ...(page.viewScopeId ? { viewScopeId: page.viewScopeId } : {}) };
      } else if (preferred) {
        checkedKeys.add(observationCheckKey('scope', preferred));
        params = { viewScopeId: preferred };
      } else {
        const expansion = nextObservationExpansion(page, checkedKeys);

        if (expansion) {
          checkedKeys.add(expansion.checkKey);
          params = expansion.params;
        }
      }

      if (!params) return finishCode('handoff', 'no_match', actionsDone.length ? '已读完全部范围，没有找到下一步要操作的控件，完成判断未过门槛' : '已读完全部范围，未找到用户要的控件');
      const next = await observe(params);

      if (!next) return finishCode('handoff', 'observation_incomplete', '续读未返回带身份的结构化观察');
      page = next;
      track(next);
      fromRead = true;
    }

    return finishCode('handoff', 'candidate_budget', '动作预算已用完');
  } catch (e) {
    if (options.signal.aborted) return finish('cancelled', e instanceof Error ? e.message : '任务已取消');

    if (e instanceof BudgetSpent) return finishCode('handoff', 'candidate_budget', `已达到 ${DECISION_CALL_BUDGET} 次决策调用预算`);

    if (e instanceof InvalidAnswer) return finishCode('handoff', 'invalid_decision', e.message);
    const message = e instanceof Error ? e.message : '决策服务不可用';

    if (message.includes('任务循环时长预算已用完')) return finishCode('handoff', 'candidate_budget', message);

    if (message.includes('候选资料超过当前决策预算')) return finishCode('handoff', 'candidate_budget', message);

    return finishCode('handoff', 'provider_error', message);
  }
}

class BudgetSpent extends Error {}
