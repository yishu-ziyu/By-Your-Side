import { describe, expect, it } from "vitest";
import { filterReachableModels, REACHABLE_MODEL_IDS } from "../src/reachable-models.js";
import type { ModelOption } from "../../shared/protocol.js";

function option(id: string): ModelOption {
  const slash = id.indexOf("/");
  return { id, provider: id.slice(0, slash), modelId: id.slice(slash + 1), name: id.slice(slash + 1) };
}

describe("filterReachableModels", () => {
  it("keeps probed-reachable MiniMax, xAI, pool, and Xiaomi models in catalog order", () => {
    const listed = [
      option("anthropic/claude-opus-4-6"),
      option("minimax-cn/MiniMax-M3"),
      option("kimi-coding/kimi-for-coding"),
      option("cliproxy/grok-4.6"),
      option("cliproxy/gpt-5.6-luna"),
      option("xiaomi-token-plan-cn/mimo-v2.5-pro"),
      option("openai-codex/gpt-5.4"),
      option("opencode-go/big-pickle"),
    ];
    expect(filterReachableModels(listed).map((m) => m.id)).toEqual([
      "minimax-cn/MiniMax-M3",
      "cliproxy/grok-4.6",
      "xiaomi-token-plan-cn/mimo-v2.5-pro",
    ]);
  });

  it("hides providers that did not answer the probe", () => {
    const hidden = [
      "anthropic/claude-haiku-4-5",
      "antigravity/gemini-3.5-flash-high",
      "kimi-coding/kimi-for-coding",
      "openai-codex/gpt-5.6-luna",
      "opencode-go/minimax-m2.5",
      "cliproxy/kimi-k2.7-code",
      "cliproxy/gpt-5.5",
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
