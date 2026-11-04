import { ellipsePoints, jitter, sampleLine, toPath, boilPass, type Pt, type RoughOptions } from "./geometry.js";
import { mulberry32 } from "./prng.js";

interface Box { x: number; y: number; w: number; h: number }

interface SketchOutline { d: string; frame: Box }

interface LabelPosition { left: number; top: number }

const WIDE_RATIO = 3.2;

function roundedRectPoints(b: Box, r: number): Pt[] {
  const n = 5;
  const { x, y, w, h } = b;

  return [
    ...sampleLine(x + r, y, x + w - r, y),
    ...ellipsePoints(x + w - r, y + r, r, r, -Math.PI / 2, 0, n),
    ...sampleLine(x + w, y + r, x + w, y + h - r),
    ...ellipsePoints(x + w - r, y + h - r, r, r, 0, Math.PI / 2, n),
    ...sampleLine(x + w - r, y + h, x + r, y + h),
    ...ellipsePoints(x + r, y + h - r, r, r, Math.PI / 2, Math.PI, n),
    ...sampleLine(x, y + h - r, x, y + r),
    ...ellipsePoints(x + r, y + r, r, r, Math.PI, Math.PI * 1.5, n),
  ];
}

export function sketchFrame(target: Box, o: RoughOptions): SketchOutline {
  const rand = mulberry32(o.seed);
  const amp = 1.1 * o.roughness;

  if (target.w / Math.max(1, target.h) > WIDE_RATIO) {
    const pad = 4;
    const frame = { x: target.x - pad, y: target.y - pad, w: target.w + pad * 2, h: target.h + pad * 2 };

    return { d: toPath(boilPass(jitter(roundedRectPoints(frame, Math.min(10, frame.h / 2)), rand, amp), o), true), frame };
  }

  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const rx = (target.w / 2) * 1.25 + 4;
  const ry = (target.h / 2) * 1.25 + 4;
  const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / 8));

  return { d: toPath(boilPass(jitter(ellipsePoints(cx, cy, rx, ry, 0, Math.PI * 2, n).slice(0, -1), rand, amp), o), true), frame: { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 } };
}

interface LabelRoom { inView(b: Box): boolean; clear(b: Box): boolean }

export function sketchLabelPosition(frame: Box, label: { w: number; h: number }, room: LabelRoom): LabelPosition {
  const gap = 8;
  const above = frame.y - label.h - 2;
  const below = frame.y + frame.h + 2;
  const right = { left: frame.x + frame.w + gap, top: frame.y + frame.h / 2 - label.h / 2 };
  const candidates = [right, { left: frame.x, top: above }, { left: frame.x, top: below }, { left: frame.x - gap - label.w, top: right.top }];

  const boxOf = (c: LabelPosition) => ({ x: c.left, y: c.top, w: label.w, h: label.h });
  const visible = candidates.filter((c) => room.inView(boxOf(c)));

  return visible.find((c) => room.clear(boxOf(c))) ?? visible[0] ?? right;
}
