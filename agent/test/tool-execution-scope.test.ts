// 工具执行身份显式绑定：browser_run 的每一步在 await 之后发出的调用仍登记在自己那次执行下。
// 两次执行交错：A、B 都在等第一步时先放行 A，A 随后发出的第二步必须仍登记在 A 的调用 ID 下。
// 扩展里没有 AsyncLocalStorage，若退化成「当前作用域」全局变量，A 的第二步会拿到最后开始的 B 的 ID。
import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../src/tools.js";

function harness() {
  const calls: Array<[string, string | undefined]> = [];
  const pending: Array<(value: { text: string }) => void> = [];

  const rpc = {
    call: (name: string, _params: { tabId?: number }, _timeout?: number, _sid?: string, _program?: string, _epoch?: number, sdkId?: string) => {
      calls.push([name, sdkId]);

      if (name === "snapshot") return new Promise(resolve => { pending.push(resolve); });

      return Promise.reject(new Error(`unexpected ${name}`));
    },
    ensureToolCall: () => {},
    markCallRejected: () => {},
    noteToolFact: () => {},
    getPageTarget: () => 1,
  };

  // SAFETY: createBrowserTools 只用到 rpc 的这几个成员。
  const tools = createBrowserTools(rpc as never, undefined, undefined, () => true, { epoch: () => 1, canWrite: () => true });

  return { tools, calls, pending };
}

describe("工具执行身份", () => {
  it("交错执行时，await 之后的调用仍登记在自己的调用 ID 下", async () => {
    const { tools, calls, pending } = harness();
    const run = tools.find(tool => tool.name === "browser_run");

    if (!run) throw new Error("没有 browser_run 工具");
    // SAFETY: browser_run 不读取执行上下文参数。
    const ctx = undefined as never;
    const code = "await browser.snapshot(); await browser.snapshot(); return 'ok';";
    const first = run.execute("call-A", { code }, undefined, undefined, ctx);
    const second = run.execute("call-B", { code }, undefined, undefined, ctx);

    await expect.poll(() => pending.length).toBe(2);
    pending[0]!({ text: "A1" });
    await expect.poll(() => pending.length).toBe(3);
    pending[2]!({ text: "A2" });
    await expect(first).resolves.toBeDefined();
    pending[1]!({ text: "B1" });
    await expect.poll(() => pending.length).toBe(4);
    pending[3]!({ text: "B2" });
    await expect(second).resolves.toBeDefined();

    expect(calls).toEqual([["snapshot", "call-A/1"], ["snapshot", "call-B/1"], ["snapshot", "call-A/2"], ["snapshot", "call-B/2"]]);
  });
});
