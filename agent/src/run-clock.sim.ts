import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunClock } from './run-clock.js';

test('长任务按间隔提醒继续，不要求用户重新授权；恢复和插话重新起算提醒', () => {
  let now = 0;
  const clock = new RunClock(() => now);
  now = 179999; assert.equal(clock.reminder(), undefined);
  now++; assert.match(clock.reminder()!, /continue the remaining authorized work/);
  assert.equal(clock.reminder(), undefined);
  now += 179999; assert.equal(clock.reminder(), undefined);
  now++; assert.match(clock.reminder()!, /6 minutes/);
  clock.reset(); assert.equal(clock.reminder(), undefined);
  clock.resumeActive(600000); assert.match(clock.reminder()!, /10 minutes/);
  assert.equal(clock.reminder(), undefined);
});
