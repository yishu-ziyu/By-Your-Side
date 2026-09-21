// Regression for docs/evals/20260921-1441-log-review.md §3: outcome=partial delivered text that
// claimed "页面已圈好" while two condition goals were still pending. verifyPartialDelivery
// (session.ts) plus the delivery review stage (goal-evidence-judge.ts) must catch this before
// send_user_message emits anything. reviewTaskGoal is the one external dependency of
// BrowserAgentSession.goalToolHost().review, so it is stubbed here; goal-evidence-judge-state.test.ts
// separately covers the real goalReviewState('delivery', ...) projection.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentSession } from '../src/session.js';
import { createSendUserMessageTool, deliveryMetrics, resetDeliveryMetrics } from '../src/user-delivery.js';
import { reviewTaskGoal } from '../src/goal-reasoning-review.js';
import type { AgentUiEvent } from '../../shared/protocol.js';
import type { TaskGoal, TaskGoalPlan } from '../../shared/task-goals.js';
import type { TaskNextStep } from '../../shared/task-next-step.js';

vi.mock('../src/run-trace.js', () => ({ RunTrace: class {
  begin() {} correlate() {} record() {} event() {} stage() { return { end() {} }; }
} }));
vi.mock('../src/goal-reasoning-review.js', () => ({ reviewTaskGoal: vi.fn() }));

const reviewMock = vi.mocked(reviewTaskGoal);
const Session = BrowserAgentSession as unknown as new (...args: any[]) => BrowserAgentSession;

const REQUIREMENT = '在这篇文章中圈出关键词，并圈出词频最高的词。';

// Mirrors ~/.sideagent/traces/1789972957328-...jsonl lines 156-157: one pending material goal
// (internal source capture) and two pending condition goals (keywords, top word).
function accidentPlan(): TaskGoalPlan {
  const goals: TaskGoal[] = [
    { id: 'article-source', description: '取得文章正文原文，作为词频统计与关键词标注的唯一来源', criterion: '用 capture_page_material 按本次页面观察的片段范围保存完整正文原文', requirements: ['requirement-1'], kind: 'material', materialId: 'article-body', status: 'pending' },
    { id: 'keywords-marked', description: '在页面上圈出文章的关键词', criterion: '页面正文中对每个选定关键词的实际出现位置都有可见标注', requirements: ['requirement-1'], kind: 'condition', status: 'pending' },
    { id: 'top-word-marked', description: '统计全文词频并圈出词频最高的词', criterion: '基于正文原文统计出词频最高的词及其次数，并在页面正文中圈出该词的实际出现位置', requirements: ['requirement-1'], kind: 'condition', status: 'pending', reason: '尚未确认当前页面对象满足这项目标' },
  ];
  return { revision: 'rev-1', coverage: 'verified', goals };
}

function satisfiedPlan(): TaskGoalPlan {
  return { ...accidentPlan(), goals: accidentPlan().goals.map(goal => ({ ...goal, status: 'satisfied', evidence: { observationId: 'obs-done', tabId: 1, verifiedAt: 100 } })) };
}

/** Real BrowserAgentSession + real goalToolHost(); only the network-calling reviewTaskGoal is stubbed. */
function sessionFixture(goalPlan: TaskGoalPlan) {
  const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const raw = { sessionManager: {
    getBranch: () => branch,
    appendCustomEntry: (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data }); return null; },
  } };
  const callbacks = { emit: vi.fn(), setStatus: vi.fn() };
  const session = new Session(raw, null, callbacks, null, null);
  const snapshot: any = {
    conversationId: 'default', observedAt: 100, state: 'idle', goal: REQUIREMENT, startedAt: 100, runId: 'run-1',
    active: [], lastAction: null, successVerified: false,
    recoveryInput: { requirements: [REQUIREMENT] },
    results: [], goalPlan,
  };
  session.bindConversationContext(() => snapshot);
  session.bindTaskResults({ getSnapshot: () => snapshot, goals: {} as any, register: () => {}, verify: () => ({ ok: true }) });
  return { session, callbacks };
}

function deliveryTool(session: BrowserAgentSession, next: TaskNextStep, getDeliveryFacts?: () => any) {
  const events: AgentUiEvent[] = [];
  const tool = createSendUserMessageTool({
    conversationId: 'default',
    getRunId: () => 'run-1',
    emit: e => events.push(e),
    getNextStep: () => next,
    getDeliveryFacts,
    verifyPartial: (text, signal) => (session as any).verifyPartialDelivery(text, signal),
  });
  return { tool, events };
}

const partialNext = (goals: TaskGoal[]): TaskNextStep => ({ action: 'continue', reason: 'remaining', allowWrites: true, delivery: 'partial', resultIds: goals.map(g => g.id) });

const TRACE_182_TEXT = '**页面已圈好**（[What is a Harness? | Earendil](https://earendil.com/posts/what-is-a-harness/)）\n\n- 关键词（黄底高亮，每类第一次出现处另有带标签的圈注）：agent 21 处、tools 24 处、AI model 18 处、system prompt 6 处、translation layer 6 处、agentic loop 5 处。\n- 词频最高的词：**harness** — 红底红框标出全部出现处（harness 40 处，含 harnesses 共 56 处），首处圈注为「词频最高的词 harness ×56」。全文共 1724 个词；若不排除 the/and 这类虚词，出现最多的是 the（97 次），所以标的是排除虚词后的最高频实义词。\n- 复读确认：首个圈注位置上的文本确实是 "Harness"，agentic loop 首处同样可见。\n\n两件没做完的事：\n1. 想把这篇正文整篇另存为一份内部来源材料（仅供留档），没成功——正文约 8.2k 字符，超过单份原文的保存上限，全文范围连续试了几次都被拒；这不影响页面上的标注。\n2. 最后一次读取页面状态的探针（只读，没有改动页面）因标签页当时被开发者工具占用而没返回结果，我没有重放。需要我再确认一次页面现状的话说一声。';

beforeEach(() => {
  reviewMock.mockReset();
  resetDeliveryMetrics();
});

describe('outcome=partial overclaim gate (docs/evals/20260921-1441-log-review.md §3)', () => {
  it('rejects the exact accident text: Jev flags an overclaim, error names both pending condition goals, nothing is delivered', async () => {
    const plan = accidentPlan();
    const { session } = sessionFixture(plan);
    reviewMock.mockResolvedValue({ matched: true, probability: 0.9, reason: '正文把尚未核验的目标说成已完成', reviewedBy: 'jev' });
    const { tool, events } = deliveryTool(session, partialNext(plan.goals));
    await expect(tool.execute('call-1', { kind: 'finding', outcome: 'partial', content: TRACE_182_TEXT }, undefined, undefined, {} as any))
      .rejects.toThrow(/在页面上圈出文章的关键词/);
    await expect(tool.execute('call-2', { kind: 'finding', outcome: 'partial', content: TRACE_182_TEXT }, undefined, undefined, {} as any))
      .rejects.toThrow(/统计全文词频并圈出词频最高的词/);
    expect(events).toHaveLength(0);
    expect(deliveryMetrics.toolRejected).toBe(2);
  });

  it('lets an honest partial report through: attempted-but-unconfirmed wording is not an overclaim', async () => {
    const plan = accidentPlan();
    const { session } = sessionFixture(plan);
    reviewMock.mockResolvedValue({ matched: false, probability: 0.05, reason: '正文已把满足证据的目标与尚未核验的目标分开表述', reviewedBy: 'jev' });
    const honestText = '已在页面上执行高亮与圈注脚本，读回 136 个高亮节点；圈注是否覆盖全部关键词尚未核验。';
    const { tool, events } = deliveryTool(session, partialNext(plan.goals), () => ({
      delivered: ['已执行高亮与圈注脚本'],
      remaining: plan.goals.map(g => ({ id: g.id, description: g.description, status: 'pending' as const })),
      sources: [],
    }));
    const result = await tool.execute('call-1', { kind: 'finding', outcome: 'partial', content: honestText }, undefined, undefined, {} as any);
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^delivered:/) });
    expect(events).toHaveLength(1);
    const delivery = (events[0] as any).delivery;
    expect(delivery.text).toContain(honestText);
    expect(delivery.text).toContain('仅交付部分结果');
    expect(delivery.facts.outcome).toBe('partial');
  });

  it('skips the delivery review entirely when no goal is still pending', async () => {
    const plan = satisfiedPlan();
    const { session } = sessionFixture(plan);
    // An unrelated partial reason (e.g. an unresolved effect elsewhere) with every goal satisfied.
    const next: TaskNextStep = { action: 'ask_user', reason: 'unknown_without_baseline', allowWrites: false, delivery: 'partial', resultIds: [] };
    const { tool, events } = deliveryTool(session, next);
    const result = await tool.execute('call-1', { kind: 'finding', outcome: 'partial', content: '写入操作已执行，但这次的结果暂时无法确认，正在等待你决定是否重试。' }, undefined, undefined, {} as any);
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^delivered:/) });
    expect(events).toHaveLength(1);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it('outcome=complete still only runs verifyAnswer; verifyPartial is never called', async () => {
    const verifyAnswer = vi.fn(async () => {});
    const verifyPartial = vi.fn(async () => {});
    const next: TaskNextStep = { action: 'deliver', reason: 'receipts_reviewed', allowWrites: true, delivery: 'report', resultIds: [] };
    const events: AgentUiEvent[] = [];
    const tool = createSendUserMessageTool({ conversationId: 'default', getRunId: () => 'run-1', emit: e => events.push(e), getNextStep: () => next, verifyAnswer, verifyPartial });
    await tool.execute('call-1', { kind: 'finding', outcome: 'complete', content: '词频最高的词是 harness，已在页面圈出并读回确认。' }, undefined, undefined, {} as any);
    expect(verifyAnswer).toHaveBeenCalledTimes(1);
    expect(verifyPartial).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('rejects the partial delivery when the delivery review call fails (Jev unavailable), with a readable error', async () => {
    const plan = accidentPlan();
    const { session } = sessionFixture(plan);
    reviewMock.mockRejectedValue(new Error('Jev 核验未完成（HTTP 500）'));
    const { tool, events } = deliveryTool(session, partialNext(plan.goals));
    await expect(tool.execute('call-1', { kind: 'finding', outcome: 'partial', content: '已执行圈注脚本，覆盖范围尚未核验。' }, undefined, undefined, {} as any))
      .rejects.toThrow('Jev 核验未完成');
    expect(events).toHaveLength(0);
    expect(deliveryMetrics.toolRejected).toBe(1);
  });
});
