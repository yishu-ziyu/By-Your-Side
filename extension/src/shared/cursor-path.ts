/**
 * Agent 光标轨迹：浅弧 + Fitts 时长。
 * 出处：ghost-cursor 一侧弧（去掉随机）/ CursorBuddy 飞弧；
 * Fitts 定律定时长（HCI 1954，ghost-cursor / agentcursor 也用）；
 * easeInOutCubic 是 tldraw 给自主移动的曲线。
 * 不是 WindMouse / 过冲 / 拖尾。
 */

export type CursorPt = { x: number; y: number };

export const CURSOR_REST_INSET = 24;
export const FITTS_MIN_MS = 220;
export const FITTS_MAX_MS = 480;
export const PARK_AFTER_MS = 320;

export function easeInOutCubic(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function fittsMs(dist: number, width = 44): number {
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

export function arcControl(from: CursorPt, to: CursorPt): CursorPt {
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

export function qbez(p0: CursorPt, p1: CursorPt, p2: CursorPt, t: number): CursorPt {
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
