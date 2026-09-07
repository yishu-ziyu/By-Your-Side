import { describe, expect, it } from "vitest";
import { handbackContinueText } from "../../shared/control.js";

describe("交还约束只约束被恢复的原任务", () => {
  const text = handbackContinueText(
    { tabId: 9, title: "另一条笔记", url: "https://v.flomoapp.com/mine" },
    "heading 今天的会议",
  );

  it("保留原交还续写断言：继续原任务、不重做、当前页权威、不换页", () => {
    expect(text).toContain("Continue the original task");
    expect(text).toContain("Do not reopen");
    expect(text).toContain("Do not repeat completed steps");
    expect(text).toContain("Do not switch tabs, navigate, reload, or reopen any page");
    expect(text).toContain("The CURRENT page and snapshot are authoritative");
    expect(text).toContain("do not redo it");
    expect(text).toContain("tab 9");
    expect(text).toContain("今天的会议");
    expect(text).not.toContain("new task");
  });

  it("留在本页指令只作用于这次恢复的原任务，原任务结束后到期", () => {
    expect(text).toMatch(/only to this restored original task/i);
    expect(text).toMatch(/expire when that original task ends/i);
  });
});
