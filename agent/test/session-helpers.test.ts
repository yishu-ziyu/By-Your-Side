import { describe, expect, it } from "vitest";
import { lastAssistantError, runProducedNothing, withPageContext } from "../src/session.js";

describe("withPageContext", () => {
  it("无上下文时原文返回", () => {
    expect(withPageContext("这页面是关于什么")).toBe("这页面是关于什么");
    expect(withPageContext("hi", undefined)).toBe("hi");
  });

  it("有上下文时前置页面锚点行", () => {
    const out = withPageContext("这页面是关于什么", {
      tabId: 12,
      title: "历史正在发生的地方",
      url: "https://zhuanlan.zhihu.com/p/1",
    });
    expect(out).toBe(
      '[User\'s current page: tab 12 "历史正在发生的地方" — https://zhuanlan.zhihu.com/p/1]\n这页面是关于什么',
    );
  });

  it("标题含换行时折叠为单行", () => {
    const out = withPageContext("hi", { tabId: 1, title: "第一行\n第二行", url: "https://a.b" });
    expect(out.startsWith('[User\'s current page: tab 1 "第一行 第二行" — https://a.b]\n')).toBe(true);
  });

  it("空标题回退为 (untitled)", () => {
    expect(withPageContext("hi", { tabId: 1, title: "", url: "https://a.b" })).toContain('"(untitled)"');
  });

  it("steer 插话与 prompt 走同一前缀（打断后仍带当前页锚点）", () => {
    const ctx = { tabId: 7, title: "Locked", url: "https://example.com/a" };
    expect(withPageContext("先点登录", ctx)).toBe(
      '[User\'s current page: tab 7 "Locked" — https://example.com/a]\n先点登录',
    );
  });
});

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
