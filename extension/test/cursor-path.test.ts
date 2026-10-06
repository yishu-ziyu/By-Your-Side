import { describe, expect, it } from "vitest";
import {
  CURSOR_REST_INSET,
  FITTS_MAX_MS,
  FITTS_MIN_MS,
  arcControl,
  easeInOutCubic,
  fittsMs,
  flightMs,
  pointOnArc,
  qbez,
  restOnRight,
  restPoint,
  springFor,
  springSettled,
  springStep,
} from "../src/shared/cursor-path.js";

describe("cursor-path 浅弧 + Fitts", () => {
  it("easeInOutCubic 端点是 0 和 1，中点 0.5", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 8);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });

  it("Fitts 近快远远，封在 220–480ms", () => {
    expect(fittsMs(0)).toBe(FITTS_MIN_MS);
    expect(fittsMs(40)).toBeGreaterThanOrEqual(FITTS_MIN_MS);
    expect(fittsMs(800)).toBe(FITTS_MAX_MS);
    expect(fittsMs(80)).toBeGreaterThan(fittsMs(20));
    expect(fittsMs(80)).toBeLessThan(FITTS_MAX_MS);
  });

  it("Lead 停左上，第二人停右上", () => {
    expect(restOnRight(0)).toBe(false);
    expect(restOnRight(1)).toBe(true);
    expect(restPoint(0, 800)).toEqual({ x: CURSOR_REST_INSET, y: CURSOR_REST_INSET });
    expect(restPoint(1, 800)).toEqual({ x: 800 - CURSOR_REST_INSET, y: CURSOR_REST_INSET });
  });

  it("控制点不在起终点连线上，弯度随距离但封顶", () => {
    const from = { x: 24, y: 24 };
    const to = { x: 400, y: 300 };
    const c = arcControl(from, to);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const cross = (c.x - from.x) * dy - (c.y - from.y) * dx;
    expect(Math.abs(cross)).toBeGreaterThan(1000);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const bow = Math.hypot(c.x - mid.x, c.y - mid.y);
    expect(bow).toBeGreaterThanOrEqual(8);
    expect(bow).toBeLessThanOrEqual(36);
  });

  it("二次贝塞尔 t=0 是起点，t=1 是终点", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 40 };
    const c = { x: 100, y: 80 };
    expect(qbez(a, b, c, 0)).toEqual(a);
    expect(qbez(a, b, c, 1)).toEqual(c);
    const p = pointOnArc(a, c, 0.5);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(100);
    const chord = { x: 50, y: 40 };
    expect(Math.hypot(p.x - chord.x, p.y - chord.y)).toBeGreaterThan(4);
  });

  it("flightMs 跟距离走 Fitts", () => {
    const a = { x: 0, y: 0 };
    expect(flightMs(a, { x: 10, y: 0 })).toBe(FITTS_MIN_MS);
    expect(flightMs(a, { x: 900, y: 0 })).toBe(FITTS_MAX_MS);
  });
});

describe("欠阻尼弹簧进度", () => {
  function simulate(ms: number, maxSeconds = 3) {
    const spring = springFor(ms);
    let s = 0;
    let v = 0;
    let peak = 0;
    let settledAt = -1;
    const dt = 1 / 240;

    for (let t = 0; t < maxSeconds; t += dt) {
      [s, v] = springStep(s, v, dt, spring);
      peak = Math.max(peak, s);

      if (settledAt < 0 && springSettled(s, v)) settledAt = t;
    }

    return { s, v, peak, settledAt };
  }

  it("从 0 出发，稳定贴在 1", () => {
    const { s, v } = simulate(300);
    expect(s).toBeGreaterThan(0.998);
    expect(s).toBeLessThan(1.002);
    expect(Math.abs(v)).toBeLessThan(0.05);
  });

  it("到 Fitts 时长已贴住终点：调用方等完就点击，飞 1000px 也偏不到 1px", () => {
    for (const ms of [FITTS_MIN_MS, FITTS_MAX_MS]) {
      const { s } = simulate(ms, ms / 1000);
      expect(Math.abs(1 - s)).toBeLessThan(0.001);
    }
  });

  it("轻过冲：看得出，但不超过 8%", () => {
    const { peak } = simulate(300);
    expect(peak).toBeGreaterThan(1.005);
    expect(peak).toBeLessThan(1.08);
  });
});
