import { CURSOR_SVG_SIZE } from "./cursor-visual.js";

/** 光标尖到箭头下沿的距离（箭头在 24 格里占 4.7→21.3）；话框与箭头之间留 4px。 */
const LABEL_DX = Math.round(CURSOR_SVG_SIZE * 16 / 35);

const LABEL_DY = Math.round(CURSOR_SVG_SIZE * 0.69) + 4;

/** 光标旁那句话的位置：固定在光标尖右下，靠边才翻到另一侧。 */
export function cursorLabelPosition(
  point: { x: number; y: number }, size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  // 固定挂在光标尖右下（35px 时是 16, 28；随光标尺寸等比），只随光标平移；碰到右边或下边才整体换到另一侧，不在候选位置之间来回跳。
  const right = point.x + LABEL_DX;
  const below = point.y + LABEL_DY;
  const x = right + size.width > viewport.width - 8 ? point.x - size.width - 12 : right;
  const y = below + size.height > viewport.height - 8 ? point.y - size.height - 12 : below;

  return { x: Math.max(8, x), y: Math.max(8, y) };
}
