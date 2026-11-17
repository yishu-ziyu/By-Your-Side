import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { ContextFit, PAGE_OBSERVATION_MARK, RUN_CONTEXT_HEADER, earlierResultText } from './context-fit.js';

const model = { contextWindow: 1_000_000 } as Model<Api>;
const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' };
const answer = (text: string, timestamp: number): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop' });
const run = (id: number): Message[] => [
  { role: 'user', timestamp: id * 10, content: `${RUN_CONTEXT_HEADER}\n\nToday is 2026-11-17.\n${JSON.stringify({ task: { runId: `run-${id}`, goal: `原始目标${id}` }, page: { url: `https://site${id}.example/article` } })}` },
  { role: 'user', timestamp: id * 10 + 1, content: [{ type: 'text', text: `用户原话${id}\n\n${PAGE_OBSERVATION_MARK}]\n<page-content>${'历史页面'.repeat(1000)}</page-content>` }, image] },
  { role: 'toolResult', toolName: 'snapshot', toolCallId: `read-${id}`, timestamp: id * 10 + 2, content: [{ type: 'text', text: `精确原文${id}${'页面内容'.repeat(1000)}` }, image] },
  { role: 'toolResult', toolName: 'click', toolCallId: `write-${id}`, timestamp: id * 10 + 3, content: [{ type: 'text', text: `完成动作${id}${'写入结果'.repeat(1000)}` }] },
  answer(`本轮已得结论${id}`, id * 10 + 4),
];

test('已结束运行只收拢较早的页面数据，保留最近两轮和用户图片，并能取回原文', () => {
  const messages = [1, 2, 3, 4].flatMap(run);
  const before = JSON.stringify(messages);
  const view = new ContextFit().fit(messages, model, 15);
  const firstResult = view.find(m => m.role === 'toolResult' && m.toolCallId === 'read-1')!;
  assert.ok(!JSON.stringify(firstResult).includes('页面内容'), '旧页面应在未触及窗口阈值时被收拢');
  assert.match(JSON.stringify(firstResult), /earlier:read-1/);
  assert.ok(!JSON.stringify(firstResult).includes(image.data), '工具截图按需取回');
  assert.ok(JSON.stringify(view[1]).includes('用户原话1'));
  assert.ok(JSON.stringify(view[1]).includes(image.data), '用户贴图始终保留');
  assert.ok(!JSON.stringify(view[1]).includes('历史页面'));
  assert.ok(JSON.stringify(view).includes('本轮已得结论1'));
  assert.ok(JSON.stringify(view[0]).includes('原始目标1'));
  assert.ok(JSON.stringify(view[3]).includes('完成动作1'));
  assert.deepEqual(view.slice(5), messages.slice(5), '最近两轮及当前运行保持完整');
  assert.equal(earlierResultText(messages, 'earlier:read-1'), `精确原文1${'页面内容'.repeat(1000)}`);
  assert.equal(JSON.stringify(messages), before, '原始记录不得改变');
});

test('窗口压力也不能丢掉用户贴图和原话，随机长度下原始记录保持不变', () => {
  let seed = 918;
  for (let i = 0; i < 25; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = 1000 + seed % 10_000;
    const messages = run(1);
    messages[2] = { role: 'toolResult', toolName: 'snapshot', toolCallId: 'big', timestamp: 12, content: [{ type: 'text', text: 'x'.repeat(length) }] };
    const before = JSON.stringify(messages);
    const view = new ContextFit().fit(messages, { ...model, contextWindow: 1000 }, 4);
    assert.ok(JSON.stringify(view[1]).includes('用户原话1'));
    assert.ok(JSON.stringify(view[1]).includes(image.data), '用户图片应保持可见');
    assert.equal(JSON.stringify(messages), before);
  }
});
