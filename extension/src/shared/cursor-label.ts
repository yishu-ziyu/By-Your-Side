type Rect = { x: number; y: number; width: number; height: number };

/** 名牌贴近光标，但优先避开当前操作对象；没有足够空间时选重叠最小的位置。 */
export function cursorLabelPosition(
  point: { x: number; y: number }, size: { width: number; height: number },
  viewport: { width: number; height: number }, target?: Rect,
): { x: number; y: number } {
  const gap = 12;
  const clamp = (x: number, max: number) => Math.max(8, Math.min(x, max - 8));
  const candidates = [
    { x: point.x + 28, y: point.y + 28 },
    { x: point.x + 28, y: point.y - size.height - gap },
    { x: point.x - size.width - gap, y: point.y + 28 },
    ...(target ? [
      { x: point.x - size.width / 2, y: target.y + target.height + gap },
      { x: point.x - size.width / 2, y: target.y - size.height - gap },
      { x: target.x + target.width + gap, y: point.y - size.height / 2 },
      { x: target.x - size.width - gap, y: point.y - size.height / 2 },
    ] : []),
  ].map(p => ({ x: clamp(p.x, viewport.width - size.width), y: clamp(p.y, viewport.height - size.height) }));
  const overlap = (p: { x: number; y: number }) => target
    ? Math.max(0, Math.min(p.x + size.width, target.x + target.width + 6) - Math.max(p.x, target.x - 6)) *
      Math.max(0, Math.min(p.y + size.height, target.y + target.height + 6) - Math.max(p.y, target.y - 6))
    : 0;
  // 保持固定候选顺序，避免移动过程中名牌在等距位置之间来回跳。
  return candidates.find(p => overlap(p) === 0) ?? candidates.sort((a, b) => overlap(a) - overlap(b))[0]!;
}
