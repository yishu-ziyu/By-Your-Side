import { describe, expect, it } from "vitest";
import { consumeTeachUrlChange, noteMarkDrawn, noteMarksCleared } from "../src/background/mode.js";

describe("有待完成教学标注追踪（步骤完成自动感知）", () => {
  it("clear_marks 之后 URL 变化不命中", () => {
    noteMarkDrawn();
    noteMarksCleared();
    expect(consumeTeachUrlChange("teach")).toBe(false);
  });

  it("teach 模式 + 有待完成标注时 URL 变化命中通知，且消费后重置", () => {
    noteMarkDrawn();
    expect(consumeTeachUrlChange("teach")).toBe(true);
    expect(consumeTeachUrlChange("teach")).toBe(false);
  });

  it("act 模式下 URL 变化不命中，但标记照常重置（整页导航标注已销毁）", () => {
    noteMarkDrawn();
    expect(consumeTeachUrlChange("act")).toBe(false);
    expect(consumeTeachUrlChange("teach")).toBe(false);
  });

  it("teach 模式但无待完成标注时不命中", () => {
    noteMarksCleared();
    expect(consumeTeachUrlChange("teach")).toBe(false);
  });
});
