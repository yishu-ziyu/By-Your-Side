/**
 * docs/evals/20261001-offtopic-reply-diagnostics.md 标准 1–6。
 * 走真实会话（扩展里的循环 + 脚本模型，不读用户凭据），诊断记录写到临时目录。
 *
 * 诊断记录（标准 1–4）的失败方式：
 * D1 模型调用没有 model_request 行，或缺系统提示词 / 工具说明的 sha256 与字数；
 * D2 系统提示词、工具说明全文没写，或分段拼回后与模型实际收到的不一致（截断、乱序、漏段）；
 * D3 同一 sha256 的全文每次调用都重写，撑爆会话 8 MB 上限；
 * D4 宿主插入的上下文消息（任务状态快照）没记，或记的不是模型收到的那一版；
 * D5 图片指纹按 base64 文本算，和用户手里原图文件的 sha256 对不上；或把像素写进了记录；
 * D6 某行超过 256 KB 行上限被替换成摘要，全文丢失。
 *
 * 只读任务的目标核对（标准 5–6，10-01 修订后）的失败方式：
 * G1 用过工具的只读任务（没动页面、没存文件、没在问用户）答非所问仍直接收尾，不核对——不论它交付的是 partial（10-01 原样）还是自称做完；
 * G2 判 continue 后催续提示里没有用户这次的原话，助手仍回到上一个任务（10-01：交付了 Drive 上传状态）；
 * G3 纯聊天（没用工具，或只用了交付工具）也去核对，多一次快速模型调用。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ModelPort } from "../src/agent-loop.js";
import { BrowserAgentSession } from "../src/session.js";
import { TaskProgress } from "../src/task-progress.js";
import { createBrowserTools } from "../src/tools.js";
import type { AgentUiEvent, Attachment, PageContext } from "../../shared/protocol.js";
import { seenByModel } from "./fixtures/seen-by-model.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const model: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024,
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

type Step = (context: Context, call: number) => AssistantMessage;

/** 主模型按脚本回答，并把每次收到的 context 深拷贝留证；核对模型返回给定结论。 */
function models(step: Step, verdicts: Array<{ status: string; remaining?: string }>) {
  const received: Context[] = [];
  const judged: string[] = [];

  const streamSimple: ModelPort["streamSimple"] = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const call = received.length;
    const seen = seenByModel(context);
    received.push(structuredClone({ systemPrompt: seen.systemPrompt, messages: seen.messages, tools: (seen.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }));
    const reply = options?.signal?.aborted || call >= 8 ? message([{ type: "text", text: "好的。" }], "stop") : step(context, call);
    setTimeout(() => stream.push({ type: "done", reason: reply.stopReason === "toolUse" ? "toolUse" : "stop", message: reply }), 0);

    return stream;
  };

  const completeSimple: ModelPort["completeSimple"] = async (_model, context) => {
    judged.push(String(context.messages[0]?.content ?? ""));
    const verdict = verdicts[judged.length - 1] ?? { status: "done" };

    return message([{ type: "text", text: JSON.stringify(verdict) }], "stop");
  };

  const port: ModelPort = { getModel: () => model, getAvailable: async () => [model], completeSimple, streamSimple };

  return { port, received, judged };
}

async function until(probe: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();

  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** 与生产一样把会话事件喂给任务进度；每个会话一个诊断目录，好找到它的记录文件。 */
async function session(step: Step, verdicts: Array<{ status: string; remaining?: string }> = []) {
  const traceDir = mkdtempSync(join(tmpdir(), "bys-offtopic-trace-"));
  dirs.push(traceDir);
  process.env.SIDEAGENT_TRACE_DIR = traceDir;
  const emitted: AgentUiEvent[] = [];
  const progress = new TaskProgress("default");
  const scripted = models(step, verdicts);

  const rpc = { call: vi.fn(async () => ({ text: "" })), resolvePageParams: <T>(_n: string, p: T) => p, getPageTarget: () => null, setPageTarget: vi.fn(),
    getExecutionFact: () => undefined, getTransportId: () => undefined, wasDeclined: () => false, getFillReadback: () => undefined, prepareFillReadback: vi.fn(), addLateResultListener: vi.fn(), onLateResult: vi.fn() };

  // SAFETY: 会话建成前为空；browser_run 只在会话建成后才会被调用。
  const holder = { session: null as BrowserAgentSession | null };

  // SAFETY: 替身实现了会话与 browser_run 用到的全部 ToolRpc 方法。
  const tools = createBrowserTools(rpc as never, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, files: () => holder.session?.fileStore() })
    .filter(tool => tool.name === "browser_run");

  // SAFETY: 同上。
  holder.session = await BrowserAgentSession.create(rpc as never, { emit: event => { emitted.push(event); progress.observe({ type: "agent_event", event }); },
    setStatus: state => progress.observe({ type: "status", state }) },
    { loop: { models: scripted.port, cwd: "/tmp" }, modelPattern: "probe/probe", conversationId: "default", customTools: tools });

  const host = holder.session;
  host.bindConversationContext(() => progress.snapshot());
  host.bindDeliveryRun(() => progress.snapshot().runId ?? null);

  const start = (text: string, page: PageContext, attachments?: Attachment[]) => {
    progress.request(text, page, attachments);
    host.startTask(text, page, attachments);
  };

  const traceLines = () => readdirSync(traceDir).flatMap(name => readFileSync(join(traceDir, name), "utf8").split("\n").filter(Boolean));

  return { host, emitted, received: scripted.received, judged: scripted.judged, start, traceLines };
}

const ended = (emitted: AgentUiEvent[]) => emitted.filter(event => event.kind === "agent_end").length;

const textOf = (content: UserMessage["content"]): string => (Array.isArray(content) ? content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("") : content);

const userTexts = (context: Context): string[] => context.messages.flatMap(item => (item.role === "user" ? [textOf(item.content)] : []));

/** 本测试读到的诊断记录字段（system_prompt / tools_manifest / model_request / goal_check）。 */
interface TraceData {
  sha256?: string; index?: number; total?: number; text?: string;
  systemPromptSha256?: string; systemPromptChars?: number; toolsSha256?: string; toolCount?: number;
  injected?: Array<{ customType: string; text: string }>; images?: Array<{ sha256: string; mimeType: string; bytes: number }>;
  status?: string; remaining?: string; attempt?: number;
}

type TraceLine = { type: string; runId: string | null; data: TraceData };

/** 按 sha256 把分段全文拼回：只用记录本身（type、sha256、index、total、text）。 */
function fullText(lines: TraceLine[], type: string, sha256: string): string {
  const chunks = lines.filter(line => line.type === type && line.data.sha256 === sha256);
  const total = Number(chunks[0]?.data.total);
  expect(chunks).toHaveLength(total);

  return [...chunks].sort((a, b) => Number(a.data.index) - Number(b.data.index)).map(chunk => String(chunk.data.text)).join("");
}

const flomo: PageContext = { tabId: 1, title: "flomo", url: "https://v.flomoapp.com/mine" };

// 1×1 的 PNG：模拟用户附的歌单截图。指纹的对照是原图文件本身的 sha256（独立于实现里的 base64 解码）。
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("model_request diagnostics reconstruct what the model actually received", () => {
  it("records each call's system prompt, tools and injected context so they can be rebuilt verbatim; full text once per sha; image sha matches the original file (D1–D6)", async () => {
    const h = await session((_context, call) => (call === 0
      ? message([{ type: "toolCall", id: "t0", name: "browser_run", arguments: { code: "return 1 + 1;" } }], "toolUse")
      : message([{ type: "text", text: "还没找到歌单里的歌。" }], "stop")));

    const imageDir = mkdtempSync(join(tmpdir(), "bys-offtopic-image-"));

    dirs.push(imageDir);
    const imageFile = join(imageDir, "playlist.png");
    writeFileSync(imageFile, Buffer.from(PNG_BASE64, "base64"));
    const fileSha = createHash("sha256").update(readFileSync(imageFile)).digest("hex");

    try {
      h.start("在YouTube里面找到前两首歌。", flomo, [{ id: "a1", type: "image", name: "playlist.png", mimeType: "image/png", dataBase64: readFileSync(imageFile).toString("base64") }]);
      await until(() => ended(h.emitted) > 0, "the run");
      await until(() => h.traceLines().filter(line => line.includes('"type":"model_request"')).length >= h.received.length, "model_request lines");

      const raw = h.traceLines();
      // SAFETY: 每行是 TraceRecorder 写的 JSON 对象。
      const lines = raw.map(line => JSON.parse(line) as TraceLine);
      const requests = lines.filter(line => line.type === "model_request");

      expect(h.received.length).toBeGreaterThanOrEqual(2);
      expect(requests).toHaveLength(h.received.length);

      requests.forEach((request, i) => {
        const got = h.received[i]!;
        const systemPrompt = fullText(lines, "system_prompt", String(request.data.systemPromptSha256));
        expect(systemPrompt).toBe(got.systemPrompt);
        expect(request.data.systemPromptChars).toBe(got.systemPrompt!.length);
        expect(createHash("sha256").update(got.systemPrompt!).digest("hex")).toBe(request.data.systemPromptSha256);

        // SAFETY: 工具说明全文是 JSON 数组。
        const manifest = JSON.parse(fullText(lines, "tools_manifest", String(request.data.toolsSha256))) as Array<{ name: string; description: string; parameters: unknown }>;
        expect(manifest.map(({ name, description, parameters }) => ({ name, description, parameters }))).toEqual(JSON.parse(JSON.stringify(got.tools)));
        expect(request.data.toolCount).toBe(got.tools!.length);

        // 宿主插入的消息到模型那里是 user 消息；用户本人的话只有第一条。
        const texts = userTexts(got);
        const injected = request.data.injected ?? [];
        expect(injected.map(item => item.text)).toEqual(texts.slice(1));
        expect(injected.some(item => item.customType === "sideagent-result-projection")).toBe(true);

        expect(request.data.images).toEqual([{ sha256: fileSha, mimeType: "image/png", bytes: readFileSync(imageFile).length }]);
      });

      // 同一 sha256 的全文只写一次（两次调用提示词与工具不变）。
      expect(new Set(requests.map(request => request.data.systemPromptSha256)).size).toBe(1);
      const promptChunks = lines.filter(line => line.type === "system_prompt");
      expect(promptChunks).toHaveLength(Number(promptChunks[0]!.data.total));
      const toolChunks = lines.filter(line => line.type === "tools_manifest");
      expect(toolChunks).toHaveLength(Number(toolChunks[0]!.data.total));

      // 分段按全文长度计：每段不超过 16,000 字，拼回即原文。2026-10-04 删掉不用的工具与提示词段后，
      // 这次会话的提示词和工具说明各自落在一段里（此前合计超过两段）。
      for (const chunk of [...promptChunks, ...toolChunks]) expect(String(chunk.data.text).length).toBeLessThanOrEqual(16_000);
      expect(promptChunks.length + toolChunks.length).toBeGreaterThanOrEqual(2);

      expect(raw.every(line => Buffer.byteLength(line, "utf8") + 1 <= 256 * 1024)).toBe(true);
      expect(raw.some(line => line.includes(PNG_BASE64.slice(0, 40)))).toBe(false);
    } finally {
      h.host.abort();
    }
  }, 30_000);
});

describe("read-only runs that used tools are goal-checked; pure chat is not", () => {
  const DRIVE = "还差一步没确认：字幕的 Markdown 文件（火线S1E11-13解说字幕.md）已经生成好了，但上传到 Google Drive 这一步执行结果未知——文件选择对话框没有正常触发，我在 Drive 列表里也没看到这个文件，所以不能算已完成，也没有重复上传。SRT 和 TXT 版本都已在下载卡片里。";
  const READ_NOTE = 'return "2026-09-30 21:14";';

  /** 先做一轮只回话的 Drive 任务（纯聊天，不核对），再在 flomo 页发 10-01 的新请求；新任务读一次页面后交付 offTopic。 */
  async function offTopicRun(offTopic: AssistantMessage) {
    let readNote = false;

    const h = await session((context, call) => {
      if (call === 0) return message([{ type: "text", text: "已经把字幕上传到 Google Drive。" }], "stop");

      if (userTexts(context).some(text => text.startsWith("[GOAL CHECK]"))) return message([{ type: "text", text: "前两首是《A》和《B》。" }], "stop");

      if (!readNote) {
        readNote = true;

        return message([{ type: "toolCall", id: "r1", name: "browser_run", arguments: { code: READ_NOTE } }], "toolUse");
      }

      return offTopic;
    }, [{ status: "continue", remaining: "找到前两首歌" }]);

    h.start("把字幕上传到我的 Google Drive", { tabId: 2, title: "Drive", url: "https://drive.google.com/" });
    await until(() => ended(h.emitted) === 1, "the earlier Drive run");
    expect(h.judged).toHaveLength(0);

    h.start("在YouTube里面找到前两首歌。", flomo);
    // 10-04 起回答先交付（第 2 次结束），核对随后判「没做完」，催续作为后续一轮再结束一次（第 3 次）。
    await until(() => ended(h.emitted) === 3, "the read-only run and its goal-check continuation");

    return h;
  }

  async function expectNudged(h: Awaited<ReturnType<typeof session>>, lastReply: string) {
    expect(h.judged.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(h.judged[0]!)).toMatchObject({ goal: ["在YouTube里面找到前两首歌。"], lastReply });
    // 宿主插入的任务状态快照排在最后，催续提示是它前面的那条用户消息。
    const nudge = h.received.flatMap(userTexts).find(text => text.startsWith("[GOAL CHECK]"));
    expect(nudge).toBeDefined();
    expect(nudge).toContain("在YouTube里面找到前两首歌。");
    expect(nudge).toContain("找到前两首歌");

    await until(() => h.traceLines().some(line => line.includes('"type":"goal_check"')), "the goal_check trace line");
    // SAFETY: 每行是 TraceRecorder 写的 JSON 对象。
    const checks = h.traceLines().map(line => JSON.parse(line) as TraceLine).filter(line => line.type === "goal_check");
    expect(checks[0]!.data).toMatchObject({ status: "continue", remaining: "找到前两首歌", attempt: 1 });
  }

  it("10-01 shape: a read-only run delivering the earlier Drive status as partial is checked, and continue prompts the model with the user's current request (G1, G2)", async () => {
    const h = await offTopicRun(message([{ type: "toolCall", id: "d1", name: "send_user_message", arguments: { kind: "finding", outcome: "partial", content: DRIVE, unfinished: ["上传到 Google Drive"] } }], "toolUse"));

    try {
      await expectNudged(h, DRIVE);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("a read-only run that claims done but answers an earlier task is checked too, and continue prompts the model (G1, G2)", async () => {
    const claim = "字幕文件已经整理好，下载卡片里可以拿到。";
    const h = await offTopicRun(message([{ type: "text", text: claim }], "stop"));

    try {
      await expectNudged(h, claim);
    } finally {
      h.host.abort();
    }
  }, 30_000);

  it("pure chat runs (no tools, or only the delivery tool) are not checked: no fast-model call (G3)", async () => {
    const h = await session((_context, call) => (call === 0
      ? message([{ type: "text", text: "好的，我来帮你找歌。" }], "stop")
      : message([{ type: "toolCall", id: "d2", name: "send_user_message", arguments: { kind: "finding", outcome: "complete", content: "前两首是《A》和《B》。" } }], "toolUse")),
    [{ status: "continue", remaining: "不该被问到" }]);

    try {
      h.start("你能帮我找歌吗", flomo);
      await until(() => ended(h.emitted) === 1, "the chat run");
      h.start("在YouTube里面找到前两首歌。", flomo);
      await until(() => ended(h.emitted) === 2, "the delivery-only run");
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(h.emitted.some(event => event.kind === "user_delivery" && event.delivery.text.includes("前两首是"))).toBe(true);
      expect(h.judged).toHaveLength(0);
      expect(h.emitted.filter(event => event.kind === "goal_check")).toEqual([]);
    } finally {
      h.host.abort();
    }
  }, 30_000);
});
