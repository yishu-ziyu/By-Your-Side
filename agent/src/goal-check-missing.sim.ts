import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { checkGoal, GOAL_CHECK_PROMPT } from "./goal-check.js";
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

test("pointed target missing preserves continue when repair is omitted to avoid swallowing false-success correction", async () => {
  const verdict = await checkGoal(
    stubHost({
      items: [{ text: "点击第一行第二个", done: false }],
      goalOnPage: true,
      pointedFound: false,
      status: "continue",
      verificationSubject: "answer",
      evidence: "已经帮你点击了第一行第二个视频。",
      remaining: "更正回答",
      correction: "页面没有视频列表，回答错误声称已点击。",
      finding: "回答错误声称已点击",
    }),
    model,
    { ...baseInput, lastReply: "已经帮你点击了第一行第二个视频。" },
    AbortSignal.timeout(5_000),
  );
  assert.equal(verdict.status, "continue");
});

test("pointed target missing preserves continue when page observation is truncated", async () => {
  const verdict = await checkGoal(
    stubHost({
      items: [{ text: "点击页面底部的更多链接", done: false }],
      goalOnPage: true,
      pointedFound: false,
      status: "continue",
      repair: "complete_task",
      verificationSubject: "answer",
      evidence: "目前只看到首屏内容，还没滚动查看页面下方。",
      remaining: "继续向下滚动查找",
      correction: "页面被截断，尚未检查页面下方区域。",
      finding: "尚未检查截断部分",
    }),
    model,
    { ...baseInput, page: { ...baseInput.page, text: "长页面首屏内容。".repeat(1200) }, lastReply: "没找到该链接。" },
    AbortSignal.timeout(5_000),
  );
  assert.equal(verdict.status, "continue");
});

test("goal check prompt forbids deriving tasks from unrelated goalPage title or query and preserves clarification questions", () => {
  assert.match(GOAL_CHECK_PROMPT, /goalPage[\s\S]*background context only[\s\S]*never add requirements/i);
  assert.match(GOAL_CHECK_PROMPT, /clarify an ambiguous term/i);
});

test("multi-part reply with consequential user question in first paragraph still yields needs_user", async () => {
  const firstParagraph = "表单已经填好，要我现在点提交吗？";
  const secondParagraph = "另外你问的第二件事已经查清：公告写明董事会已于今日投票通过恢复原职务，市场开盘前出现明显上涨，并附带了多家媒体的报道链接与具体时间线细节。".repeat(3);
  const verdict = await checkGoal(
    stubHost({
      items: [{ text: "提交表单", done: false }, { text: "查最新消息", done: true }],
      goalOnPage: false,
      status: "continue",
      repair: "complete_task",
      verificationSubject: "answer",
      evidence: firstParagraph,
      remaining: "提交表单",
      correction: "直接点击提交按钮。",
      finding: "表单尚未提交",
    }),
    model,
    {
      ...baseInput,
      goal: ["帮我填表并在提交前问我，另外查一下最新消息"],
      lastReply: `${firstParagraph}\n\n${secondParagraph}`,
    },
    AbortSignal.timeout(5_000),
  );
  assert.equal(verdict.status, "needs_user");
});

const ambiguous = "你是指社交平台 X，还是某个具体名字里带 X 的东西？";
const independentReading = "第一项青松是昨天发布的。第二项还没读完。要不要我接着读取第二项再整理？";

async function checkAnswerRepair(reply: string, evidence: string, repair: "complete_task" | "correct_result") {
  let adjustment: string | undefined;
  const verdict = await checkGoal(
    stubHost({ status: "continue", goalOnPage: false, repair, evidence, verificationSubject: "answer",
      items: [{ text: "第一件事", done: false }], remaining: "第一件事", correction: "补全回答" }),
    model, { ...baseInput, goal: ["查一下 X，另外整理两项公告"], lastReply: reply },
    AbortSignal.timeout(5_000), undefined, { checkId: "clarify", record: event => { adjustment = event.adjustedBy; } },
  );
  return { status: verdict.status, adjustment };
}

test("回答完另一件事后，模型拿第一段的歧义反问要求重做，应等待用户", async () => {
  const reply = `X 这个我还没对上，${ambiguous}\n\n两项公告都已整理好。第一项青松昨天发布，第二项白桦今天发布。`;
  assert.deepEqual(await checkAnswerRepair(reply, ambiguous, "complete_task"), { status: "needs_user", adjustment: "clarification_question" });
});

test("助手自己能继续读第二项时保持 continue", async () => {
  assert.equal((await checkAnswerRepair(independentReading, independentReading, "complete_task")).status, "continue");
});

test("虚报完成后仍须纠正，即使模型引用了同一段中的反问", async () => {
  const reply = `已在社交平台 X 找到并核实了这条公告。${ambiguous}`;
  assert.equal((await checkAnswerRepair(reply, ambiguous, "correct_result")).status, "continue");
});
