// 扩展里的循环用 ExtensionHost 执行我们的 Pi 钩子；组合规则须与 pi-coding-agent 的 ExtensionRunner 一致。
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ExtensionHost, type HookResult } from "../src/extension-host.js";
import { ProductContext } from "../src/product-context.js";
import { RepeatedToolFailurePolicy } from "../src/tool-failure-policy.js";
import { TOOL_FAILURE_LIMIT } from "../../shared/task-next-step.js";

type Listener = (event: { systemPrompt?: string; toolName?: string }) => HookResult | void;

/** 测试用钩子：只用 on，与我们的真实钩子同形。 */
function hook(event: string, listener: Listener): ExtensionFactory {
  // SAFETY: 返回的函数只接收 pi 并调用 on，与 ExtensionFactory 的调用方式一致。
  return (pi => {
    // SAFETY: 测试钩子的事件名与参数形状和我们的真实钩子一致，只调用 on。
    pi.on(event as never, listener as never);
  }) as ExtensionFactory;
}

function host(factories: ExtensionFactory[], active: string[] = []) {
  const errors: string[] = [];
  let aborted = 0;

  const value = new ExtensionHost({
    factories,
    allTools: () => active.map(name => ({ name, description: name, parameters: {} })),
    activeToolNames: () => active,
    abort: () => { aborted += 1; },
    onError: (event, message) => errors.push(`${event}: ${message}`),
  });

  return { value, errors, aborted: () => aborted };
}

describe("ExtensionHost 组合规则", () => {
  it("before_agent_start 按注册顺序接力改系统提示词", async () => {
    const { value } = host([
      hook("before_agent_start", e => ({ systemPrompt: `${e.systemPrompt}+A` })),
      hook("before_agent_start", e => ({ systemPrompt: `B+${e.systemPrompt}` })),
    ]);

    expect(await value.beforeAgentStart("做点什么", "BASE")).toBe("B+BASE+A");
  });

  it("钩子抛错只记录，后面的钩子照常执行", async () => {
    const { value, errors } = host([
      hook("before_agent_start", () => { throw new Error("坏了"); }),
      hook("before_agent_start", e => ({ systemPrompt: `${e.systemPrompt}+ok` })),
    ]);

    expect(await value.beforeAgentStart("x", "BASE")).toBe("BASE+ok");
    expect(errors).toEqual(["before_agent_start: 坏了"]);
  });

  it("tool_call 第一个 block 立即生效，后面的钩子不再执行", async () => {
    const seen: string[] = [];

    const { value } = host([
      hook("tool_call", () => {
        seen.push("first");

        return { block: true, reason: "不许" };
      }),
      hook("tool_call", () => { seen.push("second"); }),
    ]);

    expect(await value.toolCall("click", "c1", { target: "@3" })).toEqual({ block: true, reason: "不许" });
    expect(seen).toEqual(["first"]);
  });

  it("真实的产品上下文钩子：启用 task_goals 时在提示词前加执行约定、后加产品上下文", async () => {
    const context = new ProductContext();
    const { value } = host([context.extension()], ["task_goals", "snapshot"]);
    const prompt = await value.beforeAgentStart("圈出保存", "BASE PROMPT");

    expect(prompt.startsWith("# 执行约定\n")).toBe(true);
    expect(prompt).toContain("\n\nBASE PROMPT\n\n# Product conversation context\n");
  });

  it("真实的失败策略钩子：同一操作失败到上限时中止本轮", async () => {
    const stops: string[] = [];
    const policy = new RepeatedToolFailurePolicy(failure => stops.push(failure.toolName));
    const { value, aborted } = host([policy.extension()]);
    const failure = { toolName: "click", toolCallId: "c", input: { target: "@3" }, content: [{ type: "text", text: "找不到元素" }], isError: true };

    for (let i = 0; i < TOOL_FAILURE_LIMIT; i += 1) await value.toolResult({ ...failure, toolCallId: `c${i}` });

    expect(stops).toEqual(["click"]);
    expect(aborted()).toBe(1);
  });
});
