import { describe, expect, it } from 'vitest';
import { pairCallsWithEnds } from '../../scripts/acceptance/product-journeys/tool-receipts.mjs';
import { ownDeliveries, type RunEvidence } from '../../scripts/acceptance/product-journeys/oracle.mjs';

describe('任务身份与真实 wire 回执', () => {
  it('已有 runId 拒绝未绑定交付；无 run 的阅读卡片保持可用', () => {
    const evidence = { conversationId: 'c', runIds: ['current'], deliveries: [
      { conversationId: 'c', runId: null, kind: 'reply', text: '正确但未绑定' },
      { conversationId: 'c', runId: 'old', kind: 'finding', text: '旧任务' },
      { conversationId: 'c', runId: 'current', kind: 'finding', text: '本任务' },
    ] } as RunEvidence;
    expect(ownDeliveries(evidence).map(d => d.text)).toEqual(['本任务']);
    expect(ownDeliveries({ ...evidence, runIds: [], deliveries: evidence.deliveries.slice(0, 1) })).toHaveLength(1);
  });
  it('并发 fill 逆序返回按 id 配对，SDK 同名结束事件不能替代 wire 结果', () => {
    const events = [
      { at: 1, direction: 'server', message: { type: 'tool_call', conversationId: 'c', id: 'a', name: 'fill', params: { target: '#a' } } },
      { at: 2, direction: 'server', message: { type: 'tool_call', conversationId: 'c', id: 'b', name: 'fill', params: { target: '#b' } } },
      { at: 3, direction: 'client', message: { type: 'tool_result', id: 'b', ok: true, executionFact: 'executed' } },
      { at: 4, direction: 'client', message: { type: 'tool_result', id: 'a', ok: false, executionFact: 'not_executed' } },
      { at: 5, direction: 'server', message: { type: 'tool_call', conversationId: 'c', id: 'missing', name: 'fill', params: {} } },
      { at: 6, direction: 'server', message: { type: 'agent_event', conversationId: 'c', event: { kind: 'tool_end', name: 'fill', isError: false, executionFact: 'executed' } } },
    ];
    expect(pairCallsWithEnds(events, 'c')).toEqual([
      expect.objectContaining({ toolCallId: 'a', ok: false, executionFact: 'not_executed', confirmedAt: 4 }),
      expect.objectContaining({ toolCallId: 'b', ok: true, executionFact: 'executed', confirmedAt: 3 }),
      expect.not.objectContaining({ confirmedAt: expect.anything() }),
    ]);
  });
});
