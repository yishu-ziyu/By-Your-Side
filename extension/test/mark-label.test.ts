import { describe, expect, it } from "vitest";
import { MARK_LABEL_SPACE_NEEDED_PX, markLabelPlacement } from "../src/shared/mark-label.js";

describe("mark label 贴顶翻转（几何判定）", () => {
  it("元素上方空间充足时名牌在框上方", () => {
    expect(markLabelPlacement(200)).toBe("above");
    expect(markLabelPlacement(50)).toBe("above");
  });

  it("元素贴视口顶部时名牌翻到框下方", () => {
    expect(markLabelPlacement(0)).toBe("below");
    expect(markLabelPlacement(10)).toBe("below");
    expect(markLabelPlacement(MARK_LABEL_SPACE_NEEDED_PX - 1)).toBe("below");
  });

  it("临界值：恰好够 pill 高+间距时仍在上方", () => {
    expect(markLabelPlacement(MARK_LABEL_SPACE_NEEDED_PX)).toBe("above");
  });

  it("元素部分滚出视口（负顶距）时翻到下方", () => {
    expect(markLabelPlacement(-5)).toBe("below");
  });
});
