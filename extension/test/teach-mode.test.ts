import { describe, expect, it } from "vitest";
import {
  consumeTeachUrlChange,
  hasPendingTeachMarks,
  noteMarkDrawn,
  noteMarksCleared,
} from "../src/background/mode.js";

describe("有待完成教学标注追踪（步骤完成自动感知）", () => {
  it("mark 成功后置为有待完成，clear_marks 后清除", () => {
    noteMarksCleared(); // 隔离其他用例的残留状态
    expect(hasPendingTeachMarks()).toBe(false);
    noteMarkDrawn();
    expect(hasPendingTeachMarks()).toBe(true);
    noteMarksCleared();
    expect(hasPendingTeachMarks()).toBe(false);
  });

  it("teach 模式 + 有待完成标注时 URL 变化命中通知，且消费后重置", () => {
    noteMarkDrawn();
    expect(consumeTeachUrlChange("teach")).toBe(true);
    expect(hasPendingTeachMarks()).toBe(false);
    // 已消费：再次 URL 变化不再命中
    expect(consumeTeachUrlChange("teach")).toBe(false);
  });

  it("act 模式下 URL 变化不命中，但标记照常重置（整页导航标注已销毁）", () => {
    noteMarkDrawn();
    expect(consumeTeachUrlChange("act")).toBe(false);
    expect(hasPendingTeachMarks()).toBe(false);
  });

  it("teach 模式但无待完成标注时不命中", () => {
    noteMarksCleared();
    expect(consumeTeachUrlChange("teach")).toBe(false);
  });
});
