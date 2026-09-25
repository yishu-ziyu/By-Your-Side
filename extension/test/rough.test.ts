import { describe, expect, it } from "vitest";
import { mulberry32, roughArrow, roughEllipse, sketchFrame, sketchLabelPosition } from "../src/shared/rough/index.js";

describe("rough 几何与 PRNG 单元测试", () => {
  it("mulberry32: 相同种子生成完全一致的伪随机数序列", () => {
    const r1 = mulberry32(12345);
    const r2 = mulberry32(12345);
    const seq1 = [r1(), r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2(), r2()];
    expect(seq1).toEqual(seq2);
    expect(seq1[0]).not.toBe(seq1[1]);
  });

  it("roughEllipse: 相同种子生成完全一致的 SVG 闭合路径", () => {
    const p1 = roughEllipse(50, 50, 40, 20, { seed: 42, roughness: 1 });
    const p2 = roughEllipse(50, 50, 40, 20, { seed: 42, roughness: 1 });
    expect(p1).toBe(p2);
    expect(p1.startsWith("M")).toBe(true);
    expect(p1.includes("Z")).toBe(true);
  });

  it("roughArrow: 生成包含箭杆与双翼的有效 SVG 路径", () => {
    const arrow = roughArrow(0, 0, 100, 50, { seed: 99, roughness: 1 });
    expect(arrow.startsWith("M")).toBe(true);
    // 箭杆为双笔画 + 2个翼，应该包含多个 M 起始指令
    const moveCount = (arrow.match(/M/g) || []).length;
    expect(moveCount).toBeGreaterThanOrEqual(3);
  });
});

describe("手绘外框：形状跟着目标，名牌不压文字", () => {
  it("宽而扁的目标画贴合的圆角框，只外扩 4px，不压到上下相邻行", () => {
    const { d, frame } = sketchFrame({ x: 10, y: 50, w: 300, h: 22 }, { seed: 7, roughness: 0.9 });
    expect(frame).toEqual({ x: 6, y: 46, w: 308, h: 30 });
    expect(d.startsWith("M")).toBe(true);
    expect(d.split("M")).toHaveLength(2); // 只画一笔
  });

  it("紧凑的目标画圈，圈把目标完整包住", () => {
    const { frame } = sketchFrame({ x: 100, y: 100, w: 80, h: 32 }, { seed: 7, roughness: 0.9 });
    expect(frame.x).toBeLessThan(100);
    expect(frame.x + frame.w).toBeGreaterThan(180);
    expect(frame.y).toBeLessThan(100);
    expect(frame.y + frame.h).toBeGreaterThan(132);
  });

  describe("名牌不压字（坐标都是手算的）", () => {
    // 框 {10,40,100,30}，名牌 80×24：右侧 {118,43}、上方 {10,14}、下方 {10,72}、左侧 {-78,43}。
    const frame = { x: 10, y: 40, w: 100, h: 30 };
    const label = { w: 80, h: 24 };
    const view = { x: -200, y: -100, w: 1000, h: 600 };

    type B = { x: number; y: number; w: number; h: number };

    const hit = (a: B, b: B) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);

    const room = (texts: B[], v: B = view) => ({
      inView: (b: B) => b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h,
      clear: (b: B) => !texts.some((t) => hit(t, b)),
    });

    it("右侧没字：放右侧、与框垂直居中", () => {
      expect(sketchLabelPosition(frame, label, room([]))).toEqual({ left: 118, top: 43 });
    });

    it("右侧紧挨着数值：改放上方", () => {
      expect(sketchLabelPosition(frame, label, room([{ x: 112, y: 46, w: 30, h: 18 }]))).toEqual({ left: 10, top: 14 });
    });

    it("右侧和上方都有字：放下方", () => {
      expect(sketchLabelPosition(frame, label, room([{ x: 112, y: 46, w: 30, h: 18 }, { x: 0, y: 10, w: 120, h: 18 }]))).toEqual({ left: 10, top: 72 });
    });

    it("右、上、下都有字：放左侧", () => {
      const texts = [{ x: 112, y: 46, w: 30, h: 18 }, { x: 0, y: 10, w: 120, h: 18 }, { x: 0, y: 76, w: 120, h: 18 }];
      expect(sketchLabelPosition(frame, label, room(texts))).toEqual({ left: -78, top: 43 });
    });

    it("紧凑的行、左侧贴着可见区域边缘：沿上沿往右找到第一处空白", () => {
      // 上一行文字到 x=150 为止；上沿右移 16 的倍数，第一处不重叠的是 dx=144（left=154）。
      const texts = [{ x: 112, y: 46, w: 30, h: 18 }, { x: 0, y: 10, w: 150, h: 18 }, { x: 0, y: 76, w: 400, h: 18 }];
      expect(sketchLabelPosition(frame, label, room(texts, { x: 0, y: 0, w: 1000, h: 600 }))).toEqual({ left: 154, top: 14 });
    });

    it("右侧超出可见区域：不放右侧，改放上方", () => {
      expect(sketchLabelPosition(frame, label, room([], { x: 0, y: 0, w: 150, h: 600 }))).toEqual({ left: 10, top: 14 });
    });

    it("处处压字：退回第一个看得见的位置（右侧）", () => {
      expect(sketchLabelPosition(frame, label, room([view]))).toEqual({ left: 118, top: 43 });
    });
  });
});
