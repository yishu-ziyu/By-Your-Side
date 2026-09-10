import {afterEach, describe, expect, it, vi} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {ConversationManager} from '../src/conversation-manager.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));

function progress() {
  const p = new TaskProgress('default');
  p.request('先观察X再标注，保持只处理当前页。');
  p.observe({type: 'agent_event', event: {kind: 'agent_start'}});
  return p;
}

function managerHarness() {
  let sink: (m: any) => void = () => {};
  let paused = false;
  let started = false;
  const emitted: any[] = [];
  const startTask = vi.fn(() => {
    sink({type: 'agent_event', event: {kind: 'agent_start'}});
    sink({type: 'status', state: 'running'});
  });
  const session: any = {
    available: true, modelName: () => 'fixture', executionEpoch: () => 7,
    isHeld: () => paused, isStreaming: () => started && !paused,
    startTask, bindDeliveryRun: vi.fn(), bindConversationContext: vi.fn(),
    queueSteerForResume: vi.fn(), steerCurrentTask: vi.fn(async () => {}),
  };
  const manager = new ConversationManager(async (_id, emit) => {
    sink = emit;
    return {
      session, rpc: {rejectAll: vi.fn()},
      fleet: {reset: vi.fn(), isGroupHeld: () => paused, teamView: () => null, list: () => []},
      handleMessage: vi.fn(), dispose: () => {},
    } as any;
  }, message => emitted.push(message));
  cleanup.push(() => manager.dispose());
  return {
    manager, emitted, session, startTask,
    get sink() { return sink; },
    set paused(value: boolean) { paused = value; },
    set started(value: boolean) { started = value; },
  };
}

describe('S2 lifecycle isolation', () => {
  it('explicit old-run status, tools and end events leave the current run unchanged', () => {
    const p = progress();
    const old = p.snapshot().runId!;
    p.abort();
    p.request('新委托Y');
    p.observe({type: 'agent_event', event: {kind: 'agent_start'}});
    const before = p.snapshot();
    p.observe({type: 'status', state: 'user', runId: old} as any);
    p.observe({type: 'agent_event', runId: old, event: {kind: 'tool_start', toolCallId: 'late', name: 'mark', params: {}}} as any);
    p.observe({type: 'agent_event', runId: old, event: {kind: 'tool_end', toolCallId: 'late', name: 'mark', isError: false, resultText: 'ok'}} as any);
    p.observe({type: 'agent_event', runId: old, event: {kind: 'error', message: 'stale'}} as any);
    p.observe({type: 'agent_event', runId: old, event: {kind: 'agent_end'}} as any);
    expect(p.snapshot()).toMatchObject({runId: before.runId, state: 'running', lastAction: null, active: [], goal: before.goal});
  });

  it('tool_end only records an executed action when member, call id and name match a start', () => {
    const p = progress();
    p.observe({type: 'agent_event', event: {kind: 'tool_end', toolCallId: 'never-started', name: 'mark', isError: false, resultText: 'success'}});
    expect(p.snapshot().lastAction).toBeNull();
    p.observe({type: 'agent_event', event: {kind: 'tool_start', toolCallId: 'one', name: 'snapshot', params: {}}});
    p.observe({type: 'agent_event', event: {kind: 'tool_end', toolCallId: 'one', name: 'mark', isError: false, resultText: 'ok'}});
    expect(p.snapshot().lastAction).toBeNull();
    expect(p.snapshot().active).toEqual([expect.objectContaining({action: '读取页面'})]);
    p.observe({type: 'agent_event', sessionId: 'worker', event: {kind: 'tool_end', toolCallId: 'one', name: 'snapshot', isError: false, resultText: 'ok'}});
    expect(p.snapshot().lastAction).toBeNull();
    p.observe({type: 'agent_event', event: {kind: 'tool_end', toolCallId: 'one', name: 'snapshot', isError: false, resultText: 'ok'}});
    expect(p.snapshot()).toMatchObject({lastAction: {action: '读取页面', failed: false}, active: []});
  });

  it('accepted text steer stays on the original run and is recorded once; rejected steer is omitted', async () => {
    const h = managerHarness();
    await h.manager.ensureDefault();
    await h.manager.dispatchTaskAction({requestId: 'start', conversationId: 'default', source: 'text', action: 'start', expectedRunId: null, text: '观察X再标注，保持只处理当前页。'});
    h.started = true;
    const before = h.manager.getTaskProgress('default')!;
    const rejected = await h.manager.dispatchTaskAction({requestId: 'stale', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: 'not-current', text: '对象改成Z，其他要求保留。'});
    expect(rejected.status).toBe('rejected');
    expect(h.manager.getTaskProgress('default')!.conversationContext!.recentTurns).not.toContainEqual({role: 'user', text: '对象改成Z，其他要求保留。'});
    const request = {requestId: 'correct', conversationId: 'default', source: 'text' as const, action: 'steer' as const, expectedRunId: before.runId!, text: '对象改成Y，其他要求保留。'};
    expect((await h.manager.dispatchTaskAction(request)).status).toBe('accepted');
    expect((await h.manager.dispatchTaskAction(request)).status).toBe('accepted');
    const after = h.manager.getTaskProgress('default')!;
    expect(after.runId).toBe(before.runId);
    expect(after.goal).toBe(before.goal);
    expect(after.conversationContext!.recentTurns.filter(t => t.text === '对象改成Y，其他要求保留。')).toHaveLength(1);
    expect(h.startTask).toHaveBeenCalledTimes(1);
    expect(h.session.steerCurrentTask).toHaveBeenCalledTimes(1);
    expect(h.session.queueSteerForResume).not.toHaveBeenCalled();

    h.paused = true;
    h.sink({type: 'status', state: 'user'});
    const hold = {requestId: 'paused-correct', conversationId: 'default', source: 'text' as const, action: 'steer' as const, expectedRunId: before.runId!, text: '暂停后再改成Y。'};
    expect((await h.manager.dispatchTaskAction(hold)).status).toBe('accepted');
    expect((await h.manager.dispatchTaskAction(hold)).status).toBe('accepted');
    expect(h.manager.getTaskProgress('default')!.runId).toBe(before.runId);
    expect(h.manager.getTaskProgress('default')!.conversationContext!.recentTurns.filter(t => t.text === '暂停后再改成Y。')).toHaveLength(1);
    expect(h.session.queueSteerForResume).toHaveBeenCalledTimes(1);
    expect(h.session.steerCurrentTask).toHaveBeenCalledTimes(1);
  });

  it('manager forwards explicit old-run events without rewriting identity or current summary', async () => {
    const h = managerHarness();
    await h.manager.ensureDefault();
    await h.manager.dispatchTaskAction({requestId: 'start', conversationId: 'default', source: 'text', action: 'start', expectedRunId: null, text: '观察X再标注，保持只处理当前页。'});
    h.started = true;
    const old = h.manager.getTaskProgress('default')!.runId!;
    await h.manager.handleMessage({type: 'abort', conversationId: 'default'});
    h.started = false;
    expect(h.manager.getTaskProgress('default')!.runId).toBe(old);
    const started = await h.manager.dispatchTaskAction({requestId: 'next', conversationId: 'default', source: 'text', action: 'start', expectedRunId: old, text: '新委托Y'});
    expect(started.status).toBe('accepted');
    h.started = true;
    const current = h.manager.getTaskProgress('default')!.runId!;
    expect(current).not.toBe(old);
    expect(h.manager.list()[0]).toMatchObject({id: 'default', state: 'running', runId: current});
    const n = h.emitted.length;
    h.sink({type: 'status', state: 'idle', runId: old});
    h.sink({type: 'tool_call', id: 'late', name: 'mark', params: {}, runId: old});
    h.sink({type: 'agent_event', event: {kind: 'agent_start'}, runId: old});
    h.sink({type: 'agent_event', event: {kind: 'agent_end'}, runId: old});
    const late = h.emitted.slice(n);
    expect(h.manager.getTaskProgress('default')).toMatchObject({runId: current, state: 'running'});
    expect(h.manager.list()[0]).toMatchObject({id: 'default', state: 'running', runId: current});
    expect(late.some(m => m.type === 'conversation_updated')).toBe(false);
    expect(late.filter(m => m.runId === old).map(m => m.type)).toEqual(['status', 'tool_call', 'agent_event', 'agent_event']);
    expect(late.every(m => m.epochs === undefined && m.runId !== current)).toBe(true);
  });

  it('does not record a steer onto a replacement run if the original run changes while sending', async () => {
    const h = managerHarness();
    await h.manager.ensureDefault();
    await h.manager.dispatchTaskAction({requestId: 'start', conversationId: 'default', source: 'text', action: 'start', expectedRunId: null, text: '观察X再标注，保持只处理当前页。'});
    h.started = true;
    const before = h.manager.getTaskProgress('default')!;
    h.session.steerCurrentTask = vi.fn(async () => {
      await h.manager.handleMessage({type: 'abort', conversationId: 'default'});
      await h.manager.handleMessage({type: 'user_message', conversationId: 'default', text: '新委托Y'});
      h.started = true;
      h.sink({type: 'agent_event', event: {kind: 'agent_start'}});
    });
    const receipt = await h.manager.dispatchTaskAction({requestId: 'correct', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: before.runId!, text: '对象改成Y，其他要求保留。'});
    expect(receipt.status).toBe('accepted');
    const after = h.manager.getTaskProgress('default')!;
    expect(after.runId).not.toBe(before.runId);
    expect(after.conversationContext!.recentTurns).not.toContainEqual({role: 'user', text: '对象改成Y，其他要求保留。'});
  });
});
