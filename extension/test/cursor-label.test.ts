import { describe, expect, it } from "vitest";
import { cursorLabelPosition } from "../src/shared/cursor-label.js";

describe("动作名牌位置", () => {
  it("宽字段优先贴近光标的下方，不跨到相邻卡片", () => {
    const target = { x: 66, y: 264, width: 520, height: 46 };
    const p = cursorLabelPosition({ x: 326, y: 287 }, { width: 147, height: 50 }, { width: 1800, height: 950 }, target);
    expect(p.y).toBeGreaterThanOrEqual(target.y + target.height);
    expect(Math.abs(p.x + 147 / 2 - 326)).toBeLessThan(30);
  });
  it.each([
    { x: 0, y: 0, width: 140, height: 36 },
    { x: 650, y: 0, width: 150, height: 36 },
    { x: 660, y: 550, width: 140, height: 50 },
    { x: 0, y: 550, width: 170, height: 50 },
    { x: 140, y: 250, width: 500, height: 100 },
  ])("目标 %o：留在视口内且不盖住操作区域", target => {
    const size = { width: 230, height: 58 };
    const p = cursorLabelPosition({ x: target.x + target.width / 2, y: target.y + target.height / 2 }, size, { width: 800, height: 600 }, target);
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.x + size.width).toBeLessThanOrEqual(792);
    expect(p.y + size.height).toBeLessThanOrEqual(592);
    expect(p.x >= target.x + target.width || p.x + size.width <= target.x || p.y >= target.y + target.height || p.y + size.height <= target.y).toBe(true);
  });
});
