import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContinuePolicy } from './continue-policy.js';
import { TaskProgress } from './task-progress.js';

test('自动续做的时限不包含此前正常执行的时间，仍保留两分钟和三次上限', () => {
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
