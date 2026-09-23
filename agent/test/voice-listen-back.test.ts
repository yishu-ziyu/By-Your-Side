import { describe, expect, it } from "vitest";
import { EARLY_HOLD_LINE, safeEarlyText } from "../src/voice-early.js";
import { controlConfirmMessage, isControlConfirm, isControlReject } from "../src/voice-confirm.js";

describe("接话安全台词（① 抢答）", () => {
  it("实测编造过的那两句被拦下", () => {
    expect(safeEarlyText("哎，我刚才没说清楚。这是 Chrome 的扩展管理页，我没法直接帮你把网页标签切过去。你得先去 BOSS 直聘的页面，然后告诉我你想把它移到哪个文件夹里？")).toBeNull();
    expect(safeEarlyText("这是 Chrome 的扩展管理页")).toBeNull();
    expect(safeEarlyText("你想把它移到哪个文件夹里")).toBeNull();
  });

  it("具体对象、数字、拉丁词、动作结果都不许说", () => {
    for (const bad of [
      "我看一下这个页面",
      "稍等，我打开那个标签",
      "我先切换到第 2 个窗口",
      "我看看 BOSS 那边的职位",
      "已经帮你暂停了",
      "收到，马上执行",
      "好的。我确认一下。然后再回答你。",
      "",
      "   ",
    ]) {
      expect(safeEarlyText(bad), bad).toBeNull();
    }
  });

  it("短句准备语照样放行，闲聊不被误伤", () => {
    expect(safeEarlyText("嗯，我看一下。")).toBe("嗯，我看一下。");
    expect(safeEarlyText("好的，我确认一下。")).toBe("好的，我确认一下。");
    expect(safeEarlyText("嗨，我在呢。")).toBe("嗨，我在呢。");
    expect(safeEarlyText("我来处理这个修改。")).toBe("我来处理这个修改。");
  });

  it("固定台词本身是安全的", () => {
    expect(safeEarlyText(EARLY_HOLD_LINE)).toBe(EARLY_HOLD_LINE);
  });
});

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
