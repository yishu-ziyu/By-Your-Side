type CursorPt = { x: number; y: number };

const CURSOR_REST_INSET = 24;

const FITTS_MIN_MS = 220;

const FITTS_MAX_MS = 480;

export const PARK_AFTER_MS = 1200;

function fittsMs(dist: number, width = 44): number {
  const d = Math.max(0, dist);
  const w = Math.max(1, width);
  const id = Math.log2(d / w + 1);

  return Math.max(FITTS_MIN_MS, Math.min(FITTS_MAX_MS, 90 + 160 * id));
}

export function restOnRight(index: number): boolean {
  return (index < 0 ? 0 : index) % 2 === 1;
}

export function restPoint(index: number, viewportWidth: number): CursorPt {
  const right = restOnRight(index);
  const w = Math.max(CURSOR_REST_INSET * 2, viewportWidth);

  return {
    x: right ? w - CURSOR_REST_INSET : CURSOR_REST_INSET,
    y: CURSOR_REST_INSET,
  };
}

function arcControl(from: CursorPt, to: CursorPt): CursorPt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 1) return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const spread = Math.max(8, Math.min(36, dist * 0.12));

  return {
    x: (from.x + to.x) / 2 + (-dy / dist) * spread,
    y: (from.y + to.y) / 2 + (dx / dist) * spread,
  };
}

function qbez(p0: CursorPt, p1: CursorPt, p2: CursorPt, t: number): CursorPt {
  const u = 1 - t;

  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

export function pointOnArc(from: CursorPt, to: CursorPt, t: number): CursorPt {
  return qbez(from, arcControl(from, to), to, t);
}

export function flightMs(from: CursorPt, to: CursorPt): number {
  return fittsMs(Math.hypot(to.x - from.x, to.y - from.y));
}

interface Spring {
  k: number;
  c: number;
}

const SPRING_ZETA = 0.75;

export function springFor(ms: number): Spring {
  const ts = Math.max(0.05, ms / 1000);
  const wn = 6 / (SPRING_ZETA * ts);

  return { k: wn * wn, c: 2 * SPRING_ZETA * wn };
}

export function springStep(s: number, v: number, dt: number, spring: Spring): [number, number] {
  const a = (1 - s) * spring.k - v * spring.c;
  const nv = v + a * dt;

  return [s + nv * dt, nv];
}

export function springSettled(s: number, v: number): boolean {
  return Math.abs(1 - s) < 0.002 && Math.abs(v) < 0.05;
}
