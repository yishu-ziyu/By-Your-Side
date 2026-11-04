const EXECUTION_FEEDBACK_KINDS = ['success', 'pending', 'unknown', 'failure'] as const;

export type FeedbackPillKind = (typeof EXECUTION_FEEDBACK_KINDS)[number];

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

export function feedbackIsStale(previousAt: number | undefined, nextAt: number): boolean {
  return previousAt !== undefined && nextAt < previousAt;
}
