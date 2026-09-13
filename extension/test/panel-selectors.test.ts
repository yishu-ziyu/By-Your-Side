import { describe, expect, it } from "vitest";
import { actionQuestion, controlQuestion, micQuestion, pageQuestion, resultCardCopy, sessionQuestion, speechQuestion } from "../src/sidepanel/selectors.js";

describe("panel four questions", () => {
  it("names the session, page, action and controller", () => {
    expect(sessionQuestion("整理资料")).toBe("整理资料");
    expect(pageQuestion("Inbox", "mail.example")).toBe("Inbox / mail.example");
    expect(actionQuestion({ running: true, action: "正在核对第 2 个条件", elapsedSec: 4.2 })).toBe("正在核对第 2 个条件 · 4.2秒");
    expect(controlQuestion({ userHasPage: true })).toBe("现在归你");
    expect(controlQuestion({ userHasPage: false, draining: true })).toBe("正在交接");
  });

  it("keeps mic and speech independent", () => {
    expect(micQuestion(true)).toBe("麦克风：正在听");
    expect(speechQuestion(false)).toBe("声音：未说");
  });
});

describe("result card copy", () => {
  it("stays hidden without a summary", () => {
    expect(resultCardCopy({ summary: null }).visible).toBe(false);
  });

  it("leads with the finding and de-emphasizes leftovers and failed speech", () => {
    const card = resultCardCopy({
      summary: "已填入林夏，尚未提交",
      remaining: ["保存"],
      speechFailed: true,
    });
    expect(card.visible).toBe(true);
    expect(card.primary).toBe("已填入林夏，尚未提交");
    expect(card.secondary).toContain("还剩保存");
    expect(card.secondary).toContain("声音未完成，文字仍可查看");
  });

  it("says the result is unconfirmed when there is no summary", () => {
    expect(resultCardCopy({ summary: null, unknown: true }).primary).toBe("这次结果还没法确认");
  });
});
