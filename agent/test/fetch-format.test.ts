import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFetchReply, safeDownloadName, type FetchReply } from "../src/fetch-result.js";

const dir = () => mkdtempSync(join(tmpdir(), "ego-fetch-"));
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
  it("小响应内联，并过不可信边界", () => {
    const out = formatFetchReply(reply(), undefined, dir());
    expect(out).toContain("HTTP 200 application/json");
    expect(out).toContain('<page-content untrusted url="https://api.example.com/items?p=1">');
    expect(out).toContain("甲");
  });

  it("大响应落盘：回执只有路径/字节/预览，正文不进上下文", () => {
    const target = dir();
    const out = formatFetchReply(reply({ text: "内容".repeat(4000), bytes: 24000 }), undefined, target);
    expect(out).toContain("Saved to");
    expect(out).toContain("not in your context");
    expect(out).toContain("Preview:");
    expect(out.length).toBeLessThan(700);
  });

  it("savePath 只当文件名，路径穿越被拒；文件真的写下去", () => {
    const target = dir();
    const out = formatFetchReply(reply({ text: "x".repeat(5000) }), "../../etc/passwd", target);
    const file = out.match(/Saved to (.*?) \(\d+ bytes/)?.[1] ?? "";
    expect(file.startsWith(target)).toBe(true);
    expect(file).not.toContain("..");
    const actual = safeDownloadName("../../etc/passwd", reply().url, "application/json");
    expect(actual.startsWith("..") || actual.includes("/")).toBe(false);
    const written = formatFetchReply(reply({ text: "抓到的数据" }), "我的数据", target);
    expect(written).toContain(".json");
    expect(readFileSync(join(target, "我的数据.json"), "utf8")).toBe("抓到的数据");
  });

  it("响应里的凭据长相内容被隐去后再进上下文，截断时说明只读到上限", () => {
    const out = formatFetchReply(reply({ text: '{"recovery":"A1B2C3D4E5F60718"}', truncated: true }), undefined, dir());
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("A1B2C3D4E5F60718");
    expect(out).toContain("truncated at the extension cap");
  });
});
