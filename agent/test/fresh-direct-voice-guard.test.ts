/**
 * 停止任务后的直连语音/display 请求不为旧任务的“已取消”生命周期买单（试用问题 1 反例）：
 * - freshDirect（display-* 调用）只豁免 cancelled 这一条生命周期原因；
 * - 未知写入、重复回执、运行时错误、失败边界等真实安全约束照旧生效；
 * - 非直连调用（任务族）在 state=aborted 时仍按原样拒绝。
 */
import { describe, expect, it } from 'vitest';
import { assertTaskStepExecution } from '../../shared/task-next-step.js';
import type { TaskProgressSnapshot } from '../../shared/voice.js';

const aborted = (results: TaskProgressSnapshot['results'] = []) =>
  ({ state: 'aborted', runId: 'run-old', results }) as unknown as TaskProgressSnapshot;

const unknownTranslation = [{
  id: 'r-unknown-1',
  status: 'unknown' as const,
  tool: 'page_translation',
  target: null,
  description: '翻译整页',
  evidence: { toolCallId: 'display-lost-1' },
}];

const unknownClick: NonNullable<TaskProgressSnapshot['results']> = [{
  id: 'r-unknown-2',
  status: 'unknown',
  tool: 'click',
  target: '#submit',
  description: '点击「提交订单」',
  evidence: { toolCallId: 'display-lost-2', tool: 'click', target: '#submit', member: 'main', runId: 'run-old' },
}];

describe('停止任务后的直连请求守卫', () => {
  it('任务族调用在已中止状态下仍被拒（原语义不变）', () => {
    expect(() => assertTaskStepExecution(aborted(), 'switch_tab', { tabId: 9 }))
      .toThrow('原任务已取消，操作未执行。');
  });

  it('直连新请求豁免“已取消”生命周期：无未知写入时放行', () => {
    expect(() => assertTaskStepExecution(aborted(), 'switch_tab', { tabId: 9 }, false, true)).not.toThrow();
  });

  // 10-01 用户裁决（docs/evals/20261001-unknown-lock-scope.md）：结果不确定只拦可能重复造成后果的操作。
  // 原用例拿「翻译整页」未知去拦切换标签页；翻译与换页都不会重复造成后果，改为未知点击拦直连点击，切页照常。
  it('直连新请求照常受未知写入保护：给出可执行的核查指引而不是死胡同', () => {
    expect(() => assertTaskStepExecution(aborted(unknownClick), 'click', { target: '#pay' }, false, true))
      .toThrow(/当前写入已暂停[\s\S]*不得盲目重试/);
    expect(() => assertTaskStepExecution(aborted(unknownClick), 'switch_tab', { tabId: 9 }, false, true)).not.toThrow();
    expect(() => assertTaskStepExecution(aborted(unknownTranslation as never), 'switch_tab', { tabId: 9 }, false, true)).not.toThrow();
  });

  it('直连读取本来就放行（写闸不作用于只读）', () => {
    expect(() => assertTaskStepExecution(aborted(unknownTranslation as never), 'list_tabs', {}, false, true)).not.toThrow();
    expect(() => assertTaskStepExecution(aborted(unknownTranslation as never), 'list_tabs', {})).not.toThrow();
  });
});
