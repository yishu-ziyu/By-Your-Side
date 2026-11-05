import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgramBudget } from './program-budget.js';

test('等待不占程序的 60 秒；不等待的程序仍在 60 秒停下', () => {
  let now = 0;
  const budget = new ProgramBudget(() => now, 60_000);
  now = 59_999; assert.equal(budget.expired(), false);
  now = 60_000; assert.equal(budget.expired(), true);

  now = 0;
  const waiting = new ProgramBudget(() => now, 60_000);
  for (let i = 0; i < 30; i++) { now += 10_000; waiting.creditWait(10_000); now += 300; }
  assert.equal(now, 309_000);
  assert.equal(waiting.expired(), false);
});

test('等待累计 10 分钟后不再延长，程序不会无限挂着', () => {
  let now = 0;
  const budget = new ProgramBudget(() => now, 60_000);
  for (let i = 0; i < 70; i++) { now += 10_000; budget.creditWait(10_000); }
  assert.equal(budget.waitBudgetUsed(), true);
  assert.equal(budget.deadline, 660_000);
  now = 659_999; assert.equal(budget.expired(), false);
  now = 660_000; assert.equal(budget.expired(), true);
});
