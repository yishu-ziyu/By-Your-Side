export const CURSOR_SPOT_SAVE = "CURSOR_SPOT_SAVE";

export const CURSOR_SPOT_TAKE = "CURSOR_SPOT_TAKE";

export type CursorSpot = { id: string; x: number; y: number };

function isCursorSpot(value: unknown): value is CursorSpot {
  if (typeof value !== "object" || value === null) return false;
  const { id, x, y } = value as Record<string, unknown>;

  return typeof id === "string" && id.length <= 64 && typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
}

export function isCursorSpots(value: unknown): value is CursorSpot[] {
  return Array.isArray(value) && value.length <= 16 && value.every(isCursorSpot);
}
