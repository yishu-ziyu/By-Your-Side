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
