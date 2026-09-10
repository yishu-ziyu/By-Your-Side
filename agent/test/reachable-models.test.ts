import { describe, expect, it } from "vitest";
import { filterReachableModels, REACHABLE_MODEL_IDS } from "../src/reachable-models.js";
import type { ModelOption } from "../../shared/protocol.js";

function option(id: string): ModelOption {
  const slash = id.indexOf("/");
  return { id, provider: id.slice(0, slash), modelId: id.slice(slash + 1), name: id.slice(slash + 1) };
}

describe("filterReachableModels", () => {
  it("keeps only the five selected models in catalog order", () => {
    const listed = [
      option("minimax-cn/MiniMax-M2.7"),
      option("minimax-cn/MiniMax-M3"),
      option("cliproxy/grok-4.6"),
      option("cli-proxy/gemini-3.8-flash-high"),
      option("xai/grok-4.3"),
      option("xai/grok-4.6"),
      option("xiaomi-token-plan-cn/mimo-v2.5-pro"),
      option("xiaomi-token-plan-cn/mimo-v2.5"),
      option("opencode-go/deepseek-flash"),
    ];
    expect(filterReachableModels(listed).map((m) => m.id)).toEqual([
      "minimax-cn/MiniMax-M3",
      "xai/grok-4.6",
      "xiaomi-token-plan-cn/mimo-v2.5-pro",
      "xiaomi-token-plan-cn/mimo-v2.5",
      "opencode-go/deepseek-flash",
    ]);
  });

  it("hides the dropped models and providers that did not answer the probe", () => {
    const hidden = [
      "minimax-cn/MiniMax-M2.7",
      "minimax-cn/MiniMax-M2.7-highspeed",
      "xai/grok-4.3",
      "xai/grok-4.5",
      "cliproxy/grok-4.6",
      "cliproxy/gemini-3.1-pro-low",
      "cli-proxy/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
      "antigravity/gemini-3.5-flash-high",
      "kimi-coding/kimi-for-coding",
      "openai-codex/gpt-5.6-luna",
    ];
    expect(filterReachableModels(hidden.map(option))).toEqual([]);
    for (const id of hidden) expect(REACHABLE_MODEL_IDS.has(id)).toBe(false);
  });

  it("keeps the current session model even when it is not in the allowlist", () => {
    const listed = [option("kimi-coding/kimi-for-coding"), option("minimax-cn/MiniMax-M3")];
    expect(filterReachableModels(listed, "kimi-coding/kimi-for-coding").map((m) => m.id)).toEqual([
      "kimi-coding/kimi-for-coding",
      "minimax-cn/MiniMax-M3",
    ]);
  });
});
