import {describe, expect, it} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {createSendUserMessageTool, projectDeliveryFacts} from '../src/user-delivery.js';
import {resultHasWriteEffect} from '../../shared/task-results.js';
import type {AgentUiEvent} from '../../shared/protocol.js';

function task() {
  let time = 0;
  const progress = new TaskProgress('default', () => ++time);
  progress.request('切换到资料页');
  const emit = (event: AgentUiEvent) => progress.observe({type: 'agent_event', event});
  emit({kind: 'agent_start'});
  const read = (id: string, tabId: number) => {
    emit({kind: 'tool_start', toolCallId: id, name: 'snapshot', params: {tabId}});
    emit({kind: 'tool_end', toolCallId: id, name: 'snapshot', isError: false, executionFact: 'executed', resultText: '资料页'});
    emit({kind: 'tool_observation', toolCallId: id, name: 'snapshot', target: null, tabId, workingTab: true, text: '资料页', truncated: false});
  };
  return {progress, emit, read};
}

describe('voice task delivery follows actual browser results', () => {
  it.each(['tabs','switch_tab'])('records a successful %s switch without treating it as an irreversible page write', name => {
    const h = task();
    h.read('source', 7);
    h.emit({kind: 'tool_start', toolCallId: 'switch', name, params: {action: 'switch', tabId: 9}});
    h.emit({kind: 'tool_end', toolCallId: 'switch', name, isError: false, executionFact: 'executed', resultText: 'Working tab is now 9.'});
    expect(h.progress.snapshot().results).toHaveLength(1);
    expect(resultHasWriteEffect(h.progress.snapshot().results![0]!)).toBe(false);
    expect(h.progress.snapshot().nextStep?.delivery).toBe('partial');
    h.read('wrong-page', 7);
    expect(h.progress.snapshot().nextStep?.delivery).toBe('partial');
    h.read('target-page', 9);
    const revision=h.progress.snapshot().goalPlan!.revision;
    h.progress.goals.install(revision,[{id:'destination',description:'切换到资料页',criterion:'当前工作页是资料页',kind:'condition',requirements:['requirement-1']}],1);
    h.progress.goals.verify(revision,'destination',{matched:true,reason:'目标页已核对',evidence:{observationId:'target-page',tabId:9,verifiedAt:10}});
    expect(projectDeliveryFacts(h.progress.deliveryFacts(), h.progress.snapshot().nextStep).outcome).toBe('complete');
  });

  it('keeps a refused tab switch incomplete, without locking later writes as an unknown remote effect', () => {
    const h = task();
    h.emit({kind: 'tool_start', toolCallId: 'switch', name: 'tabs', params: {action: 'switch', tabId: 9}});
    h.emit({kind: 'tool_end', toolCallId: 'switch', name: 'tabs', isError: true, executionFact: 'not_executed', resultText: '页面现在归你'});
    expect(h.progress.snapshot().results?.[0]?.status).toBe('blocked');
    expect(h.progress.snapshot().nextStep).toMatchObject({delivery: 'partial', allowWrites: true});
  });

  it('does not reuse the successful result of one tab for a later switch to a different tab', () => {
    const h = task();
    for (const tabId of [9, 12]) {
      h.emit({kind: 'tool_start', toolCallId: `switch-${tabId}`, name: 'tabs', params: {action: 'switch', tabId}});
      h.emit({kind: 'tool_end', toolCallId: `switch-${tabId}`, name: 'tabs', isError: false, executionFact: 'executed', resultText: 'ok'});
      h.read(`read-${tabId}`, tabId);
    }
    const items = h.progress.snapshot().results!;
    expect(items).toHaveLength(2);
    expect(items[0]!.target).not.toBe(items[1]!.target);
  });

  it('rejects a complete message when the host would label its facts unverified, before emitting or speaking it', async () => {
    const h = task();
    const events: AgentUiEvent[] = [];
    const tool = createSendUserMessageTool({conversationId: 'default', getRunId: () => h.progress.snapshot().runId!,
      getNextStep: () => h.progress.snapshot().nextStep!, getDeliveryFacts: () => h.progress.deliveryFacts(), emit: e => events.push(e)});
    await expect(tool.execute('delivery', {kind: 'finding', outcome: 'complete', content: '已经切到资料页。'}, undefined, undefined, {} as never)).rejects.toThrow(/未核验/);
    expect(events).toEqual([]);
  });
});
