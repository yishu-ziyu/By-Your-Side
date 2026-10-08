import { CURSOR_SVG_SIZE } from "./cursor-visual.js";

/** Layout data only: this helper never reads the page or changes the Agent action. */
export type CursorLabelPlacement = "right-below" | "right-above" | "left-below" | "left-above";
type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

const LABEL_DX = Math.round(CURSOR_SVG_SIZE * 0.8);
const LABEL_DY = Math.round(CURSOR_SVG_SIZE * 1.8);
const MARGIN = 8;

function intersect(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

/**
 * The bubble belongs to the cursor, but should not hide its actual target.
 * Prefer one corner; flip only when the viewport or action target requires it.
 * Returning placement lets the renderer resist jitter when the cursor moves.
 */
export function cursorLabelPosition(
  point: Point,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  target?: Rect,
  previous?: CursorLabelPlacement,
): Point & { placement: CursorLabelPlacement } {
  const candidates: Array<{ placement: CursorLabelPlacement; x: number; y: number }> = [
    { placement: "right-below", x: point.x + LABEL_DX, y: point.y + LABEL_DY },
    { placement: "right-above", x: point.x + LABEL_DX, y: point.y - size.height - LABEL_DY },
    { placement: "left-below", x: point.x - size.width - LABEL_DX, y: point.y + LABEL_DY },
    { placement: "left-above", x: point.x - size.width - LABEL_DX, y: point.y - size.height - LABEL_DY },
  ];
  const padded = target && {
    x: target.x - 4,
    y: target.y - 4,
    width: target.width + 8,
    height: target.height + 8,
  };

  const scored = candidates.map((p, index) => {
    const overflow =
      Math.max(0, MARGIN - p.x) + Math.max(0, p.x + size.width - (viewport.width - MARGIN)) +
      Math.max(0, MARGIN - p.y) + Math.max(0, p.y + size.height - (viewport.height - MARGIN));
    const x = Math.max(MARGIN, Math.min(p.x, viewport.width - MARGIN - size.width));
    const y = Math.max(MARGIN, Math.min(p.y, viewport.height - MARGIN - size.height));
    const covering = padded ? intersect({ x, y, width: size.width, height: size.height }, padded) : 0;

    return {
      ...p, x, y,
      score: (overflow > 0 ? 100000 + overflow * 100 : 0)
        + (covering > 0 ? 10000 + covering : 0)
        + index * 4 + (previous && previous !== p.placement ? 16 : 0),
    };
  }).sort((a, b) => a.score - b.score);

  const best = scored[0]!;

  return { x: best.x, y: best.y, placement: best.placement };
}
