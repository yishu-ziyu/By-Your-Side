/**
 * 后台判断的对冲请求：假时钟和假模型只检查发了几份、谁胜出、输家是否被取消。
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { sideJudgment, type SideCallHost, type SideCallRecord } from './side-judgment.js';

type Plan = { at: number; text?: string; error?: boolean };

function setup(t: TestContext, plans: Plan[]) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sent: number[] = [];
  const aborted: number[] = [];
  const records: SideCallRecord[] = [];
  const host = {
    models: {
      completeSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        const index = sent.push(Date.now()) - 1;
        const plan = plans[index]!;
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve(plan.error
            ? { content: [], stopReason: 'error', errorMessage: '503 overloaded' }
            : { content: [{ type: 'text', text: plan.text ?? '{"ok":true}' }], stopReason: 'stop' }), plan.at);
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted.push(index);
            resolve({ content: [], stopReason: 'aborted' });
          });
        });
      },
    },
    record: (_type: 'side_call', line: SideCallRecord) => records.push(line),
  } as unknown as SideCallHost;
  const model = { provider: 'sim', id: 'classifier', api: 'openai-completions', reasoning: false, input: ['text'] } as never;
  const run = sideJudgment(host, model, {
    purpose: 'voice_plan', systemPrompt: 'sim', content: 'sim', maxTokens: 100, timeoutMs: 60_000,
    hedgeMs: 2500, retry: 'any', parse: text => JSON.parse(text) as { ok: boolean },
  });
  return { run, sent, aborted, records };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('原请求 2.5 秒未回就并发再发一份，先回来的胜出，另一份被取消', async t => {
  const sim = setup(t, [{ at: 9000, text: '{"ok":false}' }, { at: 1000 }]);
  t.mock.timers.tick(2499);
  assert.equal(sim.sent.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sim.sent.length, 2);
  t.mock.timers.tick(1000);
  assert.deepEqual(await sim.run, { ok: true });
  assert.deepEqual(sim.aborted, [0]);
  assert.equal(sim.records.at(-1)?.steps?.[0]?.winner, 'hedge');
});

test('原请求按时回来，不发第二份', async t => {
  const sim = setup(t, [{ at: 1200 }]);
  t.mock.timers.tick(1200);
  assert.deepEqual(await sim.run, { ok: true });
  t.mock.timers.tick(5000);
  assert.equal(sim.sent.length, 1);
  assert.equal(sim.records.at(-1)?.steps, undefined);
});

test('原请求在对冲前出错，外层立刻重试，不等到 2.5 秒；总共两份', async t => {
  const sim = setup(t, [{ at: 300, error: true }, { at: 500 }]);
  t.mock.timers.tick(300);
  await flush();
  assert.deepEqual(sim.sent, [0, 300]);
  t.mock.timers.tick(500);
  assert.deepEqual(await sim.run, { ok: true });
  t.mock.timers.tick(5000);
  assert.equal(sim.sent.length, 2);
});
