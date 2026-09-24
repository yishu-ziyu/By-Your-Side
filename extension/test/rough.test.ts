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

  it("右边放得下时名牌在框外右侧、与框垂直居中；放不下退到框外左上且不出可见区域", () => {
    const frame = { x: 10, y: 40, w: 100, h: 30 };
    expect(sketchLabelPosition(frame, 80, 200, -50)).toEqual({ left: 118, top: 45 });
    expect(sketchLabelPosition(frame, 80, 40, 20)).toEqual({ left: 20, top: 18 });
  });
});
