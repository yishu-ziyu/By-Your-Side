import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { ContextFit, PAGE_OBSERVATION_MARK, RUN_CONTEXT_HEADER, earlierResultText, earlierResultContent } from './context-fit.js';
import { createReadAttachmentTool } from './attached-files.js';

const model = { contextWindow: 1_000_000 } as Model<Api>;
const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' };
const answer = (text: string, timestamp: number): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop' });
const run = (id: number): Message[] => [
  { role: 'user', timestamp: id * 10, content: `${RUN_CONTEXT_HEADER}\n\nToday is 2026-11-17.\n${JSON.stringify({ task: { runId: `run-${id}`, goal: `原始目标${id}` }, page: { url: `https://site${id}.example/article` } })}` },
  { role: 'user', timestamp: id * 10 + 1, content: [{ type: 'text', text: `用户原话${id}\n\n${PAGE_OBSERVATION_MARK}]\n<page-content>${'历史页面'.repeat(1000)}</page-content>` }, image] },
  { role: 'toolResult', isError: false, toolName: 'snapshot', toolCallId: `read-${id}`, timestamp: id * 10 + 2, content: [{ type: 'text', text: `精确原文${id}${'页面内容'.repeat(1000)}` }, image] },
  { role: 'toolResult', isError: false, toolName: 'click', toolCallId: `write-${id}`, timestamp: id * 10 + 3, content: [{ type: 'text', text: `完成动作${id}${'写入结果'.repeat(1000)}` }] },
  answer(`本轮已得结论${id}`, id * 10 + 4),
];

test('已结束运行收拢较早的页面数据和图片，保留最近两轮，并能取回原文与原图', () => {
  const messages = [1, 2, 3, 4].flatMap(run);
  const before = JSON.stringify(messages);
  const view = new ContextFit().fit(messages, model, 15);
  const firstResult = view.find(m => m.role === 'toolResult' && m.toolCallId === 'read-1')!;
  assert.ok(!JSON.stringify(firstResult).includes('页面内容'), '旧页面应在未触及窗口阈值时被收拢');
  assert.match(JSON.stringify(firstResult), /earlier:read-1/);
  assert.ok(!JSON.stringify(firstResult).includes(image.data), '工具截图按需取回');
  assert.ok(JSON.stringify(view[1]).includes('用户原话1'));
  assert.ok(!JSON.stringify(view[1]).includes(image.data), '较早用户图按需取回');
  const imageName = /earlier:image:[a-f0-9]+/.exec(JSON.stringify(view[1]))?.[0];
  assert.ok(imageName);
  assert.ok(earlierResultContent(messages, imageName)?.some(part => part.type === 'image' && part.data === image.data));
  assert.ok(!JSON.stringify(view[1]).includes('历史页面'));
  assert.ok(JSON.stringify(view).includes('本轮已得结论1'));
  assert.ok(JSON.stringify(view[0]).includes('原始目标1'));
  assert.ok(JSON.stringify(view[3]).includes('完成动作1'));
  assert.deepEqual(view.slice(5), messages.slice(5), '最近两轮及当前运行保持完整');
  assert.equal(earlierResultText(messages, 'earlier:read-1'), `精确原文1${'页面内容'.repeat(1000)}`);
  assert.equal(JSON.stringify(messages), before, '原始记录不得改变');
});

test('未归档运行在窗口压力下仍保留用户贴图和原话，随机长度下原始记录保持不变', () => {
  let seed = 918;
  for (let i = 0; i < 25; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = 1000 + seed % 10_000;
    const messages = run(1);
    messages[2] = { role: 'toolResult', isError: false, toolName: 'snapshot', toolCallId: 'big', timestamp: 12, content: [{ type: 'text', text: 'x'.repeat(length) }] };
    const before = JSON.stringify(messages);
    const view = new ContextFit().fit(messages, { ...model, contextWindow: 1000 }, 4);
    assert.ok(JSON.stringify(view[1]).includes('用户原话1'));
    assert.ok(JSON.stringify(view[1]).includes(image.data), '用户图片应保持可见');
    assert.equal(JSON.stringify(messages), before);
  }
});

test('多个页面观察之间和之后的用户补充保持完整，缺少结束边界时不裁剪', () => {
  const messages = [1, 2, 3, 4].flatMap(run);
  messages[1] = { role: 'user', timestamp: 11, content: `先看材料\n${PAGE_OBSERVATION_MARK}]\n<page-content>${'页面甲'.repeat(1000)}</page-content>\n不要发送，等我确认。\n${PAGE_OBSERVATION_MARK}]\n<page-content>${'页面乙'.repeat(1000)}</page-content>\n只改我指定的字段。` };
  const view = new ContextFit().fit(messages, model, 15);
  assert.ok(JSON.stringify(view[1]).includes('不要发送，等我确认。'));
  assert.ok(JSON.stringify(view[1]).includes('只改我指定的字段。'));
  assert.ok(!JSON.stringify(view[1]).includes('页面甲'));
  assert.ok(!JSON.stringify(view[1]).includes('页面乙'));
  messages[1] = { role: 'user', timestamp: 11, content: `原话${PAGE_OBSERVATION_MARK}]${'未封闭页面'.repeat(1000)}\n不要发送` };
  assert.deepEqual(new ContextFit().fit(messages, model, 15)[1], messages[1]);
  messages[1] = { role: 'user', timestamp: 11, content: `原话\n${PAGE_OBSERVATION_MARK}]\n[Tab is unchanged.]\n\n不要发送，等我确认。\n附件原文：\n<page-content>${'用户附件'.repeat(1000)}</page-content>` };
  assert.deepEqual(new ContextFit().fit(messages, model, 15)[1], messages[1], '未变化的观察不能把后面的用户附件当成页面内容');
});

test('纯文字模型仍可回读带截图的历史工具结果中的原文', async () => {
  const tool = createReadAttachmentTool(() => [], undefined, () => false, () => [{ type: 'text', text: '订单编号 ABC123' }, image]);
  const result = await tool.execute('read', { name: 'earlier:order', query: 'ABC123' }, undefined, undefined as never, undefined as never);
  assert.match(JSON.stringify(result.content), /ABC123/);
  assert.ok(!JSON.stringify(result.content).includes(image.data));
});

test('同一任务连续多轮已有结论时也按已结束轮次收拢，当前运行不受影响', () => {
  const messages = [1, 2, 3, 4].flatMap(run).map(message => message.role === 'user' && typeof message.content === 'string'
    ? { ...message, content: message.content.replace(/run-\d/g, 'same-task') } : message);
  const view = new ContextFit().fit(messages, model, 15);
  assert.ok(!JSON.stringify(view[2]).includes('页面内容'));
  assert.deepEqual(view.slice(5), messages.slice(5));
});
