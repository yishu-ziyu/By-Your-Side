/** 侧栏关着时页面右边缘的小药丸：后台与内容脚本共用的消息。 */

export type EdgePill = { state: 'running' | 'paused' | 'error'; goal: string } | null;

/** 后台 → 页面：显示或隐藏（pill 为 null）。 */
export const EDGE_PILL_SHOW = 'EDGE_PILL_SHOW';

/** 页面 → 后台：页面刚加载，问现在该不该显示。 */
export const EDGE_PILL_GET = 'EDGE_PILL_GET';

/** 页面 → 后台：用户点了「打开侧栏」。 */
export const EDGE_PILL_OPEN = 'EDGE_PILL_OPEN';
