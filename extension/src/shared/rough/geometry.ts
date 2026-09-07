import { mulberry32 } from "./prng.js";

export interface RoughOptions {
  seed: number;
  roughness: number;
  boil?: number;
  boilSeed?: number;
}

export type Pt = [number, number];

export function sampleLine(x1: number, y1: number, x2: number, y2: number, step = 8): Pt[] {
  const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
  return Array.from({ length: n + 1 }, (_, i) => [
    x1 + ((x2 - x1) * i) / n,
    y1 + ((y2 - y1) * i) / n,
  ]);
}

export function ellipsePoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  n: number,
): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

export function jitter(points: Pt[], rand: () => number, amp: number): Pt[] {
  return points.map(([x, y]) => [x + (rand() * 2 - 1) * amp, y + (rand() * 2 - 1) * amp]);
}

export function toPath(points: Pt[], close: boolean): string {
  const first = points[0];
  if (!first) return "";
  let d = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const pCurrent = points[i];
    const pNext = points[i + 1];
    if (!pCurrent || !pNext) continue;
    const [cx, cy] = pCurrent;
    const mx = (cx + pNext[0]) / 2;
    const my = (cy + pNext[1]) / 2;
    d += ` Q${cx.toFixed(2)} ${cy.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  if (last) {
    d += ` L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
  }
  return close ? d + " Z" : d;
}

export function boilPass(points: Pt[], o: RoughOptions): Pt[] {
  if (!o.boil || o.boilSeed === undefined) return points;
  return jitter(points, mulberry32(o.boilSeed), o.boil);
}

export function doubleStroke(points: Pt[], o: RoughOptions, close: boolean): string {
  const rand = mulberry32(o.seed);
  const amp = 1.4 * o.roughness;
  return (
    toPath(boilPass(jitter(points, rand, amp), o), close) + " " +
    toPath(boilPass(jitter(points, rand, amp * 1.3), o), close)
  );
}

/**
 * 手绘椭圆（适合圈出按钮、卡片、输入框目标）
 */
export function roughEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  o: RoughOptions,
): string {
  const h = ((rx - ry) / (rx + ry)) ** 2;
  const perimeter = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const n = Math.max(8, Math.ceil(perimeter / 8));
  return doubleStroke(ellipsePoints(cx, cy, rx, ry, 0, Math.PI * 2, n).slice(0, -1), o, true);
}

/**
 * 手绘箭头（带轻微手绘弧度的箭杆与箭头翼）
 */
export function roughArrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  o: RoughOptions,
): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 10;
  const headAngle = Math.PI / 6;
  const wing = (da: number): Pt => [
    x2 - headLen * Math.cos(a + da),
    y2 - headLen * Math.sin(a + da),
  ];
  const [lx, ly] = wing(headAngle);
  const [rx, ry] = wing(-headAngle);
  const rand = mulberry32(o.seed);
  const amp = 1.2 * o.roughness;
  const head = (px: number, py: number) =>
    toPath(boilPass(jitter(sampleLine(x2, y2, px, py, 3), rand, amp), o), false);

  const shaft = doubleStroke(sampleLine(x1, y1, x2, y2, 6), o, false);
  return shaft + " " + head(lx, ly) + " " + head(rx, ry);
}

/**
 * 手绘线条（下划线）
 */
export function roughLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  o: RoughOptions,
): string {
  return doubleStroke(sampleLine(x1, y1, x2, y2), o, false);
}

/**
 * 平头马克笔平刷（Chisel-tip Wash）：
 * 相比锯齿折返涂抹，平刷在字形周围不产生杂乱交叉折线，通透性极佳。
 */
export function chiselWash(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  o: RoughOptions,
): string {
  const rand = mulberry32(o.seed);
  const pts = sampleLine(x1, y1, x2, y2, 10);
  const jittered = jitter(pts, rand, 1.2 * o.roughness);
  return toPath(boilPass(jittered, o), false);
}

/**
 * 生成 n 帧 Boil 微抖动路径
 */
export function variants(
  gen: (o: RoughOptions) => string,
  o: RoughOptions,
  n = 3,
): string[] {
  return Array.from({ length: n }, (_, i) =>
    gen({ ...o, boilSeed: o.seed + (i + 1) * 7919 }),
  );
}
