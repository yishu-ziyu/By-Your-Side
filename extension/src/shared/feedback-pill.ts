/**
 * 执行反馈胶囊的纯状态：同一结果（id）重绘不重复回弹；两次独立成功各回弹一次。
 * 动效与 DOM 在 content/cursor.ts；这里只决定「要不要回弹、展示多久、谁覆盖谁」。
 */
export const EXECUTION_FEEDBACK_KINDS = ['success', 'pending', 'unknown', 'failure'] as const;

export type FeedbackPillKind = (typeof EXECUTION_FEEDBACK_KINDS)[number];

/** 成功短暂展示后收起；等待/未知/失败保留久一点，作为可找到的文字入口。 */
export const FEEDBACK_SUCCESS_MS = 2400;

export const FEEDBACK_PENDING_MS = 12_000;

export const FEEDBACK_TEXT_MAX = 60;

export interface FeedbackPillView {
  id: string;
  text: string;
  kind: FeedbackPillKind;
  detail?: string;
}

export interface FeedbackPillState extends FeedbackPillView {
  /** 当前这条展示期间实际播过的回弹次数；同一 id 重绘不增加。 */
  bounces: number;
  shownAt: number;
}

export function feedbackLifetimeMs(kind: FeedbackPillKind): number {
  return kind === 'success' ? FEEDBACK_SUCCESS_MS : FEEDBACK_PENDING_MS;
}

/** 新反馈替换旧反馈：id 变化才是新一次独立结果（回弹一次），同 id 只是重绘。 */
export function beginFeedbackPill(
  previous: FeedbackPillState | null,
  next: FeedbackPillView,
  at: number,
): { state: FeedbackPillState; bounce: boolean } {
  if (!previous) {
    return { state: { ...next, bounces: 1, shownAt: at }, bounce: true };
  }

  const bounce = previous.id !== next.id;

  return {
    state: {
      ...next,
      bounces: bounce ? 1 : previous.bounces,
      shownAt: bounce ? at : previous.shownAt,
    },
    bounce,
  };
}

/** 旧反馈不能覆盖新反馈：更早的结果到达时直接丢弃。 */
export function feedbackIsStale(previousAt: number | undefined, nextAt: number): boolean {
  return previousAt !== undefined && nextAt < previousAt;
}
