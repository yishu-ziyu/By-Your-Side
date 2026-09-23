import { describe, expect, it } from "vitest";
import { controlConfirmMessage, isControlConfirm, isControlReject } from "../src/voice-confirm.js";

describe("控制句先复述确认（#1）", () => {
  it("对/不认得出来，别的话不当确认", () => {
    for (const yes of ["对", "对的", "是", "嗯", "确认", "好的", "可以", "没错", "就这样。", "照做"]) {
      expect(isControlConfirm(yes), yes).toBe(true);
    }

    for (const no of ["不", "不是", "不对", "算了", "取消", "先别", "别动。"]) {
      expect(isControlReject(no), no).toBe(true);
    }

    for (const other of ["打开邮箱", "再改一下预算", "这是什么"]) {
      expect(isControlConfirm(other), other).toBe(false);
      expect(isControlReject(other), other).toBe(false);
    }
  });

  it("复述用用户自己的原话，转写错了才看得见", () => {
    expect(controlConfirmMessage("让位是你把它切过去，就是。")).toBe("你是说“让位是你把它切过去，就是。”，对吗？确认后我就照做。");
  });
});
