/**
 * 扩展页面里的实验代码：pi-durable（JSONL 核心 + IndexedDB 文件外观）和裸 pi-agent-core 1.0.3 Agent，
 * 都用 pi-ai 1.0.3 的 openai-codex（ChatGPT 登录）。驱动脚本经 CDP 调 window.spike.*。
 * 凭据只在内存里；登录刷新被替换成直接报错，实验不会轮换令牌。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, Type, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type Conversation, createRegistry, defineExtension, defineTool, Harness, watchEvents } from "@earendil-works/pi-durable";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { type IdbFileSystem, openIdbFileSystem } from "../idb-fs.ts";

const ctx = BACKGROUND_CONTEXT;
const MODEL = { provider: "openai-codex", modelId: "gpt-6-luna" } as const;
const THINKING = "low" as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 模型：codex 服务商，登录换成只读访问令牌的版本 ----------
const codex = openaiCodexProvider();
const provider = {
  ...codex,
  auth: {
    oauth: {
      name: "ChatGPT (spike, no refresh)",
      isSubscription: true,
      login: async () => { throw new Error("spike: login disabled"); },
      refresh: async () => { throw new Error("spike: OAuth refresh disabled (would rotate the refresh token)"); },
      toAuth: async (c: { access: string }) => ({ apiKey: c.access }),
    },
  },
};
const credentials = new InMemoryCredentialStore();
const models = createModels({ credentials });
models.setProvider(provider as typeof codex);
// 假模型：瞬时回答，用来单独量 harness + IndexedDB 自身的开销（R4 补充）。
const faux = fauxProvider();
models.setProvider(faux.provider);
const FAUX = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const fauxScript = () => faux.setResponses([fauxAssistantMessage(fauxToolCall("page_title", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Spike Page 7")]);

async function setup(login: { access: string; expires: number; accountId?: string }) {
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: login.access, refresh: "spike-no-refresh", expires: login.expires, accountId: login.accountId }));
  return { ok: true, model: !!models.getModel(MODEL.provider, MODEL.modelId) };
}

// ---------- 工具 ----------
const execCount = (name: string, add = 0) => { const n = Number(localStorage.getItem(`exec:${name}`) ?? 0) + add; localStorage.setItem(`exec:${name}`, String(n)); return n; };
const slowCalls = (): string[] => JSON.parse(localStorage.getItem("calls:slow_lookup") ?? "[]");
const pageTitle = defineTool({
  name: "page_title",
  description: "Return the title of the current browser page.",
  parameters: Type.Object({}),
  execute: async () => { execCount("page_title", 1); return { content: [{ type: "text", text: document.title }] }; },
});
const slowLookup = defineTool({
  name: "slow_lookup",
  description: "Look up the secret code word for a key. Takes a few seconds.",
  parameters: Type.Object({ key: Type.String(), ms: Type.Number() }),
  // 默认 replay: "unsafe"：中断后不重做，模型得到 interrupted 结果。
  execute: async (args, api) => {
    execCount("slow_lookup", 1);
    localStorage.setItem("calls:slow_lookup", JSON.stringify([...slowCalls(), api.callId]));
    api.output("looking up...\n");
    await sleep(args.ms);
    return { content: [{ type: "text", text: `code word for ${args.key}: PELICAN` }] };
  },
});
const registry = createRegistry();
registry.install(defineExtension({ name: "spike", tools: [pageTitle, slowLookup] }));

// ---------- pi-durable ----------
let fs: IdbFileSystem | undefined;
let storage: JsonlStorage | undefined;
let harness: Harness | undefined;
let root: Conversation | undefined;

async function openDurable(dbName: string, model: { provider: string; modelId: string } = MODEL) {
  const t0 = performance.now();
  fs = await openIdbFileSystem(dbName);
  storage = await JsonlStorage.open("/session", fs, ctx);
  harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse" } }, onReport: (e) => console.warn("durable report", e) }, ctx);
  root = await harness.root(ctx, { agent: { model, thinkingLevel: THINKING } });
  return { openMs: Math.round(performance.now() - t0), openWrites: { ...fs.stats } };
}

function summarize(messages: readonly Message[] | undefined) {
  return (messages ?? []).map((m) => {
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
    return {
      role: m.role,
      ...("toolName" in m ? { toolName: m.toolName, isError: (m as { isError?: boolean }).isError } : {}),
      parts: parts.map((p: any) => p.type === "text" ? `text:${p.text.slice(0, 160)}` : p.type === "toolCall" ? `toolCall:${p.name}(${JSON.stringify(p.arguments)})` : p.type),
    };
  });
}

async function transcript() {
  const page = await root!.entries({}, 200, undefined, ctx);
  return [...page.items].reverse().map((e) => ({ kind: e.kind, byTask: !!e.byTaskId, data: e.kind === "pi.system" ? undefined : e.data, model: summarize(e.model) }));
}

/** 提交一句话并等答完；记首字时间（第一条 message_update 事件）和本轮存储写入。 */
async function durableAsk(prompt: string) {
  const before = { ...fs!.stats };
  const events = await watchEvents(harness!, root!.id, ctx);
  const t0 = performance.now();
  let firstDeltaMs: number | undefined;
  let firstTextMs: number | undefined;
  const eventLog: Array<[number, string, string?]> = [];
  events.start(async (batch) => {
    for (const ev of batch) {
      if (eventLog.length < 60) eventLog.push([Math.round(performance.now() - t0), ev.type, (ev as any).message?.role]);
      // 首字：第一条助手消息出现（message_start）或更新（message_update），以先到者为准。
      if (ev.type === "message_start" && (ev as any).message?.role === "assistant") firstDeltaMs ??= performance.now() - t0;
      if (ev.type !== "message_update") continue;
      firstDeltaMs ??= performance.now() - t0;
      if (firstTextMs === undefined && ev.changes.some((c: any) => c.type === "text" || c.text !== undefined)) firstTextMs = performance.now() - t0;
    }
  });
  const submission = await root!.submit({ type: "input", content: prompt }, ctx);
  const submitMs = performance.now() - t0;
  const settled = await submission.wait(ctx);
  const totalMs = performance.now() - t0;
  await events.stop();
  const after = fs!.stats;
  const entries = await transcript();
  return {
    status: settled.status, submitMs: Math.round(submitMs), firstDeltaMs: firstDeltaMs && Math.round(firstDeltaMs), firstTextMs: firstTextMs && Math.round(firstTextMs), totalMs: Math.round(totalMs),
    writes: { txns: after.txns - before.txns, bytes: after.bytes - before.bytes },
    assistantTurns: entries.filter((e) => e.kind === "pi.assistant").length, entries, eventLog,
  };
}

/** 提交但不等：R3 用它在工具执行中途重载页面。 */
async function durableStart(prompt: string) {
  const submission = await root!.submit({ type: "input", content: prompt }, ctx);
  return { submissionId: submission.id };
}

async function liveTools() {
  const view = await root!.viewState(ctx);
  const live = (view.value as any).docs?.["pi.live"];
  view.dispose();
  return { live, execs: { slow_lookup: execCount("slow_lookup"), page_title: execCount("page_title") }, slowCalls: slowCalls() };
}

async function steer(text: string) {
  const s = await root!.submit({ type: "input", content: text, whenBusy: "steer" }, ctx);
  return { submissionId: s.id };
}

async function waitSubmission(id: string) {
  const s = await harness!.submission(id as any, ctx);
  return s ? (await s.wait(ctx)).status : "not_found";
}

/** 重载后：重新打开存储，resume()，等空闲，再读会话记录。 */
async function durableResume(dbName: string) {
  const opened = await openDurable(dbName);
  const pending = await harness!.inspect(ctx);
  const beforeTranscript = await transcript();
  const t0 = performance.now();
  harness!.resume();
  await root!.waitForIdle(ctx);
  return {
    ...opened,
    pendingAtOpen: { tasks: pending.tasks.map((t) => ({ kind: t.record.kind, status: t.record.state.status, inspect: t.state.kind })), submissions: pending.submissions.map((s) => s.status) },
    transcriptAtOpen: beforeTranscript, resumeMs: Math.round(performance.now() - t0), transcript: await transcript(),
    execs: { slow_lookup: execCount("slow_lookup"), page_title: execCount("page_title") }, slowCalls: slowCalls(),
  };
}

// ---------- 裸 pi-agent-core 1.0.3 Agent，同一模型、同一工具、同样走 SSE ----------
const bareTool: AgentTool<any> = {
  name: "page_title", label: "page_title", description: pageTitle.description, parameters: pageTitle.parameters,
  execute: async () => ({ content: [{ type: "text", text: document.title }], details: undefined }),
};

async function bareAsk(prompt: string, ref: { provider: string; modelId: string } = MODEL) {
  const model = models.getModel(ref.provider, ref.modelId)!;
  const agent = new Agent({
    initialState: { model, thinkingLevel: THINKING, tools: [bareTool] },
    streamFn: (m, c, o) => models.streamSimple(m, c, o),
    transport: "sse",
    sessionId: crypto.randomUUID(),
  });
  const t0 = performance.now();
  let firstDeltaMs: number | undefined;
  let startMs: number | undefined;
  agent.subscribe((ev) => {
    if (ev.type === "message_start" && (ev.message as Message).role === "assistant") startMs ??= performance.now() - t0;
    if (ev.type === "message_update") firstDeltaMs ??= performance.now() - t0;
  });
  await agent.prompt(prompt);
  const msgs = agent.state.messages as Message[];
  return {
    startMs: startMs && Math.round(startMs), firstDeltaMs: firstDeltaMs && Math.round(firstDeltaMs), totalMs: Math.round(performance.now() - t0), error: agent.state.errorMessage,
    assistantTurns: msgs.filter((m) => m.role === "assistant").length, messages: summarize(msgs),
  };
}

async function close() {
  await harness?.close(ctx);
  fs?.db.close();
  harness = undefined; root = undefined; storage = undefined;
}

/** 假模型下各跑 n 次，返回每次总耗时与写入；durable 每次新开一个库（与 R4 相同）。 */
async function overhead(n: number) {
  const prompt = "Use the page_title tool, then reply with the title.";
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    fauxScript();
    await openDurable(`faux-${Date.now()}-${i}`, FAUX);
    const d = await durableAsk(prompt);
    await close();
    rows.push({ engine: "pi-durable", status: d.status, totalMs: d.totalMs, txns: d.writes.txns, bytes: d.writes.bytes, turns: d.assistantTurns });
    fauxScript();
    const b = await bareAsk(prompt, FAUX);
    rows.push({ engine: "agent-core", status: b.error ?? "done", totalMs: b.totalMs, txns: 0, bytes: 0, turns: b.assistantTurns });
  }
  return rows;
}

(globalThis as any).spike = { overhead, setup, openDurable, durableAsk, durableStart, liveTools, steer, waitSubmission, durableResume, transcript, bareAsk, close, resetCounters: () => localStorage.clear() };
document.title = "Spike Page 7";
