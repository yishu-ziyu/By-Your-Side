import { describe, expect, it } from "vitest";
import {
  chiselWash,
  mulberry32,
  roughArrow,
  roughEllipse,
  roughLine,
  variants,
} from "../src/shared/rough/index.js";

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

  it("roughLine: 确定性生成手绘直线", () => {
    const line = roughLine(10, 20, 110, 20, { seed: 7, roughness: 1.2 });
    expect(line.startsWith("M")).toBe(true);
  });

  it("chiselWash: 生成平刷荧光笔路径", () => {
    const wash = chiselWash(0, 10, 100, 10, { seed: 88, roughness: 1 });
    expect(wash.startsWith("M")).toBe(true);
  });

  it("variants: 在 boil 开启时生成 3 帧微晃路径且帧之间不同", () => {
    const frames = variants(
      (o) => roughEllipse(50, 50, 30, 20, o),
      { seed: 55, roughness: 1, boil: 0.3 },
      3,
    );
    expect(frames.length).toBe(3);
    expect(frames[0]).not.toBe(frames[1]);
    expect(frames[1]).not.toBe(frames[2]);
  });
});
