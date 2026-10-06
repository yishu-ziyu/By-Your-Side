/**
 * Agent 光标轨迹：浅弧 + Fitts 时长 + 欠阻尼弹簧进度。
 * 出处：ghost-cursor 一侧弧（去掉随机）/ CursorBuddy 飞弧；
 * Fitts 定律定时长（HCI 1954，ghost-cursor / agentcursor 也用）；
 * 进度不再用 easeInOutCubic（tldraw 自主移动曲线），改走欠阻尼弹簧：
 * 刚度按 Fitts 时长反推，近快远远不变，允许约 2% 过冲，并在时长内收完，
 * 飞行中途目标变了也不生硬。不是 WindMouse / 拖尾。
 */

export type CursorPt = { x: number; y: number };

export const CURSOR_REST_INSET = 24;

export const FITTS_MIN_MS = 220;

export const FITTS_MAX_MS = 480;

// 让刚发生的动作可读；这是非阻塞收起计时，新操作会取消它。
export const PARK_AFTER_MS = 1200;

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

/** 欠阻尼弹簧参数：k 刚度，c 阻尼。 */
export interface Spring {
  k: number;
  c: number;
}

/** 过冲约 2% 的阻尼比：看得出活，又不晃。 */
const SPRING_ZETA = 0.75;

/** 按 Fitts 时长反推弹簧，ωn²=k，c=2ζωn。系数 6 让过冲在时长内收完：调用方只等这么久就点击，箭头尖须已停在目标上。 */
export function springFor(ms: number): Spring {
  const ts = Math.max(0.05, ms / 1000);
  const wn = 6 / (SPRING_ZETA * ts);

  return { k: wn * wn, c: 2 * SPRING_ZETA * wn };
}

/** 推进一步：s 是 0→1 的进度（允许略过 1 再回来），v 是进度速度。dt 单位秒。 */
export function springStep(s: number, v: number, dt: number, spring: Spring): [number, number] {
  const a = (1 - s) * spring.k - v * spring.c;
  const nv = v + a * dt;

  return [s + nv * dt, nv];
}

/** 进度贴住终点且速度足够小就算到。 */
export function springSettled(s: number, v: number): boolean {
  return Math.abs(1 - s) < 0.002 && Math.abs(v) < 0.05;
}
