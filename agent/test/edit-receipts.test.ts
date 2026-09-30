/**
 * Ticket T04：可核对的修改回执。
 * 原 Jev 显示直达（applied 回执、差异展示）已随本机模式退役；这里保留模型路径的回执分层、
 * 契约精确销账与旧回执数据兼容。浏览器工具层走真实 createBrowserTools 闸门，无模型调用。
 */
import {describe, expect, it, vi} from 'vitest';

vi.mock('../src/run-trace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/run-trace.js')>();

  return {...actual, RunTrace: class {begin() {} correlate() {} record() {} event() {} stage() {return {end() {}}}}};
});

import {STEER_CONTRACT_NOTE} from '../src/session.js';
import {isTaskReceipt, type TaskReceipt} from '../../shared/task-actions.js';
import {context, managerHarness, pageHarness} from './fixtures/display-steering-harness.js';

describe('A04-01 回执阶段分层：accepted 不冒充 applied', () => {
  it('模型路径修改的回执只声明送达，不出现已完成/已应用', async () => {
    const {h, manager} = await managerHarness();
    const runId = manager.getTaskProgress('default')!.runId ?? null;
    const receipt = await manager.dispatchTaskAction({requestId: 'stage-delivered', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: runId, text: '把译文改成宋体并总结标题', context});
    expect(receipt.status).toBe('accepted');
    expect(receipt.message).toContain('已送达当前任务');
    expect(receipt.message).not.toContain('已完成');
    expect(receipt.message).not.toContain('已应用');
    expect(receipt.diff).toBeUndefined();
    expect(h.translationCalls).toHaveLength(0);
    manager.dispose();
  });
  it('接管期间保存的修改回执声明交还后生效，仍不声称执行', async () => {
    const {h, manager} = await managerHarness();
    const runId = manager.getTaskProgress('default')!.runId ?? null;
    h.wrapper.holdForUser();
    const receipt = await manager.dispatchTaskAction({requestId: 'stage-queued', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: runId, text: '改成宋体', context});
    expect(receipt.status).toBe('accepted');
    expect(receipt.message).toContain('继续后生效');
    expect(receipt.message).not.toContain('已应用');
    manager.dispose();
  });
});

describe('A04-09 契约销账：原样回显精确匹配，裸原文不误放行', () => {
  it('Pi 只回显裸原文时写入闸门不放行；整条载荷回显才销账', async () => {
    const h = pageHarness();
    await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    const payload = h.steers[0]!;
    expect(payload).toContain(STEER_CONTRACT_NOTE);
    h.messageStart('把译文改成宋体');
    expect(h.wrapper.canWriteCurrentInput()).toBe(false);
    h.messageStart(payload);
    expect(h.wrapper.canWriteCurrentInput()).toBe(true);
  });
});

describe('旧数据兼容与字段校验', () => {
  const legacy: TaskReceipt = {requestId: 'old', conversationId: 'c', source: 'text', action: 'steer', runId: null, text: '改字体', targetTitle: '旧任务', status: 'accepted', message: '修改已送达当前任务', updatedAt: 1};
  it('无差异字段的旧回执仍有效', () => {
    expect(isTaskReceipt(legacy)).toBe(true);
  });
  it.each([
    [{target: '', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: []}],
    [{target: '页', changed: [], preserved: []}],
    [{target: '页', changed: [{attribute: '字体', from: '', to: '宋体'}], preserved: []}],
    [{target: '页', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: ['x'.repeat(33)]}],
  ])('畸形差异字段被拒绝：%j', diff => {
    expect(isTaskReceipt({...legacy, diff: diff as never})).toBe(false);
  });
  it('合法差异字段通过校验', () => {
    expect(isTaskReceipt({...legacy, status: 'applied', diff: {target: '文章', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: ['显示模式']}})).toBe(true);
  });
});
