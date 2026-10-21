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

