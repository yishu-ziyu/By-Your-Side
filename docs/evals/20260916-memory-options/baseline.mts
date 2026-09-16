import { mkdir, writeFile } from 'node:fs/promises';
import { MemoryStore } from '../../../agent/src/memory-store.ts';
import { MemoryRuntime } from '../../../agent/src/memory-runtime.ts';

const root = `/tmp/bys-memory-eval-PBf7d2/baseline-${Date.now()}`;
const results: unknown[] = [];
const all = { kind: 'all' } as const;
const seed = '用户的默认邮箱是 lin@example.test';
async function scenario(id: string, messages: Array<[string, string]>, seeded = true) {
  const store = new MemoryStore(`${root}/${id}`);
  if (seeded) await store.create({ text: seed, scope: all, sourceConversationId: 'seed' });
  const runtime = new MemoryRuntime(store, 'probe', () => {});
  const steps: unknown[] = [];
  for (const [user, proposedMemory] of messages) {
    runtime.beginUserTurn(user);
    try {
      const tool = runtime.tools()[0] as any;
      await tool.execute('probe', { text: proposedMemory });
      steps.push({ user, saved: true });
    } catch (error) { steps.push({ user, saved: false, error: String(error) }); }
  }
  results.push({ id, level: 'component: proposed tool arguments supplied by probe, no model', steps, entries: await store.list() });
  return store;
}
await scenario('C1-natural', [['我的邮箱是lin@example.test你可以记住这一点。', seed]], false);
await scenario('C1-punctuation', [['我的邮箱是 lin@example.test，你可以记住这一点。', seed]], false);
const store = await scenario('C1-command-control', [['记住我的默认邮箱是 lin@example.test', seed]], false);
for (const text of ['帮我报名', '帮我报名，表单需要邮箱', '我的邮箱是什么']) {
  results.push({ id: 'C2', query: text, entries: await new MemoryStore(`${root}/C1-command-control`).select({ text }) });
}
await scenario('C3', [['这次用 work@example.test，默认邮箱不变。', '用户的默认邮箱是 work@example.test']]);
await scenario('C4', [['以后改用 new@example.test，旧邮箱不用了。', '用户的默认邮箱是 new@example.test']]);
await scenario('C5', [['总结当前网页', '用户邮箱是 visitor@example.test']], false);
const before = await store.list();
await store.forget({ id: before[0]!.id, expectedVersion: before[0]!.version });
results.push({ id: 'C6-delete', entries: await store.select({ text: '我的邮箱' }) });
// Explicitly model source replay at the store boundary, not a claim that production schedules this job.
await store.create({ text: seed, scope: all, sourceConversationId: 'probe' });
results.push({ id: 'C6-replay-store-boundary', entries: await store.select({ text: '我的邮箱' }), note: 'Store has no explicit-memory source suppression; production replay not exercised.' });
await mkdir('docs/evals/20260916-memory-options', { recursive: true });
await writeFile('docs/evals/20260916-memory-options/baseline.json', JSON.stringify({ root, results }, null, 2));
console.log(JSON.stringify(results.map((r: any) => ({ id: r.id, query: r.query, steps: r.steps, entries: r.entries?.map((e: any) => e.text) })), null, 2));
