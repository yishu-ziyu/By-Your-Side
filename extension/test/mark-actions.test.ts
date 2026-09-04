import { describe, expect, it } from "vitest";
import { isMarkActionId, markActionUserText, parseMarkActions } from "../src/shared/mark-actions.js";

describe("parseMarkActions", () => {
  it("抽出 confirm/cancel，confirm 排在前面，文案去空白截断", () => {
    expect(
      parseMarkActions([
        { id: "cancel", label: "  取消  " },
        { id: "confirm", label: `${"删".repeat(20)}` },
      ]),
    ).toEqual([
      { id: "confirm", label: "删".repeat(16) },
      { id: "cancel", label: "取消" },
    ]);
  });

  it("空、非数组、无有效项都当成没有按钮", () => {
    expect(parseMarkActions(undefined)).toBeUndefined();
    expect(parseMarkActions([])).toBeUndefined();
    expect(parseMarkActions([{ id: "ok", label: "好" }])).toBeUndefined();
    expect(parseMarkActions([{ id: "confirm", label: "   " }])).toBeUndefined();
  });

  it("同 id 只留第一条，最多两个", () => {
    expect(
      parseMarkActions([
        { id: "confirm", label: "删除" },
        { id: "confirm", label: "真删" },
        { id: "cancel", label: "取消" },
        { id: "cancel", label: "返回" },
      ]),
    ).toEqual([
      { id: "confirm", label: "删除" },
      { id: "cancel", label: "取消" },
    ]);
  });
});

describe("markActionUserText", () => {
  it("点删除/取消与侧栏「确认」「取消」同一句话", () => {
    expect(markActionUserText("confirm")).toBe("确认");
    expect(markActionUserText("cancel")).toBe("取消");
    expect(isMarkActionId("confirm")).toBe(true);
    expect(isMarkActionId("delete")).toBe(false);
  });
});
