/**
 * 念进度的时间规则：假时钟每 100 ms 拨一次并交一次 tick，只判模块要念什么、什么时候念。
 * 时间都从委派绑定任务那一刻（0 ms）算起。真的出声由 gpt-live-voice.mts --case=queued-progress 验。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceDelivery, type VoiceDeliveryEvent, type WaitingDelegation } from './voice-delivery.js';

type Said = { at: number; id: string; text: string };

function setup(...ids: string[]) {
  let now = 0;
  const delivery = createVoiceDelivery({ now: () => now });

  for (const id of ids) delivery.handle({ type: 'bound', delegationId: id, runId: `run-${id}` });

  return {
    /** 拨到 ms 时刻送一个事件。 */
    send(ms: number, event: VoiceDeliveryEvent) { now = ms; return delivery.handle(event); },
    /** 从 from 到 to（含）每 100 ms 交一次 tick；waiting(ms) 给出那一刻在等的委派。 */
    run(from: number, to: number, waiting: (ms: number) => WaitingDelegation[]): Said[] {
      const said: Said[] = [];

      for (let ms = from; ms <= to; ms += 100) {
        now = ms;
        const actions = delivery.handle({ type: 'tick', waiting: waiting(ms) });

        assert.ok(actions.length <= 1, `${ms} ms 同时念了 ${actions.length} 句`);
        for (const action of actions) said.push({ at: ms, id: action.delegationId, text: action.text });
      }

      return said;
    },
  };
}

const busy = (step: string | null, id = 'd1'): WaitingDelegation => ({ delegationId: id, runId: `run-${id}`, running: true, step });

test('9.9 秒不念，10 秒念正在做哪一步', () => {
  const voice = setup('d1');

  assert.deepEqual(voice.run(0, 9_900, () => [busy('A')]), []);
  assert.deepEqual(voice.run(10_000, 10_000, () => [busy('A')]), [{ at: 10_000, id: 'd1', text: '还在做，正在A。' }]);
});

test('步骤不变：隔 15 秒才再念，换成「还在A，稍等」', () => {
  const voice = setup('d1');

  assert.deepEqual(voice.run(0, 25_000, () => [busy('A')]).map(s => [s.at, s.text]), [[10_000, '还在做，正在A。'], [25_000, '还在A，稍等。']]);
});

test('13 秒换成步骤 B：隔 10 秒（20 秒）就念新步骤', () => {
  const voice = setup('d1');

  assert.deepEqual(voice.run(0, 24_900, ms => [busy(ms < 13_000 ? 'A' : 'B')]).map(s => [s.at, s.text]), [[10_000, '还在做，正在A。'], [20_000, '还在做，正在B。']]);
});

test('用户 24 秒说话：28 秒之前不念', () => {
  const voice = setup('d1');

  assert.equal(voice.run(0, 23_900, () => [busy('A')]).length, 1);
  voice.send(24_000, { type: 'user_spoke' });
  assert.deepEqual(voice.run(24_000, 28_000, () => [busy('A')]), [{ at: 28_000, id: 'd1', text: '还在A，稍等。' }]);
});

test('同一个委派念满 8 句后不再念', () => {
  const voice = setup('d1');
  const said = voice.run(0, 600_000, () => [busy('A')]);

  assert.equal(said.length, 8);
  assert.equal(said[7]?.at, 115_000);
});

test('两个委派同时在等：同一时刻只念一句，先绑定的先念', () => {
  const voice = setup('d1', 'd2');
  const said = voice.run(0, 10_100, () => [busy('A', 'd1'), busy('B', 'd2')]);

  assert.deepEqual(said, [{ at: 10_000, id: 'd1', text: '还在做，正在A。' }, { at: 10_100, id: 'd2', text: '还在做，正在B。' }]);
});

test('任务不在跑：不念', () => {
  const voice = setup('d1');

  assert.deepEqual(voice.run(0, 60_000, () => [{ ...busy('A'), running: false }]), []);
});

test('没有步骤名：15 秒才念「还在做，稍等」', () => {
  const voice = setup('d1');

  assert.deepEqual(voice.run(0, 15_000, () => [busy(null)]).map(s => [s.at, s.text]), [[15_000, '还在做，稍等。']]);
});

test('没绑定过或已收尾的委派：不念', () => {
  const voice = setup('d1');

  voice.send(5_000, { type: 'done', delegationId: 'd1' });
  assert.deepEqual(voice.run(5_000, 60_000, () => [busy('A'), busy('A', 'never-bound')]), []);
});
