import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { checkGoal } from "./goal-check.js";
import type { SideCallHost } from "./side-judgment.js";

const model = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  api: "openai-responses",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 32_000,
} as unknown as Model<Api>;

function stubHost(replyJson: Record<string, unknown>): SideCallHost {
  return {
    models: {
      completeSimple: async () => ({
        role: "assistant",
        api: "openai-responses",
        provider: "openai-codex",
        model: "gpt-6-luna",
        timestamp: Date.now(),
        content: [{ type: "text", text: JSON.stringify(replyJson) }],
        stopReason: "stop",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } as unknown as AssistantMessage),
    },
  };
}

const baseInput = {
  goal: ["点击第一行第二个"],
  goalPage: { title: "YouTube", url: "https://www.youtube.com/" },
  page: { title: "YouTube", url: "https://www.youtube.com/", text: "开始观看视频吧，帮助我们为你打造推荐内容动态" },
  facts: {
    navigation: { originTabId: 1, tabs: [{ tabId: 1, url: "https://www.youtube.com/", created: false }], truncated: false },
    actions: [],
    typedNotFromUser: [],
    searchedNotFromUser: [],
  },
};

test("pointed target missing on goalPage does not loop continue when assistant stayed on page", async () => {
  const verdict = await checkGoal(
    stubHost({
      items: [{ text: "点击第一行第二个", done: false }],
      goalOnPage: true,
      pointedFound: false,
      status: "continue",
      repair: "complete_task",
      verificationSubject: "answer",
      evidence: "当前首页没有视频列表，无法点击第一行第二个。",
      remaining: "点击第一行第二个",
      correction: "首页没有视频列表，尚未完成点击。",
      finding: "首页没有视频列表，因此尚未点击第一行第二个",
    }),
    model,
    { ...baseInput, lastReply: "当前首页没有视频列表，无法点击第一行第二个。" },
    AbortSignal.timeout(5_000),
  );
  assert.equal(verdict.status, "blocked");
  assert.equal(verdict.cause, "missing");
});

test("pointed target missing still requests correction when assistant falsely claimed success", async () => {
  const verdict = await checkGoal(
    stubHost({
      items: [{ text: "点击第一行第二个", done: false }],
      goalOnPage: true,
      pointedFound: false,
      status: "continue",
      repair: "correct_result",
      verificationSubject: "answer",
      evidence: "已经帮你点击了第一行第二个视频。",
      remaining: "更正回答",
      correction: "页面上并没有视频列表，回答错误声称已点击。",
      finding: "页面没有视频列表，但回答声称已点击",
    }),
    model,
    { ...baseInput, lastReply: "已经帮你点击了第一行第二个视频。" },
    AbortSignal.timeout(5_000),
  );
  assert.equal(verdict.status, "continue");
  assert.equal(verdict.verificationSubject, "answer");
});
