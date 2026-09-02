import { describe, expect, it } from "vitest";
import { lastAssistantError, runProducedNothing } from "../src/session.js";

describe("lastAssistantError", () => {
  it("提取最后一条 assistant 消息的 errorMessage", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [], errorMessage: "fetch failed" },
    ];
    expect(lastAssistantError(messages)).toBe("fetch failed");
  });

  it("没有 errorMessage 时返回 null", () => {
    expect(lastAssistantError([{ role: "assistant", content: [] }])).toBeNull();
    expect(lastAssistantError([])).toBeNull();
    expect(lastAssistantError("bad")).toBeNull();
  });
});

describe("runProducedNothing", () => {
  it("空文本视为空响应", () => {
    expect(runProducedNothing([{ role: "assistant", content: [{ type: "text", text: "  " }] }])).toBe(true);
    expect(runProducedNothing([{ role: "assistant", content: [] }])).toBe(true);
  });

  it("有文本或工具调用则不算空", () => {
    expect(runProducedNothing([{ role: "assistant", content: [{ type: "text", text: "好" }] }])).toBe(false);
    expect(runProducedNothing([{ role: "assistant", toolCalls: [{ id: "1" }] }])).toBe(false);
  });

  it("非数组输入不算空（不误报）", () => {
    expect(runProducedNothing(undefined)).toBe(false);
  });
});
