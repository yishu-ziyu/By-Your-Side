/**
 * 光标/步骤行颜色。Lead 墨蓝（AI 专属色，与侧栏 --accent 同色）；人用名册上自己的色（shared/cast.ts）。
 */
import { LEAD_COLOR, displayColor } from "../../../shared/cast.js";

export const LEAD_CURSOR_ID = "main";

export function cursorColor(id: string): string {
  if (!id || id === LEAD_CURSOR_ID) return LEAD_COLOR;

  return displayColor(id);
}
