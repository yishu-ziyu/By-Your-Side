import { browserCandidates, isBrowserObservation, type BrowserMaterial, type BrowserObservation, type BrowserLoopOutcome, type BrowserStepReceipt, type BrowserActionGuard } from '../../shared/browser-decision.js';
import type { ToolName, ToolExecutionFact } from '../../shared/protocol.js';
import { decideBrowserCandidate, type BrowserDecisionInput } from './browser-decision-model.js';
import type { BrowserDecision, BrowserControl } from '../../shared/browser-decision.js';
import { browserContextChange } from '../../shared/browser-decision-context.js';
import type { BrowserMaterialResult } from './browser-material.js';

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
}
/** Bounded general action loop. DONE never marks the task complete: the caller must verify. */
export async function runBrowserDecisionLoop(options: BrowserLoopOptions): Promise<BrowserLoopOutcome> {
  const receipts: BrowserStepReceipt[] = [];
  const history: string[] = [];
  const materials = options.materials.map(m => ({ ...m }));
  let textCalls = 0;
  let page: BrowserObservation | undefined;
  let modelCalls = 0;
  let stale = 0;
  let noProgress = 0;
  let waits = 0;
  let seq = 0;
  const decisions: BrowserLoopOutcome['decisions'] = [];
  const start = Date.now();
  const finish = (status: BrowserLoopOutcome['status'], reason: string): BrowserLoopOutcome => ({ status, reason, receipts, lastObservation: page, modelCalls, decisions });
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
          return finish('handoff', '浏览器未返回带身份的结构化观察');
        }
        page = next;
      }
      if ((page.controlsTruncated ?? page.truncated) && !page.tabs?.length) {
        return finish('handoff', '控件观察被截断，不能把缺失候选当成全部页面');
      }
      const candidates = browserCandidates(page, materials, !!options.getMaterial);
      if (candidates.length > 256) {
        return finish('handoff', '当前候选过多，需要任务模型缩小目标范围');
      }
      if (modelCalls >= 16) {
        return finish('handoff', '已达到 16 次决策调用预算');
      }
      active();
      options.reserveDecision?.();
      modelCalls++;
      const decidedAt = Date.now();
      const decision = await (options.decide ?? decideBrowserCandidate)({ goal: options.goal, page, candidates, materials, history }, options.signal);
      decisions.push({ ...decision, elapsedMs: Date.now() - decidedAt });
      active();
      if (decision.observationId !== page.id) {
        return finish('handoff', '决策属于旧观察，未执行');
      }
      const candidate = candidates.find(c => c.id === decision.candidateId);
      if (!candidate || !Number.isFinite(decision.confidence) || decision.confidence < .85 || decision.confidence > 1) {
        return finish('handoff', '没有可靠的当前候选，交回任务模型');
      }
      if (candidate.operation === 'done') {
        return finish('needs_verification', '决策模型建议完成；必须根据新观察独立核对用户全部要求，不能直接报完成');
      }
      if (candidate.operation === 'handoff') {
        return finish('handoff', '当前步骤需要补充材料、能力或开放式推理');
      }
      if (candidate.operation === 'wait' || candidate.operation === 'reobserve') {
        if (++waits > 2) {
          return finish('handoff', '连续等待/重读没有取得进展');
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
          return finish('handoff', '目标标签页不在当前观察中');
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
          return finish(options.signal.aborted ? 'cancelled' : 'handoff', '标签切换未核验，保留回执并交回任务模型');
        }
        // The common next observation lets a mixed goal continue on the chosen tab.
        page = undefined;
        stale = 0;
        noProgress = 0;
        waits = 0;
        continue;
      }
      let fillValue: string | undefined = candidate.optionLabel ?? materials.find(m => m.id === candidate.valueId)?.value;
      if (candidate.operation === 'fill' && fillValue === undefined) {
        const control = page.controls.find(c => c.ref === candidate.target);
        if (!control || !options.getMaterial || textCalls >= 8) {
          return finish('handoff', '缺少字段资料或已用完字段生成预算');
        }
        textCalls++;
        const generated = await options.getMaterial(options.goal, control, options.signal);
        active();
        if (generated.kind === 'missing') {
          return finish('handoff', generated.reason);
        }
        const afterRaw = await call('snapshot', { decision: true });
        const refreshed = (afterRaw as {
          observation?: unknown;
        })?.observation;
        if (!isBrowserObservation(refreshed) || (refreshed.controlsTruncated ?? refreshed.truncated)) {
          return finish('handoff', '字段资料已准备，但新观察不完整，未写入');
        }
        const changed = browserContextChange(page, refreshed, candidate.target);
        page = refreshed;
        if (changed) {
          history.push(`Prepared field text was not written: ${changed}`);
          if (++stale > 2) {
            return finish('handoff', '生成期间页面持续变化，未写入');
          }
          continue;
        }
        fillValue = generated.material.value;
        materials.push({ ...generated.material, id: `prepared-${textCalls}-${control.ref}` });
        if (fillValue === control.value) {
          history.push(`Field ${control.name} already has the requested value; no write performed`);
          if (++noProgress >= 2) {
            return finish('handoff', '字段已经满足但没有其他可执行进展');
          }
          continue;
        }
      }
      let operation: 'click' | 'fill' | 'press_key' | 'scroll' = candidate.operation === 'select' ? 'fill' : candidate.operation;
      let actionTarget = candidate.target;
      if (candidate.operation === 'select') {
        const element = await call('read_element', { tabId: page.tabId, target: candidate.target }) as {
          tagName?: string;
        };
        if (element.tagName?.toLowerCase() !== 'select') {
          if (!candidate.optionRef || !page.controls.some(c => c.ref === candidate.optionRef && !c.disabled)) {
            return finish('handoff', '选项没有可执行的当前对象引用');
          }
          operation = 'click';
          actionTarget = candidate.optionRef;
        }
      }
      const guard: BrowserActionGuard = { observationId: page.id, operation, ...(actionTarget ? { target: actionTarget } : {}) };
      const params: Record<string, unknown> = { tabId: page.tabId, decisionGuard: guard, ...(actionTarget ? { target: actionTarget } : {}), ...(candidate.key ? { key: candidate.key } : {}), ...(candidate.dy ? { dy: candidate.dy } : {}) };
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
        return finish(options.signal.aborted ? 'cancelled' : 'handoff', '动作失败或结果未知，已停止；核对真实状态后再规划，不重放写入');
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
        return finish('handoff', '当前动作等待用户确认');
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
          return finish(options.signal.aborted ? 'cancelled' : 'handoff', '写入后的核验失败，不自动重复填写');
        }
      }
      note(receipt);
      // Capture after every mutation. A changed page is progress evidence, never success evidence.
      const afterRaw = await call('snapshot', { decision: true });
      const after = (afterRaw as {
        observation?: unknown;
      })?.observation;
      if (!isBrowserObservation(after)) {
        return finish('handoff', '动作已发生，但没有取得可靠的新观察');
      }
      progress ||= after.url !== page.url || JSON.stringify(after.controls) !== JSON.stringify(page.controls);
      if (candidate.operation === 'scroll') {
        progress ||= !!after.viewport && !!page.viewport && (after.viewport.x !== page.viewport.x || after.viewport.y !== page.viewport.y);
      }
      noProgress = progress ? 0 : noProgress + 1;
      page = after;
      if (noProgress >= 2) {
        return finish('handoff', '连续两次动作没有可核对的进展');
      }
    }
    return finish('handoff', '动作预算已用完');
  }
  catch (e) {
    return finish(options.signal.aborted ? 'cancelled' : 'handoff', e instanceof Error ? e.message : '决策服务不可用');
  }
}
