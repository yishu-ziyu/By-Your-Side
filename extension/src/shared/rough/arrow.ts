import { jitter, toPath, type Pt } from "./geometry.js";
import { mulberry32 } from "./prng.js";

export interface RectBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface ArrowOutline {
  shaft: string;
  head: string;
  start: Point2D;
  end: Point2D;
}

export interface GuideBubblePlacement {
  left: number;
  top: number;
  box: RectBox;
}

export const GUIDE_SPOTLIGHT_ALPHA = 0.13;

export const GUIDE_DRAW_MS = 360;

export const GUIDE_ARROW_CURVE_PX = 26;

export const GUIDE_ROUGHNESS = 0.9;

export type GuideOffscreenDirection = "above" | "below" | "left" | "right";

export function classifyViewportVisibility(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): GuideOffscreenDirection | null {
  if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  if (bottom <= 0) return "above";
  if (rect.y >= viewport.height) return "below";
  if (right <= 0) return "left";
  if (rect.x >= viewport.width) return "right";

  return null;
}

function intersectArea(a: RectBox, b: RectBox): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  return x * y;
}

function boxAnchor(fromBox: RectBox, toPt: Point2D, inset = 0): Point2D {
  const cx = fromBox.x + fromBox.w / 2;
  const cy = fromBox.y + fromBox.h / 2;
  const dx = toPt.x - cx;
  const dy = toPt.y - cy;
  const hw = Math.max(1, fromBox.w / 2 + inset);
  const hh = Math.max(1, fromBox.h / 2 + inset);
  const scale = Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh, 0.001);

  return { x: cx + dx / scale, y: cy + dy / scale };
}

export function sketchArrow(
  bubble: RectBox,
  targetFrame: RectBox,
  options?: { seed?: number; roughness?: number; curvePx?: number },
): ArrowOutline | null {
  const seed = options?.seed ?? 1;
  const roughness = options?.roughness ?? GUIDE_ROUGHNESS;
  const curvePx = options?.curvePx ?? GUIDE_ARROW_CURVE_PX;

  const tCenter = { x: targetFrame.x + targetFrame.w / 2, y: targetFrame.y + targetFrame.h / 2 };
  const bCenter = { x: bubble.x + bubble.w / 2, y: bubble.y + bubble.h / 2 };
  const start = boxAnchor(bubble, tCenter, 4);
  const end = boxAnchor(targetFrame, start, 6);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 14) return null;

  const sign = bCenter.x >= tCenter.x ? -1 : 1;
  const bend = Math.min(curvePx, dist * 0.34) * sign;
  const mx = (start.x + end.x) / 2 + (-dy / dist) * bend;
  const my = (start.y + end.y) / 2 + (dx / dist) * bend;

  const steps = Math.max(8, Math.ceil(dist / 10));
  const pts: Pt[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * start.x + 2 * u * t * mx + t * t * end.x,
      u * u * start.y + 2 * u * t * my + t * t * end.y,
    ]);
  }

  const rand = mulberry32(seed + 131);
  const amp = 0.85 * roughness;
  const shaft = toPath(jitter(pts, rand, amp), false);

  const ang = Math.atan2(end.y - my, end.x - mx);
  const headLen = Math.min(13, Math.max(9.5, dist * 0.18));
  const spread = 0.5;
  const w1: Pt = [end.x - headLen * Math.cos(ang - spread), end.y - headLen * Math.sin(ang - spread)];
  const w2: Pt = [end.x - headLen * Math.cos(ang + spread), end.y - headLen * Math.sin(ang + spread)];
  const headPts = jitter([w1, [end.x, end.y], w2], rand, amp * 0.5);
  const head = `M${headPts[0]![0].toFixed(2)} ${headPts[0]![1].toFixed(2)} L${headPts[1]![0].toFixed(2)} ${headPts[1]![1].toFixed(2)} L${headPts[2]![0].toFixed(2)} ${headPts[2]![1].toFixed(2)}`;

  return { shaft, head, start, end };
}

function buildCandidates(target: RectBox, size: { w: number; h: number }, viewport: RectBox): Point2D[] {
  const out: Point2D[] = [];

  for (const gap of [58, 86, 120]) {
    out.push(
      { x: target.x - size.w - gap, y: target.y + target.h + 30 },
      { x: target.x + target.w + gap, y: target.y + target.h + 24 },
      { x: target.x + target.w / 2 - size.w / 2, y: target.y + target.h + gap },
      { x: target.x + target.w - size.w - 32, y: target.y + target.h + gap },
      { x: target.x - size.w - gap, y: target.y + (target.h - size.h) / 2 },
      { x: target.x + target.w + gap, y: target.y + (target.h - size.h) / 2 },
      { x: target.x, y: target.y - size.h - gap },
      { x: target.x - size.w - gap, y: target.y - size.h - 24 },
    );
  }

  out.push(
    { x: viewport.x + viewport.w - size.w, y: viewport.y + viewport.h - size.h },
    { x: viewport.x, y: viewport.y + viewport.h - size.h },
    { x: viewport.x, y: viewport.y },
  );

  return out;
}

export function placeGuideBubble(
  targetFrame: RectBox,
  bubbleSize: { w: number; h: number },
  viewport: RectBox,
  obstacles: readonly RectBox[],
  options?: { cursorPoint?: Point2D; margin?: number },
): GuideBubblePlacement {
  const margin = options?.margin ?? 12;
  const minX = viewport.x + margin;
  const minY = viewport.y + margin;
  const maxX = Math.max(minX, viewport.x + viewport.w - margin - bubbleSize.w);
  const maxY = Math.max(minY, viewport.y + viewport.h - margin - bubbleSize.h);
  const paddedTarget: RectBox = {
    x: targetFrame.x - 14,
    y: targetFrame.y - 14,
    w: targetFrame.w + 28,
    h: targetFrame.h + 28,
  };
  const cursorBox: RectBox | null = options?.cursorPoint
    ? { x: options.cursorPoint.x - 10, y: options.cursorPoint.y - 10, w: 32, h: 32 }
    : null;

  const candidates = buildCandidates(targetFrame, bubbleSize, { x: minX, y: minY, w: maxX - minX + bubbleSize.w, h: maxY - minY + bubbleSize.h });
  let best: { box: RectBox; score: number } | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i]!;
    const x = Math.max(minX, Math.min(raw.x, maxX));
    const y = Math.max(minY, Math.min(raw.y, maxY));
    const box: RectBox = { x, y, w: bubbleSize.w, h: bubbleSize.h };
    const targetHit = intersectArea(box, paddedTarget);
    const cursorHit = cursorBox ? intersectArea(box, cursorBox) : 0;
    let obstacleHit = 0;

    for (const obs of obstacles) obstacleHit += intersectArea(box, obs);
    const gapX = Math.max(0, Math.max(targetFrame.x - (x + box.w), x - (targetFrame.x + targetFrame.w)));
    const gapY = Math.max(0, Math.max(targetFrame.y - (y + box.h), y - (targetFrame.y + targetFrame.h)));
    const edgeGap = Math.hypot(gapX, gapY);
    const tooClose = edgeGap < 40 ? (40 - edgeGap) * 40 : 0;
    const score = targetHit * 260 + cursorHit * 90 + obstacleHit * 24 + tooClose + Math.abs(edgeGap - 76) * 1.2 + i * 1.2;

    if (!best || score < best.score) best = { box, score };
  }

  const chosen = best?.box ?? { x: minX, y: minY, w: bubbleSize.w, h: bubbleSize.h };

  return { left: Math.round(chosen.x), top: Math.round(chosen.y), box: chosen };
}
