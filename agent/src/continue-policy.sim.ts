import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContinuePolicy } from './continue-policy.js';
import { TaskProgress } from './task-progress.js';

test('没有新证据时，续做保留两分钟和三次上限，且不包含此前正常执行时间', () => {
  let now = 300_000;
  const policy = new ContinuePolicy(() => now);
  const verdict = { status: 'continue' as const, remaining: '还有已授权的内容没读完' };
  const context = { runId: 'task', snapshot: { ...new TaskProgress('task').snapshot(), startedAt: 0 }, goal: '读完全部材料', failed: [] };
  assert.ok('prompt' in policy.next(verdict, context));
  policy.started('task', 'a', null);
  now += 119_999;
  assert.ok('prompt' in policy.next(verdict, context));
  now++;
  assert.deepEqual(policy.next(verdict, context), { settle: 'open', overBudget: true });
  policy.reset();
  for (let i = 0; i < 3; i++) {
    assert.ok('prompt' in policy.next(verdict, context));
    policy.started('task', String(i), null);
  }
  assert.deepEqual(policy.next(verdict, context), { settle: 'open' });
  assert.ok('prompt' in policy.next(verdict, { ...context, runId: 'new-task' }));
});


test('新证据使持续推进的任务跨过三轮和两分钟，空转仍停止', () => {
  let now = 0;
  const policy = new ContinuePolicy(() => now);
  const verdict = { status: 'continue' as const, remaining: '继续读取下一项' };
  const context = { runId: 'long-task', snapshot: null, goal: '读完全部材料', failed: [], progress: 0 };
  for (let progress = 1; progress <= 6; progress++) {
    now += 180_000;
    context.progress = progress;
    assert.ok('prompt' in policy.next(verdict, context));
    policy.started(context.runId, String(progress), 'same page');
  }
  now += 120_000;
  assert.deepEqual(policy.next(verdict, context), { settle: 'open', overBudget: true });
});
