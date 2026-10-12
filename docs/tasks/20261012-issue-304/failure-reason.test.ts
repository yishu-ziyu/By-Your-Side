// Issue #304：fetch 没拿到内容要算失败并带 ≤16 字人话原因；其它工具失败也带 reason；
// RepeatedToolFailurePolicy 不把三个不同 URL 的各一次失败当重复。
import { describe, expect, it } from "vitest";
import { fetchFailureReason, formatFetchReply, type FetchReply } from "../../../agent/src/fetch-result.js";
import { plainToolError } from "../../../shared/user-facing.js";
import { RepeatedToolFailurePolicy } from "../../../agent/src/tool-failure-policy.js";
import { createBrowserTools } from "../../../agent/src/tools.js";
import { ToolRpc } from "../../../agent/src/rpc.js";

const reply = (over: Partial<FetchReply>): FetchReply => ({
  url: "https://example.com/api",
  status: 200,
  ok: true,
  contentType: "application/json",
  bytes: 12,
  truncated: false,
  text: `{"ok":true}`,
  ...over,
});

describe("fetchFailureReason", () => {
  it("status 0（没拿到 HTTP 响应）是失败，原因 ≤16 字", () => {
    const reason = fetchFailureReason(reply({ status: 0, ok: false, bytes: 0, text: "" }));
    expect(reason).toBe("连不上这个地址");
    expect(reason!.length).toBeLessThanOrEqual(16);
  });

  it("非 2xx 按状态给人话原因", () => {
    expect(fetchFailureReason(reply({ status: 401, ok: false }))).toBe("要登录才能下");
    expect(fetchFailureReason(reply({ status: 403, ok: false }))).toBe("要登录才能下");
    expect(fetchFailureReason(reply({ status: 404, ok: false }))).toBe("页面不存在（404）");
    expect(fetchFailureReason(reply({ status: 500, ok: false }))).toBe("对方服务器出错（500）");
    expect(fetchFailureReason(reply({ status: 429, ok: false }))).toBe("没拿到内容（429）");
  });

  it("非 2xx 即使带内容也算失败", () => {
    expect(fetchFailureReason(reply({ status: 404, ok: false, bytes: 20, text: "not found page" }))).toBe("页面不存在（404）");
  });

  it("2xx 但正文空也算失败", () => {
    expect(fetchFailureReason(reply({ bytes: 0, text: "" }))).toBe("接口没返回内容");
    expect(fetchFailureReason(reply({ bytes: 3, text: "   " }))).toBe("接口没返回内容");
  });

  it("2xx 有内容是成功", () => {
    expect(fetchFailureReason(reply({}))).toBeNull();
    expect(fetchFailureReason(reply({ bytes: 100_000, truncated: true }))).toBeNull();
  });
});

describe("fetch 工具", () => {
  const fetchTool = (data: unknown) => {
    const rpc = new ToolRpc();
    rpc.call = async () => data;
    const tool = createBrowserTools(rpc).find(t => t.name === "fetch")!;

    return tool.execute("call-1", { url: "https://example.com/api" });
  };

  it("HTTP 0：isError=true 且带 reason，给模型的文字不变", async () => {
    const data = reply({ status: 0, ok: false, bytes: 0, text: "" });
    const result = await fetchTool(data) as { isError?: boolean; details: { reason?: string }; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe("连不上这个地址");
    expect(result.details.reason!.length).toBeLessThanOrEqual(16);
    expect(result.content[0]!.text).toBe(formatFetchReply(data));
    expect(result.content[0]!.text).toContain("HTTP 0 (not ok)");
  });

  it("HTTP 404 带内容：isError=true，原因「页面不存在（404）」", async () => {
    const result = await fetchTool(reply({ status: 404, ok: false, bytes: 20, text: "not found page", contentType: "text/html" })) as { isError?: boolean; details: { reason?: string } };

    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe("页面不存在（404）");
  });

  it("HTTP 200 空 body：isError=true，原因「接口没返回内容」", async () => {
    const result = await fetchTool(reply({ bytes: 0, text: "" })) as { isError?: boolean; details: { reason?: string } };

    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe("接口没返回内容");
  });

  it("HTTP 200 有内容：照旧不设 isError", async () => {
    const data = reply({});
    const result = await fetchTool(data) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe(formatFetchReply(data));
  });
});

describe("plainToolError", () => {
  it("技术性英文翻成人话", () => {
    expect(plainToolError('Tool call "click" timed out after 30000ms')).toBe("这一步超时了");
    expect(plainToolError("Extension is not connected")).toBe("连接断开了");
    expect(plainToolError("Extension disconnected")).toBe("连接断开了");
    expect(plainToolError("net::ERR_NAME_NOT_RESOLVED")).toBe("连不上这个地址");
    expect(plainToolError("net::ERR_CONNECTION_REFUSED")).toBe("连不上这个地址");
  });

  it("已知的页面错误翻成短原因", () => {
    expect(plainToolError("未找到目标元素：@5")).toBe("没找到目标");
    expect(plainToolError("ref 已失效，操作未执行。请重新 snapshot")).toBe("没找到目标");
    expect(plainToolError("目标被其他元素覆盖，操作未执行。请重新 snapshot")).toBe("被别的东西挡住");
    expect(plainToolError("目标不可用（disabled），操作未执行。点了也不会有反应")).toBe("目标现在不可用");
  });

  it("「被挡住」回执带出挡住的元素名字（≤8 字）", () => {
    const text = "目标被 @3 button 挡住，操作未执行，挡住它的元素也没有被点。挡住的元素名字：<page-content untrusted>\nCookie 设置\n</page-content>先处理挡住的元素";
    expect(plainToolError(text)).toBe("被「Cookie 设置」挡住");
  });

  it("下载失败带出已翻好的人话原因", () => {
    expect(plainToolError('Download failed for "a.zip": 磁盘空间不够。 No complete file was saved.')).toBe("磁盘空间不够");
    expect(plainToolError('Download failed for "a.zip": FILE_FAILED. No complete file was saved.')).toBe("没下载成");
  });

  it("一般中文错误取第一小句，剥掉定位符与英文括注", () => {
    expect(plainToolError("页面现在归你，操作未执行")).toBe("页面现在归你");
    expect(plainToolError("脚本已运行但没有返回值，subtitles.txt 没有保存。请让 IIFE 显式 return 要保存的数据。")).toBe("脚本已运行但没有返回值");
  });

  it("原因不超过 16 字；没有中文时说「没做成」", () => {
    const long = plainToolError("这是一个特别特别长的中文错误说明确实超过了十六个字的限制，后面还有逗号，更多内容。");
    expect(long.length).toBeLessThanOrEqual(16);
    expect(long.endsWith("…")).toBe(true);
    expect(plainToolError("some random english failure")).toBe("没做成");
    expect(plainToolError("")).toBe("没做成");
  });

  // 半角冒号：扩展回执用 "未找到元素: #gone"，选择子不能漏进侧栏（BYS-114 回放实测抓到）。
  it("半角冒号尾巴和全角一样剥掉", () => {
    expect(plainToolError("未找到元素: #gone")).toBe("没找到目标");
  });
});

describe("RepeatedToolFailurePolicy", () => {
  const wire = (onRepeat: (f: { toolName: string; error: string; attempts: number }) => void) => {
    const policy = new RepeatedToolFailurePolicy(onRepeat);
    let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
    policy.extension()({ on: (name: string, fn: typeof handler) => { if (name === "tool_result") handler = fn; return () => {}; } } as never);

    const fail = (url: string) => handler!({
      type: "tool_result", toolCallId: `c-${url}`, toolName: "fetch",
      input: { url }, content: [{ type: "text", text: `HTTP 0 (not ok) unknown content-type; 0 bytes. Empty body.` }],
      isError: true,
    }, {});
    const ok = (url: string) => handler!({
      type: "tool_result", toolCallId: `c-${url}-ok`, toolName: "fetch",
      input: { url }, content: [{ type: "text", text: "HTTP 200 application/json; 12 bytes." }],
      isError: false,
    }, {});

    return { fail, ok };
  };

  it("三个不同 URL 各自失败一次不算重复，不升档", () => {
    const calls: unknown[] = [];
    const { fail } = wire(f => calls.push(f));
    fail("https://a.example/1");
    fail("https://b.example/2");
    fail("https://c.example/3");
    expect(calls).toHaveLength(0);
  });

  it("同一 URL 第二次同样失败才升档一次", () => {
    const calls: Array<{ attempts: number }> = [];
    const { fail } = wire(f => calls.push(f));
    fail("https://a.example/1");
    fail("https://a.example/1");
    fail("https://a.example/1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.attempts).toBe(2);
  });

  it("成功一次清掉同工具的失败记录", () => {
    const calls: unknown[] = [];
    const { fail, ok } = wire(f => calls.push(f));
    fail("https://a.example/1");
    ok("https://a.example/1");
    fail("https://a.example/1");
    expect(calls).toHaveLength(0);
  });
});
