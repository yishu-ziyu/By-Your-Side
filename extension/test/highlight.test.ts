import { describe, expect, it } from "vitest";
import { CURSOR_PALETTE, cursorColor } from "../src/shared/palette.js";

describe("element highlight geometry & palette", () => {

  function computeHighlightBounds(rect: { x: number; y: number; width: number; height: number }, pad = 3) {
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      left: Math.round(rect.x - pad),
      top: Math.round(rect.y - pad),
      width: Math.round(rect.width + pad * 2),
      height: Math.round(rect.height + pad * 2),
    };
  }

  function computeCenter(rect: { x: number; y: number; width: number; height: number }): [number, number] {
    return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
  }

  function resolveColor(id: string, _existingCount: number): string {
    return cursorColor(id);
  }

  it("计算高亮外扩包围盒（含 pad 边界与取整）", () => {
    const rect = { x: 100.4, y: 50.2, width: 200, height: 40 };
    const bounds = computeHighlightBounds(rect, 3);
    expect(bounds).toEqual({
      left: 97,
      top: 47,
      width: 206,
      height: 46,
    });
  });

  it("拒绝零尺寸或负尺寸元素的无效高亮", () => {
    expect(computeHighlightBounds({ x: 10, y: 10, width: 0, height: 20 })).toBeNull();
    expect(computeHighlightBounds({ x: 10, y: 10, width: 20, height: 0 })).toBeNull();
    expect(computeHighlightBounds({ x: 10, y: 10, width: -5, height: 20 })).toBeNull();
  });

  it("从包围盒精确推算视口点击中心点", () => {
    expect(computeCenter({ x: 100, y: 200, width: 80, height: 30 })).toEqual([140, 215]);
    expect(computeCenter({ x: 0, y: 0, width: 15, height: 15 })).toEqual([8, 8]);
  });

  it("多实例调色板：主实例恒为品牌蓝，工人跳过蓝色且对同一 id 稳定", () => {
    expect(resolveColor("main", 0)).toBe(CURSOR_PALETTE[0]);
    expect(cursorColor("wiki")).not.toBe(CURSOR_PALETTE[0]);
    expect(cursorColor("wiki")).toBe(cursorColor("wiki"));
    expect(cursorColor("feishu")).not.toBe(cursorColor("wiki"));
  });
});
