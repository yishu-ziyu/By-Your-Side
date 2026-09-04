/**
 * 光标/步骤行颜色。Lead 品牌蓝；人用名册上自己的色（shared/cast.ts）。
 */
import { LEAD_COLOR, displayColor } from "../../../shared/cast.js";

export const CURSOR_PALETTE = ["#2f6fed", "#e2554f", "#16a34a", "#9333ea", "#d97706"] as const;
export const LEAD_CURSOR_ID = "main";

export function cursorColor(id: string): string {
  if (!id || id === LEAD_CURSOR_ID) return LEAD_COLOR;
  return displayColor(id);
}
