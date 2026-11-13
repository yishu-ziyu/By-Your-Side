import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskProgress } from './task-progress.js';
import { normalizeStaleTextSteer } from './text-task-routing.js';
import type { TaskActionRequest } from '../../shared/task-actions.js';

test('任务已正常结束成 idle 时，前端滞后发来的无 taskId text steer 转为 start', () => {
  let now = 1_000;
  const progress = new TaskProgress('default', () => now);
  progress.request('案例P2：把草稿发出去。');
  progress.observe({ type: 'agent_event', event: { kind: 'agent_start' } });
  progress.observe({ type: 'agent_event', event: { kind: 'text_delta', delta: 'P2 完成。' } });
  now += 500;
  progress.observe({ type: 'agent_event', event: { kind: 'goal_check', status: 'done' } });
  progress.observe({ type: 'agent_event', event: { kind: 'agent_end' } });

  const snapshot = progress.snapshot();
  assert.equal(snapshot.state, 'idle');

  const staleSteer: TaskActionRequest = {
    requestId: 'req-p3',
    conversationId: 'default',
    source: 'text',
    action: 'steer',
    expectedRunId: snapshot.runId ?? null,
    text: '案例P3：把草稿发出去。',
  };

  const normalized = normalizeStaleTextSteer({
    request: staleSteer,
    snapshot,
    streaming: false,
    held: false,
    settleChecking: () => false,
  });
  assert.equal(normalized.action, 'start');
  assert.equal(normalized.expectedRunId, snapshot.runId);
});

test('核对阶段收到 text steer 时先结算核对并转为 start', () => {
  let settled = false;
  const progress = new TaskProgress('default', () => 2_000);
  progress.request('案例P2：把草稿发出去。');
  progress.observe({ type: 'agent_event', event: { kind: 'agent_start' } });
  progress.observe({ type: 'agent_event', event: { kind: 'goal_check', status: 'checking' } });

  const request: TaskActionRequest = {
    requestId: 'req-p3-checking',
    conversationId: 'default',
    source: 'text',
    action: 'steer',
    expectedRunId: progress.snapshot().runId ?? null,
    text: '案例P3：把草稿发出去。',
  };

  const normalized = normalizeStaleTextSteer({
    request,
    snapshot: progress.snapshot(),
    streaming: true,
    held: false,
    settleChecking: () => {
      settled = true;
      return true;
    },
  });
  assert.equal(settled, true);
  assert.equal(normalized.action, 'start');
});

test('仍有未完成项或显式指定 taskId 或语音 steer 时，保持原 action 不改', () => {
  const progress = new TaskProgress('default', () => 3_000);
  progress.request('把两栏填好');
  progress.observe({ type: 'agent_event', event: { kind: 'agent_start' } });
  progress.observe({ type: 'agent_event', event: { kind: 'goal_check', status: 'open', remaining: '还差第二栏' } });
  progress.observe({ type: 'agent_event', event: { kind: 'agent_end' } });
  const openSnapshot = progress.snapshot();

  const resumableSteer: TaskActionRequest = {
    requestId: 'req-open',
    conversationId: 'default',
    source: 'text',
    action: 'steer',
    expectedRunId: openSnapshot.runId ?? null,
    text: '补充：第二栏填上海',
  };
  assert.equal(
    normalizeStaleTextSteer({
      request: resumableSteer,
      snapshot: openSnapshot,
      streaming: false,
      held: false,
      settleChecking: () => false,
    }).action,
    'steer',
  );

  const doneProgress = new TaskProgress('default', () => 4_000);
  doneProgress.request('第一件');
  doneProgress.observe({ type: 'agent_event', event: { kind: 'agent_start' } });
  doneProgress.observe({ type: 'agent_event', event: { kind: 'goal_check', status: 'done' } });
  doneProgress.observe({ type: 'agent_event', event: { kind: 'agent_end' } });
  const doneSnapshot = doneProgress.snapshot();

  assert.equal(
    normalizeStaleTextSteer({
      request: { ...resumableSteer, taskId: 'task-1' },
      snapshot: doneSnapshot,
      streaming: false,
      held: false,
      settleChecking: () => false,
    }).action,
    'steer',
  );
  assert.equal(
    normalizeStaleTextSteer({
      request: { ...resumableSteer, source: 'voice' },
      snapshot: doneSnapshot,
      streaming: false,
      held: false,
      settleChecking: () => false,
    }).action,
    'steer',
  );
});
