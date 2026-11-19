import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { sanitizeTrace } from "../../shared/trace-sanitize.js";
import { SideCallError, type SideCallHost } from "./side-judgment.js";
import { intactTranslationRequest, translationDestination } from "./translation-permission.js";

test("有删改或凭据的文字不能再作为页内写入授权", () => {
  const changed = String(sanitizeTrace("整页译文写回网页，token=demo；改为只发侧栏"));
  assert.equal(intactTranslationRequest(changed), false);
  for (const size of [24, 36, 64]) {
    const syntheticKey = "demo_" + "a".repeat(size);
    assert.equal(intactTranslationRequest("说明：" + syntheticKey), false);
  }
  assert.equal(intactTranslationRequest("把这两段译文以中英对照放回原文旁。"), true);
});

const MODEL = {
  id: "fixture",
  name: "fixture",
  api: "openai-completions",
  provider: "opendesign",
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
    api: "openai-completions",
    provider: "opendesign",
    model: "fixture",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("translationDestination allows >=10s budget for reasoning models", async () => {
  const seenMs: number[] = [];
  const orig = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => { seenMs.push(ms); return orig.call(AbortSignal, ms); }) as typeof AbortSignal.timeout;
  try {
    const host: SideCallHost = {
      models: {
        completeSimple: async () => reply(JSON.stringify({ destination: "scoped", permission: "把前两段放进网页", paragraphs: [1, 2] })),
      },
    };
    const result = await translationDestination(host, MODEL, ["把前两段放进网页，双语对照。"], undefined);
    assert.deepEqual(result, { destination: "scoped", paragraphs: [1, 2] });
    assert.ok(seenMs.length >= 1 && seenMs[0]! >= 10_000, `expected timeoutMs >= 10000, got ${JSON.stringify(seenMs)}`);
  } finally {
    AbortSignal.timeout = orig;
  }
});

test("translationDestination surfaces SideCallError on timeout instead of masking it as refusal", async () => {
  const host: SideCallHost = {
    models: {
      completeSimple: async (_model, _context, options) => new Promise<AssistantMessage>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("aborted")), { once: true });
      }),
    },
  };
  await assert.rejects(
    translationDestination(host, MODEL, ["把前两段放进网页，双语对照。"], undefined, AbortSignal.timeout(15)),
    (err: unknown) => err instanceof SideCallError && err.reason === "timeout",
  );
});

test("translationDestination still returns null for explicit none or malformed output", async () => {
  const host: SideCallHost = {
    models: {
      completeSimple: async () => reply(JSON.stringify({ destination: "none", permission: "", paragraphs: null })),
    },
  };
  const result = await translationDestination(host, MODEL, ["把前两段翻译在侧栏。"], undefined);
  assert.equal(result, null);
});
