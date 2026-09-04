/**
 * 并行工人光标/步骤行调色板。Lead（main）固定品牌蓝；工人跳过蓝色，按 id 稳定散列着色，
 * 使面板步骤行与页面光标颜色一致。
 */
export const CURSOR_PALETTE = ["#2f6fed", "#e2554f", "#16a34a", "#9333ea", "#d97706"] as const;
export const LEAD_CURSOR_ID = "main";

export function cursorColor(id: string): string {
  if (!id || id === LEAD_CURSOR_ID) return CURSOR_PALETTE[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const idx = 1 + (h % (CURSOR_PALETTE.length - 1));
  return CURSOR_PALETTE[idx] ?? CURSOR_PALETTE[1] ?? "#e2554f";
}
