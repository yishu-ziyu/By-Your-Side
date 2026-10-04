import { describe, expect, it } from "vitest";
import { FETCH_BROWSER_INLINE_LIMIT, formatFetchReply, type FetchReply } from "../src/fetch-result.js";

const reply = (over: Partial<FetchReply> = {}): FetchReply => ({
  url: "https://api.example.com/items?p=1",
  status: 200,
  ok: true,
  contentType: "application/json",
  bytes: 40,
  truncated: false,
  text: '{"items":[{"name":"甲"}]}',
  ...over,
});

describe("fetch 回执", () => {
  it("响应内联，并过不可信边界；说明没有存成本机文件", () => {
    const out = formatFetchReply(reply());
    expect(out).toContain("HTTP 200 application/json");
    expect(out).toContain('<page-content untrusted url="https://api.example.com/items?p=1">');
    expect(out).toContain("甲");
    expect(out).toContain("not saved to a local file");
  });

  it("超出内联上限时截断并说明，不假装存了文件", () => {
    const out = formatFetchReply(reply({ text: "内".repeat(FETCH_BROWSER_INLINE_LIMIT + 500), bytes: 60000 }));
    expect(out).toContain("Inline body truncated");
    expect(out).not.toContain("Saved to");
    expect((out.match(/内/g) ?? []).length).toBe(FETCH_BROWSER_INLINE_LIMIT);
  });

  it("响应里的凭据长相内容被隐去后再进上下文，截断时说明只读到上限", () => {
    const out = formatFetchReply(reply({ text: '{"recovery":"A1B2C3D4E5F60718"}', truncated: true }));
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("A1B2C3D4E5F60718");
    expect(out).toContain("truncated at the extension cap");
  });
});
