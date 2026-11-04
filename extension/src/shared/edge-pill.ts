export type EdgePill = { state: 'running' | 'paused' | 'error'; goal: string } | null;

export function isEdgePill(value: unknown): value is EdgePill {
  if (value === null) return true;
  const v = value as { state?: unknown; goal?: unknown } | undefined;

  return typeof v === 'object' && (v.state === 'running' || v.state === 'paused' || v.state === 'error') && typeof v.goal === 'string';
}

export const EDGE_PILL_SHOW = 'EDGE_PILL_SHOW';

export const EDGE_PILL_GET = 'EDGE_PILL_GET';

export const EDGE_PILL_OPEN = 'EDGE_PILL_OPEN';

export type EdgeTaskStep = { text: string; state: 'done' | 'failed' | 'unknown' | 'now' };
export type EdgeTask = { goal: string; startedAt: number; steps: EdgeTaskStep[] } | null;

export function isEdgeTask(value: unknown): value is EdgeTask {
  if (value === null) return true;
  const v = value as { goal?: unknown; startedAt?: unknown; steps?: unknown } | undefined;

  return typeof v === 'object' && typeof v.goal === 'string' && typeof v.startedAt === 'number' && Array.isArray(v.steps)
    && v.steps.every(s => typeof s?.text === 'string' && ['done', 'failed', 'unknown', 'now'].includes(s?.state));
}

export const EDGE_TASK_STEER = 'EDGE_TASK_STEER';

export const EDGE_TASK_ABORT = 'EDGE_TASK_ABORT';
