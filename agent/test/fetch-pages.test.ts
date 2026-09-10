import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPages, pageNumbers, substitutePage } from "../src/fetch-batch.js";
import { createBrowserTools } from "../src/tools.js";
import type { FetchReply } from "../src/fetch-result.js";

const dir = () => mkdtempSync(join(tmpdir(), "ego-fetch-pages-"));

const reply = (over: Partial<FetchReply> = {}): FetchReply => ({
  url: "https://api.example.com/list?page=1",
  status: 200,
  ok: true,
  contentType: "application/json",
  bytes: 40,
  truncated: false,
  text: '{"items":[1]}',
  ...over,
});

describe("批量翻页参数", () => {
  it("页码列表按 from/to/step 生成", () => {
    expect(pageNumbers({ from: 1, to: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers({ from: 2, to: 10, step: 4 })).toEqual([2, 6, 10]);
    expect(pageNumbers({ from: 7, to: 7 })).toEqual([7]);
  });

  it("非法范围与超过 20 页都拒绝", () => {
    expect(() => pageNumbers({ from: 1.5, to: 3 })).toThrow(/整数/);
    expect(() => pageNumbers({ from: 3, to: 1 })).toThrow(/from <= to/);
    expect(() => pageNumbers({ from: 1, to: 5, step: 0 })).toThrow(/step/);
    expect(() => pageNumbers({ from: 1, to: 21 })).toThrow(/最多 20 页/);
    expect(pageNumbers({ from: 1, to: 20 })).toHaveLength(20);
  });

  it("{page} 占位符全部替换", () => {
    expect(substitutePage("https://x.test/a/{page}/b?page={page}", 7)).toBe("https://x.test/a/7/b?page=7");
  });
});

describe("批量翻页执行", () => {
  it("顺序请求每页、每页落盘、只预览第一页", async () => {
    const target = dir();
    const requests: any[] = [];
    const result = await fetchPages(
      { url: "https://api.example.com/list?page={page}&size=2", headers: { "X-T": "1" }, pages: { from: 1, to: 3 }, savePath: "数据.json" },
      async (request) => {
        requests.push(request);
        const page = new URL(request.url).searchParams.get("page");
        return reply({
          url: request.url,
          text: page === "1" ? "FIRST_PAGE_BODY" : `SECOND_PAGE_BODY_${page}`,
          bytes: Number(page) * 100,
        });
      },
      target,
    );

    expect(requests.map((r) => new URL(r.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(requests.every((r) => r.headers?.["X-T"] === "1")).toBe(true);

    const files = readdirSync(target).sort();
    expect(files).toEqual(["数据-p1.json", "数据-p2.json", "数据-p3.json"]);
    expect(readFileSync(join(target, "数据-p2.json"), "utf8")).toBe("SECOND_PAGE_BODY_2");

    expect(result.data.saved).toHaveLength(3);
    expect(result.data.failed).toBe(0);
    expect(result.data.totalBytes).toBe(600);
    expect(result.text).toContain("Batch fetch 3/3 pages (page 1..3)");
    expect(result.text).toContain("数据-p1.json");
    expect(result.text).toContain("FIRST_PAGE_BODY");
    expect(result.text).not.toContain("SECOND_PAGE_BODY");
  });

  it("POST body 里的 {page} 同样替换", async () => {
    const requests: any[] = [];
    await fetchPages(
      { url: "https://api.example.com/search", method: "POST", body: '{"page":{page},"q":"x"}', pages: { from: 2, to: 3 }, savePath: "out" },
      async (request) => {
        requests.push(request);
        return reply({ contentType: "application/json", text: "{}" });
      },
      dir(),
    );
    expect(requests.map((r) => JSON.parse(r.body!).page)).toEqual([2, 3]);
  });

  it("缺 {page} 占位符时不发任何请求", async () => {
    let called = 0;
    await expect(fetchPages(
      { url: "https://api.example.com/list?page=9", pages: { from: 1, to: 2 }, savePath: "x.json" },
      async () => { called += 1; return reply(); },
      dir(),
    )).rejects.toThrow(/占位符/);
    expect(called).toBe(0);
  });

  it("单页失败不吞掉其它页：失败页写明原因，成功页照常落盘", async () => {
    const target = dir();
    const result = await fetchPages(
      { url: "https://api.example.com/list?page={page}", pages: { from: 1, to: 3 }, savePath: "x.json" },
      async (request) => {
        const page = Number(new URL(request.url).searchParams.get("page"));
        if (page === 3) throw new Error("fetch 请求失败（未送达或网络错误）：boom。");
        return reply({ text: `page-${page}`, status: page === 2 ? 404 : 200, ok: page !== 2 });
      },
      target,
    );
    expect(result.data.failed).toBe(1);
    expect(result.data.saved).toHaveLength(2);
    expect(result.text).toContain("3. request failed");
    expect(result.text).toContain("HTTP 404 (not ok)");
    expect(readdirSync(target).sort()).toEqual(["x-p1.json", "x-p2.json"]);
  });

  it("无 savePath 时按 URL 生成基础名，页码不互相覆盖", async () => {
    const target = dir();
    await fetchPages(
      { url: "https://api.example.com/items?page={page}", pages: { from: 1, to: 2 } },
      async (request) => reply({ url: request.url, text: "x", bytes: 1 }),
      target,
    );
    const files = readdirSync(target);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("-p1.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("-p2.json"))).toBe(true);
  });
});

describe("fetch 工具接上 pages（模型看到的入口）", () => {
  it("带 pages 时走批量路径：每页一次 RPC、占位符替换、回执包不可信边界", async () => {
    const target = dir();
    process.env.SIDEAGENT_DOWNLOADS_DIR = target;
    try {
      const calls: any[] = [];
      const rpc: any = {
        call: async (name: string, params: any) => {
          calls.push({ name, params });
          const page = new URL(params.url).searchParams.get("page");
          return reply({ url: params.url, text: `{"page":${page}}`, bytes: 12 });
        },
      };
      const tools = createBrowserTools(rpc, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, assertCall: () => {} });
      const fetchTool = tools.find((tool) => tool.name === "fetch")!;
      const result: any = await (fetchTool.execute as any)("call-1", { url: "https://api.example.com/list?page={page}", pages: { from: 1, to: 2 }, savePath: "unit-x.json" });
      const text = result.content.map((part: any) => part.text).join("\n");
      expect(calls).toHaveLength(2);
      expect(calls[0].params.url).toContain("page=1");
      expect(calls[1].params.url).toContain("page=2");
      expect(text).toContain("<page-content untrusted");
      expect(text).toContain("Batch fetch 2/2 pages");
      expect(readdirSync(target).sort()).toEqual(["unit-x-p1.json", "unit-x-p2.json"]);
      expect(result.details.saved).toHaveLength(2);
    } finally {
      delete process.env.SIDEAGENT_DOWNLOADS_DIR;
    }
  });
});
