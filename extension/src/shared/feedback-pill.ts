/**
 * 执行反馈胶囊的纯状态：同一结果（id）重绘不重复回弹；两次独立成功各回弹一次。
 * 动效与 DOM 在 content/cursor.ts；这里只决定「要不要回弹、展示多久、谁覆盖谁」。
 */
const EXECUTION_FEEDBACK_KINDS = ['success', 'pending', 'unknown', 'failure'] as const;

export type FeedbackPillKind = (typeof EXECUTION_FEEDBACK_KINDS)[number];

/** 成功短暂展示后收起；等待/未知/失败保留久一点，作为可找到的文字入口。 */
const FEEDBACK_SUCCESS_MS = 2400;

const FEEDBACK_PENDING_MS = 12_000;

export interface FeedbackPillView {
  id: string;
  text: string;
  kind: FeedbackPillKind;
  detail?: string;
}

export function feedbackLifetimeMs(kind: FeedbackPillKind): number {
  return kind === 'success' ? FEEDBACK_SUCCESS_MS : FEEDBACK_PENDING_MS;
}

/** 旧反馈不能覆盖新反馈：更早的结果到达时直接丢弃。 */
export function feedbackIsStale(previousAt: number | undefined, nextAt: number): boolean {
  return previousAt !== undefined && nextAt < previousAt;
}
