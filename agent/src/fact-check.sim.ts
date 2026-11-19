import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { checkFacts } from "./fact-check.js";
import type { SideCallHost } from "./side-judgment.js";

const MODEL = {
  id: "MiniMax-M3",
  name: "MiniMax-M3",
  api: "anthropic-messages",
  provider: "minimax-cn",
  baseUrl: "http://127.0.0.1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} as unknown as Model<Api>;

function reply(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "minimax-cn",
    model: "MiniMax-M3",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("checkFacts uses low reasoning effort and preserves grounded contradiction filtering", async () => {
  let seenReasoning: unknown = null;
  let seenSystem = "";
  const host: SideCallHost = {
    models: {
      completeSimple: async (_model, context, options) => {
        seenReasoning = options?.reasoning;
        seenSystem = context.systemPrompt ?? "";
        return reply(JSON.stringify({
          problems: [
            { kind: "contradiction", claim: "限时价 ¥999。", source: "商品页", quote: "限时价 ¥899", text: "价格不对" },
            { kind: "contradiction", claim: "有货。", source: "商品页", quote: "不存在的原文", text: "编造引文" },
          ],
        }));
      },
    },
  };

  const flags = await checkFacts(host, MODEL, {
    request: "看价格",
    answer: "限时价 ¥999。有货。",
    seen: "商品页：限时价 ¥899",
    pageNow: "",
  }, new AbortController().signal);

  assert.equal(seenReasoning, "low");
  assert.match(seenSystem, /summaries.*paraphrases|paraphrases/i);
  assert.doesNotMatch(seenSystem, /\busually\b|a handful/i);
  assert.match(seenSystem, /binding limits|eligibility|material exceptions/i);
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.quote, "限时价 ¥899");
});
