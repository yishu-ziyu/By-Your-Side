import { describe, expect, it } from 'vitest';
import { beginFeedbackPill, feedbackIsStale, feedbackLifetimeMs, FEEDBACK_PENDING_MS, FEEDBACK_SUCCESS_MS } from '../src/shared/feedback-pill.js';

describe('执行反馈胶囊状态', () => {
  it('新结果回弹一次；同一结果重绘不重复回弹', () => {
    const first = beginFeedbackPill(null, { id: 'tool:1', text: '切好了', kind: 'success' }, 1_000);
    expect(first.bounce).toBe(true);
    expect(first.state).toMatchObject({ bounces: 1, shownAt: 1_000 });

    const redraw = beginFeedbackPill(first.state, { id: 'tool:1', text: '切好了', kind: 'success' }, 1_200);
    expect(redraw.bounce).toBe(false);
    expect(redraw.state).toMatchObject({ bounces: 1, shownAt: 1_000 });
  });

  it('两次独立成功各回弹一次', () => {
    const first = beginFeedbackPill(null, { id: 'tool:1', text: '切好了', kind: 'success' }, 1_000);
    const second = beginFeedbackPill(first.state, { id: 'tool:2', text: '切好了', kind: 'success' }, 2_000);
    expect(second.bounce).toBe(true);
    expect(second.state).toMatchObject({ bounces: 1, shownAt: 2_000 });
  });

  it('成功短暂展示，待处理保留更久', () => {
    expect(feedbackLifetimeMs('success')).toBe(FEEDBACK_SUCCESS_MS);
    for (const kind of ['pending', 'unknown', 'failure'] as const) {
      expect(feedbackLifetimeMs(kind)).toBe(FEEDBACK_PENDING_MS);
    }
    expect(FEEDBACK_PENDING_MS).toBeGreaterThan(FEEDBACK_SUCCESS_MS);
  });

  it('更旧的结果不能覆盖更新的', () => {
    expect(feedbackIsStale(undefined, 1_000)).toBe(false);
    expect(feedbackIsStale(2_000, 1_500)).toBe(true);
    expect(feedbackIsStale(2_000, 2_000)).toBe(false);
    expect(feedbackIsStale(2_000, 2_500)).toBe(false);
  });
});
