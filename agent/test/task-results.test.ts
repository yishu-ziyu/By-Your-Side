import {describe, expect, it} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {createTaskResultsTool, type TaskResultRegistration} from '../src/task-results.js';
import {isTaskProgressSnapshot} from '../../shared/voice.js';
import {isTaskResultItem, resultStateOf} from '../../shared/task-results.js';

const intents: TaskResultRegistration[] = [
  {id: 'observe-x', description: '核对X', tool: 'snapshot', target: null},
  {id: 'mark-x', description: '标出指定对象', tool: 'mark', target: '#x'},
];

function progress() {
  const p = new TaskProgress('default');
  p.request('找到X再圈出，保持当前页。');
  p.observe({type: 'agent_event', event: {kind: 'agent_start'}});
  p.registerResults(intents);
  return p;
}

function call(p: TaskProgress, id: string, name: string, params: Record<string, unknown> = {}, failed = false) {
  const runId = p.snapshot().runId;
  p.observe({type: 'agent_event', runId, event: {kind: 'tool_start', toolCallId: id, name, params}} as any);
  p.observe({type: 'agent_event', runId, event: {kind: 'tool_end', toolCallId: id, name, isError: failed, resultText: 'receipt'}} as any);
}

describe('task result registry', () => {
  it('defaults to an empty unregistered ledger and never claims independent verification', () => {
    const p = new TaskProgress('default');
    expect(p.snapshot()).toMatchObject({results: [], resultState: 'unregistered', successVerified: false});
    expect(isTaskProgressSnapshot(p.snapshot())).toBe(true);
  });

  it('does not complete a write result with a null target wildcard', () => {
    const p = progress();
    p.reviseResults();
    // 契约修订（2026-09-11）：同工具唯一的未定位项会在执行时改绑；歧义（两项 null）不得当成通配符。
    p.registerResults([{id: 'mark-x2', description: '标出另一个对象', tool: 'mark', target: null}]);
    call(p, 'wild', 'mark', {target: '#x'});
    expect(p.snapshot().results!.find(r => r.id === 'mark-x')).toMatchObject({status: 'pending', target: null});
    expect(p.snapshot().results!.find(r => r.id === 'mark-x2')).toMatchObject({status: 'pending', target: null});
    expect(p.snapshot().results!.find(r => r.id.startsWith('auto-'))).toMatchObject({status: 'satisfied', target: '#x'});
    expect(p.snapshot().resultState).toBe('pending');
  });

  it('keeps the first evidence when a duplicate receipt arrives', () => {
    const p = progress();
    call(p, 'read', 'snapshot');
    call(p, 'draw', 'mark', {target: '#x'});
    const first = p.snapshot().results!.find(r => r.id === 'mark-x')!.evidence;
    call(p, 'again', 'mark', {target: '#x'});
    expect(p.snapshot().results!.find(r => r.id === 'mark-x')!.evidence).toEqual(first);
    expect(p.snapshot().successVerified).toBe(false);
  });

  it('restores aborted identity as aborted and running identity as idle', () => {
    const p = progress();
    call(p, 'read', 'snapshot');
    p.abort();
    const restored = new TaskProgress('default');
    restored.restoreResults(p.snapshot());
    expect(restored.snapshot()).toMatchObject({runId: p.snapshot().runId, state: 'aborted', resultState: 'pending'});
    const live = progress();
    call(live, 'read', 'snapshot');
    call(live, 'draw', 'mark', {target: '#x'});
    const idle = new TaskProgress('default');
    idle.restoreResults(live.snapshot());
    expect(idle.snapshot().state).not.toBe('running');
    expect(idle.snapshot().resultState).toBe('satisfied');
  });

  it('ignores a snapshot from another conversation', () => {
    const p = progress();
    const other = new TaskProgress('other');
    other.restoreResults(p.snapshot());
    expect(other.snapshot()).toMatchObject({results: [], resultState: 'unregistered'});
  });
});

describe('createTaskResultsTool', () => {
  it('registers intent only and rejects meta tools, inactive tools, and completion claims', async () => {
    const p = progress();
    const active = new Set(['snapshot', 'mark']);
    const tool = createTaskResultsTool({
      getSnapshot: () => p.snapshot(),
      register: items => p.registerResults(items),
      isToolActive: name => active.has(name),
    });
    expect(tool.name).toBe('record_task_results');
    await expect(tool.execute('t1', {results: [{id: 'mark-x', description: '标出指定对象', tool: 'send_user_message', target: '#x'}]} as any, undefined, undefined, {} as any)).rejects.toThrow(/send_user_message/);
    await expect(tool.execute('t2', {results: [{id: 'mark-x', description: '标出指定对象', tool: 'record_task_results', target: null}]} as any, undefined, undefined, {} as any)).rejects.toThrow(/record_task_results/);
    await expect(tool.execute('t3', {results: [{id: 'mark-x', description: '标出指定对象', tool: 'click', target: '#x'}]} as any, undefined, undefined, {} as any)).rejects.toThrow(/未启用/);
    const result = await tool.execute('t4', {results: [{id: 'mark-x', description: '标出指定对象', tool: 'mark', target: '#y', status: 'satisfied'}]} as any, undefined, undefined, {} as any);
    expect(p.snapshot().results!.find(r => r.id === 'mark-x')).toMatchObject({status: 'pending', target: '#y'});
    expect(JSON.parse((result as any).content[0].text).resultState).toBe('pending');
    expect(p.snapshot().results!.every(isTaskResultItem)).toBe(true);
    expect(resultStateOf(p.snapshot().results!)).toBe('pending');
  });
});
