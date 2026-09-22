/**
 * 反馈分类的宿主事实边界（纯函数）：
 * 只有 executed 才可能生成成功短语；unknown／not_executed 不升级；没有真实调用身份就不生成记录。
 */
import { describe, expect, it } from 'vitest';
import { classifyDirectExecutionFeedback, executionFeedbackKey, isExecutionFeedback } from '../../shared/execution-feedback.js';

const base = { tool: 'tabs', args: { action: 'switch', tabId: 21 }, inputId: 'voice:u1', toolCallId: 'display-1', at: 1_000 };

describe('执行反馈分类', () => {
  it('切标签成功：具体短语、一次回弹、仅动作自身可由胶囊结束', () => {
    const feedback = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed',
      data: { tabId: 21, verification: { verified: true, activeTabId: 21, windowId: 3, windowFocused: true, workingTabId: 21 } } });

    expect(feedback).toMatchObject({
      id: 'tool:display-1', channel: 'capsule', kind: 'success', text: '切好了', bounce: true, capsuleCanCloseAction: true,
      facts: { tool: 'tabs', action: 'switch', executionFact: 'executed', tabId: 21 },
    });
    expect(isExecutionFeedback(feedback)).toBe(true);
  });

  it('填入成功：内容核对一致才给成功回执，且不静音（还没保存这类部分成果仍要能说）', () => {
    const feedback = classifyDirectExecutionFeedback({ tool: 'fill', args: { target: '@4', value: 'x' }, executionFact: 'executed', data: { filled: true, verified: true }, inputId: 'voice:u1', toolCallId: 'display-2' });
    expect(feedback).toMatchObject({ kind: 'success', text: '已填入', bounce: true, capsuleCanCloseAction: false });
  });

  it('R3 切页/填写证据门槛：缺结果、矛盾、未核对不给成功文案，执行事实保持原值', () => {
    // executed 但回执缺少具体结果
    const missing = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed', data: {} });
    expect(missing).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
    expect(missing?.facts.executionFact).toBe('executed');
    // 请求 tabId 21，回执指向其它页
    const mismatch = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed', data: { tabId: 7 } });
    expect(mismatch).toMatchObject({ kind: 'unknown', text: '结果待确认' });
    expect(mismatch?.facts.tabId).toBe(7);
    expect(String(mismatch?.facts.detail ?? '')).toContain('21');
    expect(String(mismatch?.facts.detail ?? '')).toContain('7');
    // fill 已执行但内容未核对／明确不匹配
    const unverified = classifyDirectExecutionFeedback({ tool: 'fill', args: { target: '@4', value: 'x' }, executionFact: 'executed', data: { filled: true }, inputId: 'voice:u1', toolCallId: 'display-5' });
    expect(unverified).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false });
    expect(unverified?.text).not.toContain('已填入');
    const mismatched = classifyDirectExecutionFeedback({ tool: 'fill', args: { target: '@4', value: 'x' }, executionFact: 'executed', data: { filled: true, verified: false }, inputId: 'voice:u1', toolCallId: 'display-6' });
    expect(mismatched).toMatchObject({ kind: 'unknown', text: '结果待确认' });
    expect(String(mismatched?.facts.detail ?? '')).toContain('不一致');
  });

  it('unknown 不写成成功；not_executed 区分等待确认与未执行', () => {
    const unknown = classifyDirectExecutionFeedback({ ...base, executionFact: 'unknown' });
    expect(unknown).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
    const held = classifyDirectExecutionFeedback({ ...base, executionFact: 'not_executed', data: { held: true } });
    expect(held).toMatchObject({ kind: 'pending', text: '等你确认', bounce: false });
    const refused = classifyDirectExecutionFeedback({ ...base, executionFact: 'not_executed' });
    expect(refused).toMatchObject({ kind: 'failure', text: '没有执行', bounce: false });
  });

  it('执行后处理失败仍是待确认，不改写成完成', () => {
    const feedback = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed', failed: true });
    expect(feedback).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false });
    expect(feedback?.text).not.toContain('切好');
  });

  it('观察类工具与无身份调用不生成反馈', () => {
    expect(classifyDirectExecutionFeedback({ tool: 'snapshot', executionFact: 'executed', toolCallId: 'display-3' })).toBeNull();
    expect(classifyDirectExecutionFeedback({ tool: 'tabs', args: { action: 'list' }, executionFact: 'executed', toolCallId: 'display-4' })).toBeNull();
    expect(classifyDirectExecutionFeedback({ tool: 'tabs', args: { action: 'switch' }, executionFact: 'executed' })).toBeNull();
  });

  it('短语键按工具与动作拼，未知动作不套用成功文案', () => {
    expect(executionFeedbackKey('tabs', { action: 'switch' })).toBe('tabs:switch');
    expect(executionFeedbackKey('fill', undefined)).toBe('fill');
    expect(classifyDirectExecutionFeedback({ tool: 'tabs', args: { action: 'close' }, executionFact: 'executed', toolCallId: 'x' })).toBeNull();
  });
});

describe('V2.3 切页核验：成功必须来自执行后的真实读回', () => {
  const verified = { verified: true, activeTabId: 21, windowId: 3, windowFocused: true, workingTabId: 21 };

  it('真实核验通过（实际活动页=目标、窗口聚焦、工作目标一致）：切好了、回弹、可由胶囊闭合', () => {
    const feedback = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed', data: { tabId: 21, verification: verified } });
    expect(feedback).toMatchObject({ kind: 'success', text: '切好了', bounce: true, capsuleCanCloseAction: true });
    expect(isExecutionFeedback(feedback)).toBe(true);
  });

  it('A2 回显一致但实际活动页仍是旧页：不显示切好了、不回弹、无闭合资格', () => {
    const feedback = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed',
      data: { tabId: 21, verification: { ...verified, verified: false, activeTabId: 7 } } });

    expect(feedback).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
    expect(feedback?.text).not.toContain('切好');
    expect(feedback?.facts.executionFact).toBe('executed');
    expect(String(feedback?.facts.detail ?? '')).toContain('7');
  });

  it('旧回显回执（无核验事实）不能授权成功胶囊，但工作目标语义不改', () => {
    const feedback = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed', data: { tabId: 21 } });
    expect(feedback).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
    expect(feedback?.facts.tabId).toBe(21);
    expect(feedback?.facts.executionFact).toBe('executed');
  });

  it('目标页已激活但窗口未聚焦：用户看不到，不给成功资格', () => {
    const feedback = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed',
      data: { tabId: 21, verification: { ...verified, verified: false, windowFocused: false } } });

    expect(feedback).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
    expect(String(feedback?.facts.detail ?? '')).toContain('聚焦');
  });

  it('读回失败（只有 verified:false，无事实）：如实待确认，不编造成功', () => {
    const feedback = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed', data: { tabId: 21, verification: { verified: false } } });
    expect(feedback).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
    expect(feedback?.facts.executionFact).toBe('executed');
  });

  it('手工矛盾回执（verified:true 但事实与请求不符）仍不通过', () => {
    const lying = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed',
      data: { tabId: 21, verification: { ...verified, activeTabId: 7 } } });

    expect(lying).toMatchObject({ kind: 'unknown', capsuleCanCloseAction: false });

    const unfocused = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed',
      data: { tabId: 21, verification: { ...verified, windowFocused: false } } });

    expect(unfocused).toMatchObject({ kind: 'unknown', capsuleCanCloseAction: false });

    const drifted = classifyDirectExecutionFeedback({ ...base, executionFact: 'executed',
      data: { tabId: 21, verification: { ...verified, workingTabId: 7 } } });

    expect(drifted).toMatchObject({ kind: 'unknown', capsuleCanCloseAction: false });
  });
});

it('contract accepts only the new action-scoped field', () => {
  const feedback=classifyDirectExecutionFeedback({...base,executionFact:'executed',data:{tabId:21}})!;
  const {capsuleCanCloseAction,...rest}=feedback;
  expect(isExecutionFeedback({...rest,quietContinuation:capsuleCanCloseAction})).toBe(false);
  expect(isExecutionFeedback({...rest,capsuleCanCloseAction})).toBe(true);
});
