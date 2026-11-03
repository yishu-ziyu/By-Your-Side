import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceConnectionNotice } from './voice-connection-notice.js';

test('连接超过八秒才提示，重试不延后提示，提示只出现一次', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let notices = 0;
  const notice = new VoiceConnectionNotice(() => { notices++; });
  notice.start();
  t.mock.timers.tick(4000);
  notice.start();
  t.mock.timers.tick(3999);
  assert.equal(notices, 0);
  t.mock.timers.tick(1);
  assert.equal(notices, 1);
  assert.equal(notice.notified, true);
  notice.start();
  t.mock.timers.tick(8000);
  assert.equal(notices, 1);
});

test('连接成功或结束后不显示旧提示，新连接重新计时', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let notices = 0;
  const notice = new VoiceConnectionNotice(() => { notices++; });
  notice.start();
  t.mock.timers.tick(7999);
  notice.reset();
  t.mock.timers.tick(10_000);
  assert.equal(notices, 0);
  notice.start();
  t.mock.timers.tick(8000);
  assert.equal(notices, 1);
  notice.reset();
  assert.equal(notice.notified, false);
});
