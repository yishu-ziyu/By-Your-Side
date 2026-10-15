/**
 * 换页接力：助手在一个标签页里干活时点了链接，旧网页把光标停的位置交给后台，
 * 下一个网页的光标从同一个点出现，像真鼠标留在屏幕原处，不先回角落再飞出去。
 */
export const CURSOR_SPOT_SAVE = "CURSOR_SPOT_SAVE";

export const CURSOR_SPOT_TAKE = "CURSOR_SPOT_TAKE";

/** id 是光标实例名（成员），x、y 是视口坐标。 */
export type CursorSpot = { id: string; x: number; y: number };

function isCursorSpot(value: unknown): value is CursorSpot {
  if (typeof value !== "object" || value === null) return false;
  const { id, x, y } = value as Record<string, unknown>;

  return typeof id === "string" && id.length <= 64 && typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
}

export function isCursorSpots(value: unknown): value is CursorSpot[] {
  return Array.isArray(value) && value.length <= 16 && value.every(isCursorSpot);
}
