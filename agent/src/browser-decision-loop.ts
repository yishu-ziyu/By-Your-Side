import { isBrowserObservation, type BrowserMaterial, type BrowserObservation, type BrowserLoopOutcome, type BrowserStepReceipt, type BrowserActionGuard, type BrowserDecisionReasonCode, type BrowserContinueHint } from '../../shared/browser-decision.js';
import type { ToolName, ToolExecutionFact } from '../../shared/protocol.js';
import { decideBrowserCandidate, type BrowserDecisionInput } from './browser-decision-model.js';
import type { BrowserDecision, BrowserControl } from '../../shared/browser-decision.js';
import { browserContextChange } from '../../shared/browser-decision-context.js';
import type { BrowserMaterialResult } from './browser-material.js';
import {
  checkedRangeFromKeys,
  humanReasonForCode,
  materialWindowKey,
  nextObservationExpansion,
  nextMaterialWindow,
  observationCheckKey,
  piContinueHint,
  resolveBrowserDecision,
  selectBrowserActionCandidates,
  type BrowserToolGate,
  type ObservationCheckKey,
} from './browser-action-selection.js';

export interface BrowserLoopOptions {
  /** Actual host tool call ID; child IDs are shared with RPC and step events. */
  parentCallId: string;
  goal: string;
  materials: BrowserMaterial[];
  signal: AbortSignal;
  call: (name: ToolName, params: Record<string, unknown>, toolCallId: string) => Promise<unknown>;
  decide?: (input: BrowserDecisionInput, signal: AbortSignal) => Promise<BrowserDecision>;
  reserveDecision?: () => void;
  getMaterial?: (goal: string, control: BrowserControl, signal: AbortSignal) => Promise<BrowserMaterialResult>;
  onStep?: (receipt: BrowserStepReceipt) => void;
  /** Model-visible tool gate (canExecute / isToolActive). Hidden tools are a separate concern. */
  canExecute?: BrowserToolGate;
}

/** Bounded general action loop. DONE never marks the task complete: the caller must verify. */
export async function runBrowserDecisionLoop(options: BrowserLoopOptions): Promise<BrowserLoopOutcome> {
  const receipts: BrowserStepReceipt[] = [];
  const history: string[] = [];
  /** Host keeps full original materials; decision windows never replace these values. */
  const hostMaterials = options.materials.map(m => ({ ...m }));
  let focusedMaterialIds: string[] | undefined;
  /** Material windows this task already inspected; a window is never re-offered as fresh progress. */
  const checkedMaterialWindows = new Set<string>();
  /** True while the loop — not the model — is choosing which material window to read next. */
  let materialWindowSearch = false;
  let textCalls = 0;
  let page: BrowserObservation | undefined;
  let modelCalls = 0;
  let stale = 0;
  let noProgress = 0;
  let waits = 0;
  let seq = 0;
  const decisions: BrowserLoopOutcome['decisions'] = [];
  const checkedKeys = new Set<ObservationCheckKey>();
  const seenObservationIds: string[] = [];
  const start = Date.now();
  const hasUnknown = () => receipts.some(r => r.executionFact === 'unknown');

  const range = (): NonNullable<BrowserContinueHint['checkedRange']> =>
    checkedRangeFromKeys(checkedKeys, seenObservationIds);

  const finish = (
    status: BrowserLoopOutcome['status'],
    reason: string,
    reasonCode?: BrowserDecisionReasonCode,
    cont?: BrowserContinueHint,
  ): BrowserLoopOutcome => {
    const outcome: BrowserLoopOutcome = {
    status,
    reason,
    receipts,
    lastObservation: page,
    modelCalls,
    decisions,
    };

    if (reasonCode) outcome.reasonCode = reasonCode;

    if (cont) outcome.continue = cont;
    else if (reasonCode) outcome.continue = piContinueHint(reasonCode, range(), hasUnknown());
    else if (seenObservationIds.length) outcome.continue = { action: 'session_prompt', checkedRange: range(), preserveFacts: hasUnknown() };

    return outcome;
  };

  const finishCode = (status: BrowserLoopOutcome['status'], reasonCode: BrowserDecisionReasonCode, reason = humanReasonForCode(reasonCode)) =>
    finish(status, reason, reasonCode);

  const active = () => {
    if (options.signal.aborted) {
      throw new Error('调用已取消');
    }

    if (Date.now() - start > 90000) {
      throw new Error('任务循环时长预算已用完');
    }
  };

  const nextCallId = () => `${options.parentCallId}/decision-${++seq}`;

  const call = async (name: ToolName, params: Record<string, unknown>, toolCallId = nextCallId()) => {
    active();

    return options.call(name, params, toolCallId);
  };

  const note = (r: BrowserStepReceipt) => {
    receipts.push(r);
    // Preserve the decision model's history text while receipts use separate facts.
    const historyLabel = r.executionFact === 'executed' ? (r.verification === 'verified' ? 'verified' : 'executed_unverified') : r.executionFact;
    history.push(`${r.operation}: ${r.detail} [${historyLabel}]`);
    options.onStep?.(r);
  };

  /**
   * Register an observation for identity/continue bookkeeping. Deliberately does not assign `page`:
   * `page` is only assigned in this function body so control-flow narrowing stays valid.
   */
  const trackObservation = (next: BrowserObservation) => {
    if (!seenObservationIds.includes(next.id)) seenObservationIds.push(next.id);
    checkedKeys.add(observationCheckKey('observation', next.id));
  };

  /** Host-owned view label for history, so the model sees which range it is looking at. */
  const viewLabel = (next: BrowserObservation) => `"${next.viewScopeLabel ?? 'current view'}" (${next.visibleCount ?? next.controls.length} controls)`;

  /**
   * Read the next unread observation window without inventing a miss.
   * Returns the new observation; the caller records how the range was searched.
   */
  const expandObservation = async (): Promise<BrowserObservation | undefined> => {
    if (!page) return undefined;
    const expansion = nextObservationExpansion(page, checkedKeys);

    if (!expansion) return undefined;
    checkedKeys.add(expansion.checkKey);
    const raw = await call('snapshot', { decision: true, ...expansion.params });
    const next = (raw as { observation?: unknown })?.observation;

    return isBrowserObservation(next) ? next : undefined;
  };

  /**
   * Read the next uninspected material window, in supplied order. Windows are host-owned ranges, so
   * walking them continues the same search under the same budget instead of guessing or repeating.
   * Never executes anything: the model still answers every window request.
   */
  const advanceMaterialWindow = (): boolean => {
    const next = nextMaterialWindow(hostMaterials, checkedMaterialWindows);

    if (!next) return false;
    checkedMaterialWindows.add(materialWindowKey(next));
    focusedMaterialIds = [...next];
    materialWindowSearch = true;
    history.push(`Checked material window ${next.join('+')}: no candidate satisfied the goal.`);

    return true;
  };

  if (!options.goal.trim() || options.goal.length > 12000 || options.materials.length > 12 || new Set(options.materials.map(m => m.id)).size !== options.materials.length || options.materials.some(m => !m.id || typeof m.value !== 'string' || m.value.length > 8000 || !['user', 'generated', 'observed'].includes(m.source))) {
    return finish('blocked', '目标或材料超出支持边界');
  }

  try {
    for (let step = 0; step < 24; step++) {
      active();

      if (!page) {
        const raw = await call('snapshot', { decision: true });

        const next = (raw as {
          observation?: unknown;
        })?.observation;

        if (!isBrowserObservation(next)) {
          return finishCode('handoff', 'observation_incomplete', '浏览器未返回带身份的结构化观察');
        }

        page = next;
        trackObservation(next);
      }

      // Legacy conflated truncated (no split flags) still hand off. Prose-only clip and
      // view pagination (hasMore) must not erase a usable control/tab window.
      const legacyConflated = page.truncated && page.textTruncated === undefined && page.controlsTruncated === undefined;

      if ((legacyConflated || page.controlsTruncated) && !page.controls.length && !page.tabs?.length) {
        const expanded = await expandObservation();

        if (expanded) {
          history.push(`Read observation window ${viewLabel(expanded)} because the control view was truncated.`);
          page = expanded;
          trackObservation(expanded);
          waits = 0;
          continue;
        }

        return finishCode('handoff', 'observation_incomplete', '控件观察被截断，不能把缺失候选当成全部页面');
      }

      if (legacyConflated && !page.tabs?.length) {
        const expanded = await expandObservation();

        if (expanded) {
          history.push(`Read observation window ${viewLabel(expanded)} because the control view was truncated.`);
          page = expanded;
          trackObservation(expanded);
          waits = 0;
          continue;
        }

        return finishCode('handoff', 'observation_incomplete', '控件观察被截断，不能把缺失候选当成全部页面');
      }

      const selection = selectBrowserActionCandidates({
        goal: options.goal,
        page,
        materials: hostMaterials,
        history,
        canGenerateText: !!options.getMaterial,
        canExecute: options.canExecute,
        focusedMaterialIds,
        checkedRanges: checkedKeys,
        checkedMaterialWindows,
        materialWindowSearch,
        // Unread ranges of this task are read before any other browser tab is considered.
        searchInProgress: !!nextObservationExpansion(page, checkedKeys)
          || !!nextMaterialWindow(hostMaterials, checkedMaterialWindows)
          || !!focusedMaterialIds,
      });

      const candidates = selection.candidates;
      const decisionMaterials = selection.decisionMaterials;

      if (modelCalls >= 16) {
        return finishCode('handoff', 'candidate_budget', '已达到 16 次决策调用预算');
      }

      active();
      options.reserveDecision?.();
      modelCalls++;
      const decidedAt = Date.now();
      let decision: BrowserDecision;

      try {
        decision = await (options.decide ?? decideBrowserCandidate)({ goal: options.goal, page, candidates, materials: decisionMaterials, history }, options.signal);
      } catch (e) {
        if (options.signal.aborted) throw e;
        const message = e instanceof Error ? e.message : '决策服务不可用';

        // Payload budget is a local constraint, not a page miss.
        if (message.includes('候选资料超过当前决策预算')) {
          return finishCode('handoff', 'candidate_budget', message);
        }

        return finishCode('handoff', 'provider_error', message);
      }

      decisions.push({ ...decision, elapsedMs: Date.now() - decidedAt });
      active();
      const verdict = resolveBrowserDecision(decision, candidates, page.id);

      if (verdict.kind === 'reject') {
        // Incomplete / no local match: read unobserved windows before claiming absence. A model-named
        // material window is read next even when the naming decision itself was under-confident — it
        // chooses the range, never an action. Stale/invalid decisions never execute or retry here.
        if (verdict.reasonCode === 'no_match' || verdict.reasonCode === 'low_confidence' || verdict.reasonCode === 'observation_incomplete') {
          const expanded = await expandObservation();

          if (expanded) {
            history.push(`Checked partition ${viewLabel(page)}: no matching target.`);
            page = expanded;
            trackObservation(expanded);
            history.push(`Read observation window ${viewLabel(expanded)}.`);
            waits = 0;
            continue;
          }

          if (advanceMaterialWindow()) continue;
        }

        return finishCode('handoff', verdict.reasonCode, verdict.reason);
      }

      const candidate = verdict.candidate;

      if (candidate.operation === 'done') {
        return finish('needs_verification', '决策模型建议完成；必须根据新观察独立核对用户全部要求，不能直接报完成');
      }

      if (candidate.operation === 'handoff') {
        const code: BrowserDecisionReasonCode = selection.bounded ? 'candidate_budget' : 'unsupported_action';

        return finishCode('handoff', code, '当前步骤需要补充材料、能力或开放式推理');
      }

      if (candidate.operation === 'select_materials') {
        if (!candidate.materialIds?.length || candidate.materialIds.some(id => !hostMaterials.some(m => m.id === id))) {
          return finishCode('handoff', 'invalid_decision', '材料窗口不在宿主材料中');
        }

        focusedMaterialIds = [...candidate.materialIds];
        checkedMaterialWindows.add(materialWindowKey(focusedMaterialIds));
        materialWindowSearch = false;
        history.push(`select_materials: focused ${focusedMaterialIds.join(',')} [prepared]`);
        continue;
      }

      if (candidate.operation === 'continue_read' || candidate.operation === 'select_scope') {
        if (candidate.cursor) checkedKeys.add(observationCheckKey('cursor', candidate.cursor));

        if (candidate.viewScopeId) checkedKeys.add(observationCheckKey('scope', candidate.viewScopeId));
        const params: Record<string, unknown> = { decision: true };

        if (candidate.cursor) params.cursor = candidate.cursor;

        if (candidate.viewScopeId) params.viewScopeId = candidate.viewScopeId;
        const raw = await call('snapshot', params);
        const next = (raw as { observation?: unknown })?.observation;

        if (!isBrowserObservation(next)) {
          return finishCode('handoff', 'observation_incomplete', '续读未返回带身份的结构化观察');
        }

        history.push(`Read observation window ${viewLabel(next)} via ${candidate.operation}.`);
        page = next;
        trackObservation(next);
        waits = 0;
        continue;
      }

      if (candidate.operation === 'wait' || candidate.operation === 'reobserve') {
        if (++waits > 2) {
          return finishCode('handoff', 'no_match', '连续等待/重读没有取得进展');
        }

        await new Promise<void>((resolve, reject) => {
          const done = () => {
            options.signal.removeEventListener('abort', abort);
            resolve();
          };

          const timer = setTimeout(done, 200);

          const abort = () => {
            clearTimeout(timer);
            reject(new Error('调用已取消'));
          };

          options.signal.addEventListener('abort', abort, { once: true });

          if (options.signal.aborted) {
            abort();
          }
        });
        page = undefined;
        continue;
      }

      if (candidate.operation === 'switch_tab') {
        const target = page.tabs?.find(t => t.id === candidate.tabId);

        if (!target) {
          return finishCode('handoff', 'no_match', '目标标签页不在当前观察中');
        }

        const toolCallId = nextCallId();
        let executed = false;

        try {
          await call('switch_tab', { tabId: target.id, decisionGuard: { observationId: page.id, operation: 'switch_tab', sourceTabId: page.tabId } }, toolCallId);
          executed = true;
          active();
          const verificationToolCallId = nextCallId();

          const actual = await call('get_active_tab', {}, verificationToolCallId) as {
            tab?: {
              id: number;
              url: string;
              title: string;
            } | null;
          };

          active();

          if (actual.tab?.id !== target.id || actual.tab.url !== target.url || actual.tab.title !== target.title) {
            throw new Error('当前活动标签页与目标不一致');
          }

          note({ toolCallId, observationId: page.id, candidateId: candidate.id, operation: 'switch_tab', executionFact: 'executed', verification: 'verified', verificationToolCallId, detail: `已切到「${target.title}」，活动标签页与原观察一致；完整任务仍需核验` });
        }
        catch (e) {
          const error = e as Error & {
            executionFact?: string;
          };

          let executionFact: ToolExecutionFact;

          if (executed) {
            executionFact = 'executed';
          } else if (error.executionFact === 'not_executed') {
            executionFact = 'not_executed';
          } else {
            executionFact = 'unknown';
          }

          note({ toolCallId, observationId: page.id, candidateId: candidate.id, operation: 'switch_tab', executionFact, verification: 'unverified', detail: error.message });

          if (executionFact === 'not_executed' && error.message.includes('DECISION_STALE:') && ++stale <= 2) {
            page = undefined;
            continue;
          }

          if (options.signal.aborted) return finish('cancelled', '任务已取消');
          const code: BrowserDecisionReasonCode = executionFact === 'unknown' ? 'execution_unknown' : 'stale_observation';

          return finishCode('handoff', code, '标签切换未核验，保留回执并交回任务模型');
        }

        // The common next observation lets a mixed goal continue on the chosen tab.
        page = undefined;
        stale = 0;
        noProgress = 0;
        waits = 0;
        continue;
      }

      if (candidate.operation === 'hover') {
        if (!candidate.target) {
          return finishCode('handoff', 'invalid_decision', '悬停目标不在当前观察中');
        }

        const guard: BrowserActionGuard = { observationId: page.id, operation: 'hover', target: candidate.target };
        const toolCallId = nextCallId();

        try {
          await call('hover', { tabId: page.tabId, target: candidate.target, decisionGuard: guard }, toolCallId);
        }
        catch (e) {
          const error = e as Error & { executionFact?: string };
          note({ toolCallId, observationId: page.id, candidateId: candidate.id, operation: 'hover', executionFact: error.executionFact === 'not_executed' ? 'not_executed' : 'unknown', verification: 'unverified', detail: error.message });

          if (error.executionFact === 'not_executed' && error.message.includes('DECISION_STALE:') && ++stale <= 2) {
            page = undefined;
            continue;
          }

          if (options.signal.aborted) return finish('cancelled', '任务已取消');
          const code: BrowserDecisionReasonCode = error.executionFact === 'not_executed' ? 'stale_observation' : 'execution_unknown';

          return finishCode('handoff', code, '悬停失败或结果未知，已停止');
        }

        note({ toolCallId, observationId: page.id, candidateId: candidate.id, operation: 'hover', executionFact: 'executed', verification: 'unverified', detail: `${candidate.label}：已悬停，必须用新观察再选点击目标；不代表任务完成` });
        // Force a fresh observation so revealed controls can enter the next candidate set.
        const afterRaw = await call('snapshot', { decision: true });
        const after = (afterRaw as { observation?: unknown })?.observation;

        if (!isBrowserObservation(after)) {
          return finishCode('handoff', 'observation_incomplete', '悬停后没有取得可靠的新观察');
        }

        page = after;
        trackObservation(after);
        stale = 0;
        waits = 0;
        noProgress = 0;
        continue;
      }

      let fillValue: string | undefined = candidate.optionLabel ?? hostMaterials.find(m => m.id === candidate.valueId)?.value;

      if (candidate.operation === 'fill' && fillValue === undefined) {
        const control = page.controls.find(c => c.ref === candidate.target);

        if (!control || !options.getMaterial || textCalls >= 8) {
          return finishCode('handoff', 'unsupported_action', '缺少字段资料或已用完字段生成预算');
        }

        textCalls++;
        const generated = await options.getMaterial(options.goal, control, options.signal);
        active();

        if (generated.kind === 'missing') {
          return finishCode('handoff', 'unsupported_action', generated.reason);
        }

        const afterRaw = await call('snapshot', { decision: true });

        const refreshed = (afterRaw as {
          observation?: unknown;
        })?.observation;

        if (!isBrowserObservation(refreshed) || (refreshed.controlsTruncated && !refreshed.controls.length)) {
          return finishCode('handoff', 'observation_incomplete', '字段资料已准备，但新观察不完整，未写入');
        }

        const changed = browserContextChange(page, refreshed, candidate.target);
        page = refreshed;
        trackObservation(refreshed);

        if (changed) {
          history.push(`Prepared field text was not written: ${changed}`);

          if (++stale > 2) {
            return finishCode('handoff', 'stale_observation', '生成期间页面持续变化，未写入');
          }

          continue;
        }

        fillValue = generated.material.value;
        hostMaterials.push({ ...generated.material, id: `prepared-${textCalls}-${control.ref}` });

        if (fillValue === control.value) {
          history.push(`Field ${control.name} already has the requested value; no write performed`);

          if (++noProgress >= 2) {
            return finishCode('handoff', 'no_match', '字段已经满足但没有其他可执行进展');
          }

          continue;
        }
      }

      let operation: 'click' | 'fill' | 'press_key' | 'scroll' = candidate.operation === 'select' ? 'fill' : candidate.operation as 'click' | 'fill' | 'press_key' | 'scroll';
      let actionTarget = candidate.target;

      if (candidate.operation === 'select') {
        const element = await call('read_element', { tabId: page.tabId, target: candidate.target }) as {
          tagName?: string;
        };

        if (element.tagName?.toLowerCase() !== 'select') {
          if (!candidate.optionRef || !page.controls.some(c => c.ref === candidate.optionRef && !c.disabled)) {
            return finishCode('handoff', 'no_match', '选项没有可执行的当前对象引用');
          }

          operation = 'click';
          actionTarget = candidate.optionRef;
        }
      }

      const guard: BrowserActionGuard = { observationId: page.id, operation };

      if (actionTarget) guard.target = actionTarget;
      const params: Record<string, unknown> = { tabId: page.tabId, decisionGuard: guard };

      if (actionTarget) params.target = actionTarget;

      if (candidate.key) params.key = candidate.key;

      if (candidate.dy) params.dy = candidate.dy;

      if (operation === 'fill') {
        params.value = fillValue;
      }

      const toolCallId = nextCallId();
      let result: unknown;

      try {
        result = await call(operation, params, toolCallId);
      }
      catch (e) {
        const error = e as Error & {
          executionFact?: string;
        };

        note({ toolCallId, observationId: page.id, candidateId: candidate.id, operation: candidate.operation, executionFact: error.executionFact === 'not_executed' ? 'not_executed' : 'unknown', verification: 'unverified', detail: error.message });

        if (error.executionFact === 'not_executed' && error.message.includes('DECISION_STALE:') && ++stale <= 2) {
          page = undefined;
          continue;
        }

        if (options.signal.aborted) return finish('cancelled', '任务已取消');
        const code: BrowserDecisionReasonCode = error.executionFact === 'not_executed' ? 'stale_observation' : 'execution_unknown';

        return finishCode('handoff', code, '动作失败或结果未知，已停止；核对真实状态后再规划，不重放写入');
      }

      const data = result as {
        held?: boolean;
        effect?: {
          changed?: boolean;
        };
        newTab?: unknown;
      };

      if (data?.held) {
        note({ toolCallId, observationId: page.id, candidateId: candidate.id, operation: candidate.operation, executionFact: 'not_executed', verification: 'unverified', detail: '等待现有权限/用户确认，未执行点击' });

        return finishCode('handoff', 'permission_required', '当前动作等待用户确认');
      }

      if (options.signal.aborted) {
        note({ toolCallId, observationId: page.id, candidateId: candidate.id, operation: candidate.operation, executionFact: 'executed', verification: 'unverified', detail: '执行回执到达时任务已取消；保留写入事实，不再执行后续动作' });

        return finish('cancelled', '任务已取消');
      }

      stale = 0;
      waits = 0;
      let receipt: BrowserStepReceipt = { toolCallId, observationId: page.id, candidateId: candidate.id, operation: candidate.operation, executionFact: 'executed', verification: 'unverified', detail: `${candidate.label}：已执行，最终目标尚未核验` };
      let progress = data?.effect?.changed === true;

      if (candidate.operation === 'fill' || candidate.operation === 'select') {
        try {
          const state = await call('read_element', { tabId: page.tabId, target: candidate.target }) as {
            tagName?: string;
            value?: string;
            properties?: Record<string, unknown>;
          };

          const property = state.tagName?.toLowerCase() === 'select' ? 'displayValue' : 'value';
          const expected = fillValue;
          const verificationToolCallId = nextCallId();

          const verified = await call('read_element', { tabId: page.tabId, target: candidate.target, expect: { property, equals: expected } }, verificationToolCallId) as {
            check?: {
              matched?: boolean;
            };
          };

          if (verified.check?.matched !== true) {
            throw new Error('字段读回与目标值不一致');
          }

          receipt = { ...receipt, executionFact: 'executed', verification: 'verified', verificationToolCallId, detail: `${candidate.label}：本次字段值读回一致；不代表整个任务完成` };
          progress = true;
        }
        catch (e) {
          note({ ...receipt, detail: '字段已写入但读回未通过' });

          if (options.signal.aborted) return finish('cancelled', '任务已取消');

          return finishCode('handoff', 'execution_unknown', '写入后的核验失败，不自动重复填写');
        }
      }

      note(receipt);
      // Capture after every mutation. A changed page is progress evidence, never success evidence.
      const afterRaw = await call('snapshot', { decision: true });

      const after = (afterRaw as {
        observation?: unknown;
      })?.observation;

      if (!isBrowserObservation(after)) {
        return finishCode('handoff', 'observation_incomplete', '动作已发生，但没有取得可靠的新观察');
      }

      progress ||= after.url !== page.url || JSON.stringify(after.controls) !== JSON.stringify(page.controls);

      if (candidate.operation === 'scroll') {
        progress ||= !!after.viewport && !!page.viewport && (after.viewport.x !== page.viewport.x || after.viewport.y !== page.viewport.y);
      }

      noProgress = progress ? 0 : noProgress + 1;
      page = after;
      trackObservation(after);

      if (noProgress >= 2) {
        return finishCode('handoff', 'no_match', '连续两次动作没有可核对的进展');
      }
    }

    return finishCode('handoff', 'candidate_budget', '动作预算已用完');
  }
  catch (e) {
    if (options.signal.aborted) return finish('cancelled', e instanceof Error ? e.message : '任务已取消');
    const message = e instanceof Error ? e.message : '决策服务不可用';

    if (message.includes('任务循环时长预算已用完') || message.includes('已达到')) {
      return finishCode('handoff', 'candidate_budget', message);
    }

    return finishCode('handoff', 'provider_error', message);
  }
}
