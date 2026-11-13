import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskProgress } from './task-progress.js';
import { projectTaskView } from '../../shared/task-view.js';

test('普通任务在核对窗口重启，恢复为已结束且未核对，不报任务中断', () => {
  let now = 1_000;
  const progress = new TaskProgress('c1', () => now);
  progress.request('读出页面标题');
  progress.observe({ type: 'agent_event', event: { kind: 'agent_start' } });
  progress.observe({ type: 'agent_event', event: { kind: 'text_delta', delta: '页面标题是整理资料。' } });
  now += 500;
  progress.observe({ type: 'agent_event', event: { kind: 'goal_check', status: 'checking' } });

  const saved = progress.snapshot();
  assert.equal(saved.state, 'running');
  assert.equal(saved.checking, true);

  const restarted = new TaskProgress('c1', () => now + 200);
  restarted.restoreResults(saved);
  const recovered = restarted.snapshot();
  assert.equal(recovered.state, 'idle');
  assert.equal(recovered.checking, undefined);
  assert.equal(recovered.interruptionReason, undefined);
  assert.equal(recovered.goalCheck, undefined);
  assert.equal(recovered.conversationContext?.latestResult?.text, '页面标题是整理资料。');
  assert.equal(projectTaskView(recovered).waiting, null);
});

test('回答被压住期间在核对窗口重启，仍按任务中断保留恢复入口', () => {
  let now = 2_000;
  const progress = new TaskProgress('c2', () => now);
  progress.request('1. 读出标题 2. 读出摘要');
  progress.observe({ type: 'agent_event', event: { kind: 'agent_start' } });
  progress.observe({ type: 'agent_event', event: { kind: 'goal_check', status: 'checking', held: true } });

  const saved = progress.snapshot();
  assert.equal(saved.state, 'running');
  assert.equal(saved.checking, undefined);

  const restarted = new TaskProgress('c2', () => now + 200);
  restarted.restoreResults(saved);
  const recovered = restarted.snapshot();
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.interruptionReason, 'host_restart');
  assert.equal(projectTaskView(recovered).waiting?.reason, 'restart_checkpoint');
});
