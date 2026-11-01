/** 侧栏关着时的整轮任务状态，画在页面右边缘的胶囊上：后台与内容脚本共用的消息。 */

export type EdgePill = { state: 'running' | 'paused' | 'error'; goal: string } | null;

export function isEdgePill(value: unknown): value is EdgePill {
  if (value === null) return true;
  const v = value as { state?: unknown; goal?: unknown } | undefined;

  return typeof v === 'object' && (v.state === 'running' || v.state === 'paused' || v.state === 'error') && typeof v.goal === 'string';
}

/** 后台 → 页面：整轮任务状态（pill 为 null 时没有），voice 为真表示按住说话的胶囊正在这一页。 */
export const EDGE_PILL_SHOW = 'EDGE_PILL_SHOW';

/** 页面 → 后台：页面刚加载，问现在该不该显示。 */
export const EDGE_PILL_GET = 'EDGE_PILL_GET';

/** 页面 → 后台：用户点了胶囊，打开侧栏。 */
export const EDGE_PILL_OPEN = 'EDGE_PILL_OPEN';

/** 胶囊展开成进度卡时的内容：这一轮的目标、开始时刻、最近几步（now 是正在做的那一步）。侧栏开没开都给。 */
export type EdgeTaskStep = { text: string; state: 'done' | 'failed' | 'unknown' | 'now' };
export type EdgeTask = { goal: string; startedAt: number; steps: EdgeTaskStep[] } | null;

export function isEdgeTask(value: unknown): value is EdgeTask {
  if (value === null) return true;
  const v = value as { goal?: unknown; startedAt?: unknown; steps?: unknown } | undefined;

  return typeof v === 'object' && typeof v.goal === 'string' && typeof v.startedAt === 'number' && Array.isArray(v.steps)
    && v.steps.every(s => typeof s?.text === 'string' && ['done', 'failed', 'unknown', 'now'].includes(s?.state));
}

/** 页面 → 后台：进度卡里补的一句，交给正在跑的这一轮（和侧栏里任务进行中打字同一条路）。 */
export const EDGE_TASK_STEER = 'EDGE_TASK_STEER';

/** 页面 → 后台：进度卡上的「停止」，整轮停下（胶囊上的方块键是接管，不是这个）。 */
export const EDGE_TASK_ABORT = 'EDGE_TASK_ABORT';
