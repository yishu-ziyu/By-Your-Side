/** 光标旁那句话的位置：固定在光标尖右下，靠边才翻到另一侧。 */
export function cursorLabelPosition(
  point: { x: number; y: number }, size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  // 固定挂在光标尖右下（16, 28），只随光标平移；碰到右边或下边才整体换到另一侧，不在候选位置之间来回跳。
  const right = point.x + 16;
  const below = point.y + 28;
  const x = right + size.width > viewport.width - 8 ? point.x - size.width - 12 : right;
  const y = below + size.height > viewport.height - 8 ? point.y - size.height - 12 : below;

  return { x: Math.max(8, x), y: Math.max(8, y) };
}
