/**
 * 测试用的扩展内会话循环模型：本地、有限、不联网。会话循环只有扩展内这一种（pi-agent-core），
 * 测试经 `loop: { models: scriptedModels(...), cwd }` 走与扩展同一条装配。
 * replies 按调用顺序给出每轮回复；用完后回一句正文收尾。inputs 记下每次主循环请求的系统提示词与工具。
 */
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelPort } from "../../src/agent-loop.js";
import { seenByModel } from "./seen-by-model.js";

export const PROBE_PATTERN = "probe/probe";

export const probeModel: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024,
};

export function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: probeModel.api, provider: probeModel.provider, model: probeModel.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

export type ScriptedInput = { systemPrompt?: string; tools?: Array<{ name: string; description: string }>; messages: unknown[] };

export function scriptedModels(replies: Array<(input: ScriptedInput) => AssistantMessage["content"]> = [], finalText: string | null = "完成。"): ModelPort & { inputs: ScriptedInput[] } {
  const inputs: ScriptedInput[] = [];

  const streamSimple: ModelPort["streamSimple"] = (_model, context) => {
    const stream = createAssistantMessageEventStream();
    // 只记模型可见的元数据：Pi 的工具对象还带执行函数，不能整份克隆。
    const seen = seenByModel(context);
    const input: ScriptedInput = { systemPrompt: seen.systemPrompt, tools: seen.tools?.map(({ name, description }) => ({ name, description })), messages: structuredClone(seen.messages) };
    inputs.push(input);
    const content = replies.shift()?.(input) ?? (finalText === null ? [] : [{ type: "text" as const, text: finalText }]);
    const reply = assistantMessage(content, content.some(part => part.type === "toolCall") ? "toolUse" : "stop");
    setTimeout(() => stream.push({ type: "done", reason: reply.stopReason === "stop" ? "stop" : "toolUse", message: reply }), 0);

    return stream;
  };

  const completeSimple: ModelPort["completeSimple"] = async () => assistantMessage([{ type: "text", text: JSON.stringify({ status: "done" }) }], "stop");

  return { inputs, getModel: () => probeModel, getAvailable: async () => [probeModel], completeSimple, streamSimple };
}
