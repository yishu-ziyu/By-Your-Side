import { ellipsePoints, jitter, sampleLine, toPath, boilPass, type Pt, type RoughOptions } from "./geometry.js";
import { mulberry32 } from "./prng.js";

export interface Box { x: number; y: number; w: number; h: number }

/** 手绘外框：SVG 路径和它实际占的范围（名牌据此摆放）。 */
export interface SketchOutline { d: string; frame: Box }

/** 名牌相对标注外框的位置。 */
export interface LabelPosition { left: number; top: number }

/** 宽高比超过它就画圆角框：宽而扁的目标（整行、长文字）用椭圆会切角、会压到相邻行。 */
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

/**
 * 手绘外框：宽而扁的目标画贴合的圆角框（外扩 4px），紧凑目标画贴合的圈。只画一笔，
 * 不再叠两笔、不带箭头。返回路径和外框，外框用来摆名牌。
 */
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

/**
 * 名牌摆在框外右侧、与框垂直居中，不压住任何文字；右边放不下才退到框外左上。
 * roomRight：框右边到可见区域右边的距离；minLeft：左上时名牌最左能放到哪（保持在可见区域内）。
 */
export function sketchLabelPosition(frame: Box, labelWidth: number, roomRight: number, minLeft: number): LabelPosition {
  const gap = 8;
  const labelHeight = 20;

  if (roomRight >= labelWidth + gap * 2) return { left: frame.x + frame.w + gap, top: frame.y + frame.h / 2 - labelHeight / 2 };

  return { left: Math.max(frame.x, minLeft), top: frame.y - labelHeight - 2 };
}
