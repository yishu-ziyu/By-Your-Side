// 模型调用不存在的工具（如 bash）时，下一轮它看到的结果要说明没执行，并列出当前可用工具。
import { describe, expect, it } from "vitest";
import { PiAgentLoop } from "../src/pi-agent-loop.js";
import { probeModel, scriptedModels } from "./fixtures/scripted-loop.js";

const pageTool = { name: "browser_run", label: "browser_run", description: "page", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) };

describe("调用不存在的工具", () => {
  it("下一轮的工具结果说明没有执行并列出可用工具", async () => {
    // SAFETY: 最小工具桩，只含循环用到的字段。
    const tools = [pageTool as never];
    const models = scriptedModels([() => [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]]);
    const loop = new PiAgentLoop({ models, model: probeModel, tools, systemPrompt: "SYS", appendPrompt: () => [], cwd: "/tmp", extensionFactories: [] });

    await loop.prompt("列出文件");

    // SAFETY: 脚本模型记下的是 Pi 消息的结构化克隆，toolResult 带文本内容。
    const results = (models.inputs[1]!.messages as Array<{ role: string; content: Array<{ text: string }> }>).filter(message => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]!.content[0]!.text).toBe("工具 bash 不存在，没有执行。可用工具：browser_run。操作页面请用 browser_run。");
  });
});
