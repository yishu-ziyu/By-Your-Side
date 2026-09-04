/**
 * 虚拟光标视觉常量（tldraw 协作光标：色填 + 白描边 + 深色外晕 + 名牌）。
 * 从 27px/1.6 描边加大，保证浅色、深色、花哨背景上都压得住。
 */

export const CURSOR_SVG_SIZE = 36;
export const CURSOR_STROKE_WHITE = 2.2;
export const CURSOR_STROKE_HALO = 3.8;
export const CURSOR_TIP = { x: 4.037, y: 4.688 };
export const CURSOR_ARROW_PATH =
  "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z";

/** 并行实例调色板，按 for(id) 首次出现的顺序取色。主实例恒为品牌蓝。 */
export const CURSOR_PALETTE = ["#2f6fed", "#e2554f", "#16a34a", "#9333ea", "#d97706"] as const;

export function cursorColor(id: string, existingCount: number): string {
  if (id === "main") return CURSOR_PALETTE[0];
  return CURSOR_PALETTE[existingCount % CURSOR_PALETTE.length] ?? CURSOR_PALETTE[0];
}
