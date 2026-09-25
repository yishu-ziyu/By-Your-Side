/**
 * 通用页面 JS 的闸：任何一个被禁用的写工具都会让 js 整体拒绝（防绕过）。
 * docs/evals/20260925-sitegeist-parity.md：真实会话里「启用」= 挂给模型的工具，而 WRITE_TOOLS 里的
 * disarm_event 没有模型工具，于是永远算未启用，js 在所有模式下都被拒。这里按真实会话的方式判断启用：
 * 只有 createBrowserTools 实际创建出来的工具才算启用。
 */
import { describe, expect, it, vi } from "vitest";
import { createBrowserTools } from "../src/tools.js";

function harness(disabled: string[] = []) {
  const rpc = {
    call: vi.fn(async (name: string) => (name === "js" ? { value: "ran" } : {})),
    ensureToolCall: vi.fn(),
    markCallRejected: vi.fn(),
    noteToolFact: vi.fn(),
    getPageTarget: () => 1,
  };

  const options = { epoch: () => 1, canWrite: () => true };
  // take_tab 是会话常驻挂载的模型工具，不由 createBrowserTools 创建。
  // SAFETY: rpc 只实现了闸门路径用到的方法；工具参数与上下文按 js 的契约给出，测试不读其余字段。
  const modelTools = new Set([...createBrowserTools(rpc as never, undefined, undefined, () => true, options).map((tool) => tool.name), "take_tab"]);
  // SAFETY: 同上，rpc 桩只覆盖闸门路径。
  const tools = createBrowserTools(rpc as never, undefined, undefined, (name) => modelTools.has(name) && !disabled.includes(name), options);
  const js = tools.find((tool) => tool.name === "js")!;

  // SAFETY: js 的参数只有 code；上下文参数闸门不读取。
  return { rpc, run: () => js.execute("js-call", { code: "document.title" } as never, undefined, undefined, {} as never) };
}

describe("通用页面 JS 的闸", () => {
  it("所有挂给模型的写工具都启用时，js 照常执行", async () => {
    const { rpc, run } = harness();

    await run();
    expect(rpc.call.mock.calls.some((call) => call[0] === "js")).toBe(true);
  });

  it("禁用 arm_event（事件订阅的模型入口）时，js 仍被拒绝", async () => {
    const { rpc, run } = harness(["arm_event"]);

    await expect(run()).rejects.toThrow(/通用页面 JS 不可用：工具 arm_event 当前未启用/);
    expect(rpc.call.mock.calls.some((call) => call[0] === "js")).toBe(false);
  });

  it("禁用 fill 时，js 仍被拒绝", async () => {
    const { rpc, run } = harness(["fill"]);

    await expect(run()).rejects.toThrow(/通用页面 JS 不可用：工具 fill 当前未启用/);
    expect(rpc.call.mock.calls.some((call) => call[0] === "js")).toBe(false);
  });
});
