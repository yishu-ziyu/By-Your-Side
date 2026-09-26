// 工具执行身份显式绑定：download_save_as 读 download_stat，没下完就 await 之后再读。
// 两次执行交错：A、B 都在等 stat 时先放行 A，A 随后发出的第二次 stat 必须仍登记在 A 的调用 ID 下。
// 扩展里没有 AsyncLocalStorage，若退化成「当前作用域」全局变量，A 的第二次 stat 会拿到最后开始的 B 的 ID。
import { describe, expect, it } from "vitest";
import type { DownloadStatLike } from "../src/download-artifacts.js";
import { createBrowserTools } from "../src/tools.js";

function harness() {
  const calls: Array<[string, string | undefined]> = [];
  const stats: Array<(stat: DownloadStatLike) => void> = [];

  const rpc = {
    call: (name: string, _params: { downloadId: string }, _timeout?: number, _sid?: string, _program?: string, _epoch?: number, sdkId?: string) => {
      calls.push([name, sdkId]);

      if (name === "download_stat") return new Promise(resolve => { stats.push(resolve); });

      return Promise.reject(new Error(`unexpected ${name}`));
    },
    ensureToolCall: () => {},
    markCallRejected: () => {},
    noteToolFact: () => {},
    getPageTarget: () => 1,
  };

  // SAFETY: createBrowserTools 只用到 rpc 的这几个成员。
  const tools = createBrowserTools(rpc as never, undefined, undefined, () => true, { epoch: () => 1, canWrite: () => true });

  return { tools, calls, stats };
}

describe("工具执行身份", () => {
  it("交错执行时，await 之后的调用仍登记在自己的调用 ID 下", async () => {
    const { tools, calls, stats } = harness();
    const save = tools.find(tool => tool.name === "download_save_as");

    if (!save) throw new Error("没有 download_save_as 工具");
    // SAFETY: download_save_as 不读取执行上下文参数。
    const ctx = undefined as never;
    const pending = { tabId: 1, url: "https://x.test/f", suggestedFilename: "f", path: null, failure: null, completed: false, cancelled: false };
    const failed = { ...pending, failure: "NETWORK_FAILED" };
    const first = save.execute("call-A", { downloadId: "dl-A", path: "/tmp/bys-scope-a" }, undefined, undefined, ctx);
    const second = save.execute("call-B", { downloadId: "dl-B", path: "/tmp/bys-scope-b" }, undefined, undefined, ctx);

    await expect.poll(() => stats.length).toBe(2);
    stats[0]!({ ...pending, downloadId: "dl-A" });
    await expect.poll(() => stats.length).toBe(3);
    stats[2]!({ ...failed, downloadId: "dl-A" });
    await expect(first).rejects.toThrow(/NETWORK_FAILED/);
    stats[1]!({ ...failed, downloadId: "dl-B" });
    await expect(second).rejects.toThrow(/NETWORK_FAILED/);

    expect(calls).toEqual([["download_stat", "call-A"], ["download_stat", "call-B"], ["download_stat", "call-A"]]);
  });
});
