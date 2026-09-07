import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { handbackContinueText } from "../../shared/control.js";

describe("新任务不受上一轮交还留在本页约束", () => {
  it("系统提示：交还边界只恢复原任务；后续明确换页的新请求不沿用", () => {
    expect(SYSTEM_PROMPT).toContain("[HANDOFF BOUNDARY]");
    expect(SYSTEM_PROMPT).toMatch(/restored original task/i);
    expect(SYSTEM_PROMPT).toMatch(/later user message/i);
    expect(SYSTEM_PROMPT).toMatch(/different page or site/i);
    expect(SYSTEM_PROMPT).toMatch(/do not keep the previous handback stay-on-page constraint/i);
    expect(SYSTEM_PROMPT).toMatch(/same conversation/i);
  });

  it("交还文本本身仍不是新任务口吻，且到期范围可被系统提示引用", () => {
    const text = handbackContinueText(
      { tabId: 3, title: "fixture", url: "http://127.0.0.1/recovery.html" },
      "editor closed",
    );
    expect(text).toContain("[HANDOFF BOUNDARY]");
    expect(text).toContain("Continue the original task");
    expect(text).not.toContain("new task");
    expect(text).toMatch(/expire when that original task ends/i);
  });
});
