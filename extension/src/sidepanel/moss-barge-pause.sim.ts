/**
 * 本机先暂停 MOSS 回答的规则：假时钟喂麦克风帧，只判暂停/接着播的动作。真的停声与接播仍要端到端验。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MossBargePause } from './moss-barge-pause.js';

const FRAME = 20;

function run(rule: MossBargePause, from: number, to: number, rms: number, playing = true) {
  const actions: Array<[number, string]> = [];
  for (let at = from; at < to; at += FRAME) {
    const action = rule.frame(at, rms, playing);
    if (action) actions.push([at, action]);
  }
  return actions;
}

test('回答播放中开口约 160 ms 就暂停，远早于 0.3 秒', () => {
  const rule = new MossBargePause();
  assert.deepEqual(run(rule, 0, 1000, 0.05), [[160, 'pause']]);
});

test('没在播放时说话不暂停；短于 160 ms 的爆音不暂停', () => {
  const rule = new MossBargePause();
  assert.deepEqual(run(rule, 0, 1000, 0.05, false), []);
  assert.deepEqual(run(rule, 1000, 1100, 0.05), []);
  assert.deepEqual(run(rule, 1100, 2000, 0.001), []);
});

test('附和「嗯」：服务端给了转写但没停播，说完后接着播', () => {
  const rule = new MossBargePause();
  assert.deepEqual(run(rule, 0, 400, 0.05), [[160, 'pause']]);
  assert.deepEqual(run(rule, 400, 1100, 0.001), []);
  rule.transcript(1100);
  assert.deepEqual(run(rule, 1100, 3000, 0.001), [[1700, 'resume']]);
});

test('附和没有转写时，安静 1.5 秒后接着播', () => {
  const rule = new MossBargePause();
  run(rule, 0, 400, 0.05);
  assert.deepEqual(run(rule, 400, 3000, 0.001), [[1900, 'resume']]);
});

test('真插话：服务端停播后不再接着播', () => {
  const rule = new MossBargePause();
  run(rule, 0, 3000, 0.05);
  rule.transcript(3700);
  rule.stopped();
  assert.deepEqual(run(rule, 3000, 6000, 0.001), []);
});

test('说话中途停顿不算说完：再开口就重新计安静时间', () => {
  const rule = new MossBargePause();
  run(rule, 0, 400, 0.05);
  rule.transcript(500);
  assert.deepEqual(run(rule, 400, 600, 0.001), []);
  assert.deepEqual(run(rule, 600, 1500, 0.05), []);
  assert.deepEqual(run(rule, 1500, 2000, 0.001), [[1800, 'resume']]);
});
