// 工具执行身份显式绑定：download_delete 先读 download_stat、await 之后再删。
// 两次执行交错：A、B 都在等 stat 时先放行 A，A 随后发出的 delete 必须仍登记在 A 的调用 ID 下。
// 扩展里没有 AsyncLocalStorage，若退化成「当前作用域」全局变量，A 的 delete 会拿到最后开始的 B 的 ID。
import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../src/tools.js";

function harness() {
  const calls: Array<[string, string | undefined]> = [];
  const stats: Array<() => void> = [];

  const rpc = {
    call: (name: string, _params: { downloadId: string }, _timeout?: number, _sid?: string, _program?: string, _epoch?: number, sdkId?: string) => {
      calls.push([name, sdkId]);

      if (name === "download_stat") return new Promise<{ exists: boolean }>(resolve => { stats.push(() => resolve({ exists: true })); });

      return Promise.resolve({ deleted: true });
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
    const remove = tools.find(tool => tool.name === "download_delete");

    if (!remove) throw new Error("没有 download_delete 工具");
    // SAFETY: download_delete 不读取执行上下文参数。
    const ctx = undefined as never;
    const first = remove.execute("call-A", { downloadId: "dl-A" }, undefined, undefined, ctx);
    const second = remove.execute("call-B", { downloadId: "dl-B" }, undefined, undefined, ctx);

    await expect.poll(() => stats.length).toBe(2);
    stats[0]!();
    await first;
    stats[1]!();
    await second;

    expect(calls).toEqual([["download_stat", "call-A"], ["download_stat", "call-B"], ["download_delete", "call-A"], ["download_delete", "call-B"]]);
  });
});
