/**
 * docs/evals/20261007-goal-continue-same-page.md R1、R4 与反例（宿主一侧）。
 * 走真实会话（扩展里的循环 + 脚本模型）；核对模型按脚本判「没做完」，标签页地址由替身 rpc 给出。
 * 复现 10-07 everyday 翻译：交付一半后核对判续做，此时标签页已换成下一个网页，续做读的是新网页。
 *
 * 先列出会出错的方式：
 * P1 核对期间用户把标签页换到别的网页，宿主仍发 [GOAL CHECK]，续做的动作落在新网页上。
 * P2 换了页不续做，但结果没有收成「还差」（任务看起来像做完了，用户不知道还差什么）。
 * P3 只是换了页内锚点（#section），也被当成换页，不再续做。
 * P4 页面没换、确实漏做，也不续做了（把正常续做一起关掉）。
 * P5 核对期间用户补充了新任务或点了停止，宿主仍续做原任务。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import { defineTool } from "../src/define-tool.js";
import { TaskProgress } from "../src/task-progress.js";
import type { AgentUiEvent, PageContext } from "../../shared/protocol.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const model: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024,
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

const GOAL = "把这个页面翻译成中文。";

const ARTICLE: PageContext = { tabId: 7, title: "Your AI Product Needs Evals", url: "https://hamel.dev/blog/posts/evals/" };

const NEXT_PAGE = "https://example.org/next-test-page";

const REMAINING = "翻译剩下的段落";

const HALF = "已翻好前一半段落，后一半还没翻。";

/** 每轮：先读页，再说翻好了一半。 */
const step = (n: number): AssistantMessage => (n % 2 === 0 ? message([{ type: "toolCall", id: `r${n}`, name: "read_page", arguments: {} }], "toolUse") : message([{ type: "text", text: HALF }], "stop"));

async function until(probe: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();

  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** duringCheck：核对模型给结论之前，模拟用户在这段时间里做的事。 */
async function session(duringCheck: (h: { setUrl: (url: string) => void; host: BrowserAgentSession; progress: TaskProgress }) => void) {
  const traceDir = mkdtempSync(join(tmpdir(), "bys-goal-same-page-"));
  dirs.push(traceDir);
  process.env.SIDEAGENT_TRACE_DIR = traceDir;
  const emitted: AgentUiEvent[] = [];
  const received: Context[] = [];
  const readsOn: string[] = [];
  const progress = new TaskProgress("default");
  let tabUrl = ARTICLE.url;
  let judged = 0;
  let host: BrowserAgentSession;

  const streamSimple: ModelPort["streamSimple"] = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const n = received.length;
    received.push(structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }));
    const reply = options?.signal?.aborted || n >= 12 ? message([{ type: "text", text: "好的。" }], "stop") : step(n);
    setTimeout(() => stream.push({ type: "done", reason: reply.stopReason === "toolUse" ? "toolUse" : "stop", message: reply }), 0);

    return stream;
  };

  const completeSimple: ModelPort["completeSimple"] = async () => {
    judged += 1;

    if (judged === 1) duringCheck({ setUrl: url => { tabUrl = url; }, host, progress });

    return message([{ type: "text", text: JSON.stringify({ status: "continue", remaining: REMAINING }) }], "stop");
  };

  const port: ModelPort = { getModel: () => model, getAvailable: async () => [model], completeSimple, streamSimple };

  const readPage = defineTool({ name: "read_page", label: "read", description: "read", parameters: Type.Object({}), execute: async () => {
    readsOn.push(tabUrl);

    return { content: [{ type: "text" as const, text: "<page-content untrusted>段落</page-content>" }], details: {} };
  } });

  // 替身 rpc 的 snapshot 回当前标签页地址（生产的 snapshot 工具回 { text, url, title }）。
  const rpc = { call: vi.fn(async () => ({ text: "段落", url: tabUrl, title: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => ARTICLE.tabId, setPageTarget: vi.fn(),
    getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

  // SAFETY: 替身实现了会话用到的全部 ToolRpc 方法；自定义工具与生产工具同用 defineTool 生成。
  host = await BrowserAgentSession.create(rpc as never, { emit: event => { emitted.push(event); progress.observe({ type: "agent_event", event }); },
    setStatus: state => progress.observe({ type: "status", state }) },
    { loop: { models: port, cwd: "/tmp" }, modelPattern: "probe/probe", conversationId: "default", customTools: [readPage as never] });

  host.bindConversationContext(() => progress.snapshot());
  host.bindDeliveryRun(() => progress.snapshot().runId ?? null);
  progress.request(GOAL, ARTICLE);
  host.startTask(GOAL, ARTICLE);

  return { host, emitted, received, readsOn, judgedCount: () => judged };
}

const textOf = (content: UserMessage["content"]): string => (Array.isArray(content) ? content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("") : content);

const nudges = (received: Context[]) => [...new Set(received.flatMap(context => context.messages.flatMap(item => (item.role === "user" ? [textOf(item.content)] : []))).filter(text => text.startsWith("[GOAL CHECK]")))];

const goalChecks = (emitted: AgentUiEvent[]) => emitted.flatMap(event => (event.kind === "goal_check" ? [event] : []));

const settle = () => new Promise(resolve => setTimeout(resolve, 400));

describe("goal check continues only on the page the answer was given on", () => {
  it("the user moved the tab to another site during the check → no continuation, settled as still open (P1, P2)", async () => {
    const h = await session(({ setUrl }) => setUrl(NEXT_PAGE));

    try {
      await until(() => goalChecks(h.emitted).length > 0, "the goal-check outcome");
      await settle();

      expect(nudges(h.received)).toEqual([]);
      expect(h.readsOn).toEqual([ARTICLE.url]);
      expect(goalChecks(h.emitted)).toEqual([{ kind: "goal_check", status: "open", remaining: REMAINING }]);
    } finally {
      h.host.abort();
    }
  }, 20_000);

  it("same page (only the #anchor changed) and work really missed → still continues on that page (P3, P4)", async () => {
    const h = await session(({ setUrl }) => setUrl(`${ARTICLE.url}#section-2`));

    try {
      await until(() => h.readsOn.length >= 2, "the continuation's first read");

      expect(nudges(h.received)).toHaveLength(1);
      expect(goalChecks(h.emitted)[0]).toEqual({ kind: "goal_check", status: "continue", remaining: REMAINING });
      expect(h.readsOn[1]).toBe(`${ARTICLE.url}#section-2`);
    } finally {
      h.host.abort();
    }
  }, 20_000);

  it("the user stopped during the check → no continuation (P5)", async () => {
    const h = await session(({ host }) => host.abort());

    try {
      await until(() => h.judgedCount() > 0, "the goal check");
      await settle();

      expect(nudges(h.received)).toEqual([]);
      expect(h.readsOn).toEqual([ARTICLE.url]);
      expect(goalChecks(h.emitted).filter(event => event.status === "continue")).toEqual([]);
    } finally {
      h.host.abort();
    }
  }, 20_000);

  it("the user sent a new request during the check → the old task does not continue (P5)", async () => {
    const NEW = "这页的作者是谁？";
    const h = await session(({ host, progress }) => { progress.request(NEW, ARTICLE); host.startTask(NEW, ARTICLE); });

    try {
      await until(() => h.judgedCount() > 0, "the goal check");
      await settle();

      expect(nudges(h.received)).toEqual([]);
      expect(goalChecks(h.emitted).filter(event => event.status === "continue")).toEqual([]);
    } finally {
      h.host.abort();
    }
  }, 20_000);
});
