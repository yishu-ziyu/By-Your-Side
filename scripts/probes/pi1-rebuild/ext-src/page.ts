/**
 * P1/P2 共用的页面代码（普通扩展页与 offscreen 文档都加载它）。驱动脚本经 CDP 调 globalThis.probe.*。
 * 改写自 ../../pi1-durable/ext-src/spike.ts 与 r56.ts：openai-codex gpt-6-luna，只读访问令牌，刷新直接报错。
 * 另加：fetch 拦截记录服务商每段 output_text.delta 的到达时间；watchEvents 记录每个事件与消费端已看到的文字长度。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, type Message, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type AgentEvent, type Conversation, createRegistry, defineExtension, defineTool, Harness, watchEvents } from "@earendil-works/pi-durable";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { type IdbFileSystem, openIdbFileSystem } from "../idb-fs.ts";

const ctx = BACKGROUND_CONTEXT;

const MODEL = { provider: "openai-codex", modelId: "gpt-6-luna" } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const codex = openaiCodexProvider();

const provider = {
  ...codex,
  auth: {
    oauth: {
      name: "ChatGPT (probe, no refresh)",
      isSubscription: true,
      login: async () => { throw new Error("probe: login disabled"); },
      refresh: async () => { throw new Error("probe: OAuth refresh disabled (would rotate the refresh token)"); },
      toAuth: async (c: { access: string }) => ({ apiKey: c.access }),
    },
  },
};

const credentials = new InMemoryCredentialStore();

const models = createModels({ credentials });

// SAFETY: 只替换了 auth.oauth，其余字段原样来自 codex 服务商（与 spike.ts 相同）。
models.setProvider(provider as typeof codex);

async function setup(login: { access: string; expires: number; accountId?: string }) {
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: login.access, refresh: "probe-no-refresh", expires: login.expires, accountId: login.accountId }));

  return { ok: true };
}

// ---------- 工具执行计数：独立的 IndexedDB 库，文档关闭后还在 ----------
const idb = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function counters() {
  const open = indexedDB.open("probe-counters", 1);

  open.onupgradeneeded = () => open.result.createObjectStore("kv");

  return idb(open);
}

async function bump(key: string, add: number): Promise<number> {
  const db = await counters();
  const tx = db.transaction("kv", "readwrite");
  const n = Number((await idb(tx.objectStore("kv").get(key))) ?? 0) + add;

  tx.objectStore("kv").put(n, key);
  await new Promise((r) => { tx.oncomplete = r; });
  db.close();

  return n;
}

const pageTitle = defineTool({
  name: "page_title",
  description: "Return the title of the current browser page.",
  parameters: Type.Object({}),
  execute: async () => {
    await bump("page_title", 1);

    return { content: [{ type: "text", text: document.title }] };
  },
});

const slowLookup = defineTool({
  name: "slow_lookup",
  description: "Look up the secret code word for a key. Takes a few seconds.",
  parameters: Type.Object({ key: Type.String(), ms: Type.Number() }),
  // 默认 replay: "unsafe"：中断后不重做，模型得到 interrupted 结果。
  execute: async (args, api) => {
    await bump("slow_lookup", 1);
    api.output("looking up...\n");
    await sleep(args.ms);

    return { content: [{ type: "text", text: `code word for ${args.key}: PELICAN` }] };
  },
});

const registry = createRegistry();

registry.install(defineExtension({ name: "probe", tools: [pageTitle, slowLookup] }));

// ---------- fetch 拦截：服务商文字到达时间；可让下一次模型请求返回 503 ----------
type Tap = { on: boolean; failNext: number; provider: Array<{ t: number; len: number }>; text: string };

const tap: Tap = { on: false, failNext: 0, provider: [], text: "" };

const pageFetch = globalThis.fetch.bind(globalThis);

async function readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";

  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    const t = performance.now();
    const lines = (buf + r.value).split("\n");

    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ") || !line.includes("\"response.output_text.delta\"")) continue;
      tap.text += JSON.parse(line.slice(6)).delta;
      tap.provider.push({ t, len: tap.text.length });
    }
  }
}

globalThis.fetch = async (input, init) => {
  const model = String(input instanceof Request ? input.url : input).includes("chatgpt.com");

  if (model && tap.failNext > 0) {
    tap.failNext--;

    // codex 只把响应体当错误文字（不带状态码），所以体里要有可重试的字样，durable 才会重试。
    return new Response(JSON.stringify({ error: { message: "probe: injected 503 service unavailable" } }), { status: 503 });
  }

  const res = await pageFetch(input, init);

  if (!model || !tap.on || !res.body) return res;
  const [mine, theirs] = res.body.tee();

  void readSse(mine);

  return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
};

// ---------- pi-durable ----------
let fs: IdbFileSystem | undefined;

let harness: Harness | undefined;

let root: Conversation | undefined;

async function open(dbName: string) {
  fs = await openIdbFileSystem(dbName);
  const storage = await JsonlStorage.open("/session", fs, ctx);

  harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse", maxRetries: 0 }, retry: { baseDelayMs: 500 } }, onReport: (e) => console.warn("durable report", e) }, ctx);
  root = await harness.root(ctx, { agent: { model: MODEL, thinkingLevel: "low" } });

  return { rootId: Number(root.id) };
}

// ---------- 事件记录：每个事件的时间、类型、子类型，以及消费端此刻已看到的助手文字总长 ----------
type Row = { t: number; type: string; changes?: string[]; textLen?: number; msg?: number };

type Rec = { rows: Row[]; done: string; blocks: Array<{ type: string; text?: string }> | undefined; msg: number };

const rec: Rec = { rows: [], done: "", blocks: undefined, msg: 0 };

const textOf = (blocks: ReadonlyArray<{ type: string; text?: string }>) => blocks.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("");

function apply(ev: AgentEvent) {
  if (ev.type === "message_start" && ev.message.role === "assistant") rec.blocks = ev.message.content.map((b) => ({ ...b }));

  if (ev.type === "message_update" && rec.blocks) {
    for (const c of ev.changes) {
      if (c.type === "message") rec.blocks = c.message.content.map((b) => ({ ...b }));

      if (c.type === "text_start" || c.type === "thinking_start" || c.type === "toolcall_start" || c.type === "block") rec.blocks[c.contentIndex] = { ...c.block };

      if (c.type === "text_delta") rec.blocks[c.contentIndex].text = (rec.blocks[c.contentIndex].text ?? "") + c.delta;
    }
  }

  const final = ev.type === "message_end" ? ev.entry.model?.[0] : undefined;

  if (final?.role !== "assistant") return;
  rec.done += textOf(final.content);
  rec.blocks = undefined;
  rec.msg++;
}

let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;

async function watch() {
  stream = await watchEvents(harness!, root!.id, ctx);
  stream.start(async (batch) => {
    const t = performance.now();

    for (const ev of batch) {
      const msg = rec.msg;

      apply(ev);
      const changes = ev.type === "message_update" ? ev.changes.map((c) => c.type) : undefined;

      rec.rows.push({ t, type: ev.type, changes, textLen: rec.done.length + textOf(rec.blocks ?? []).length, msg });
    }
  });

  return { snapshotEntries: stream.snapshot.entries.length };
}

function summarize(messages: readonly Message[] | undefined) {
  return (messages ?? []).map((m) => {
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
    const row = { role: m.role, parts: parts.map((p: any) => (p.type === "text" ? `text:${p.text.slice(0, 200)}` : p.type === "toolCall" ? `toolCall:${p.name}(${JSON.stringify(p.arguments)})` : p.type)) };

    if (m.role !== "toolResult") return row;

    return { ...row, toolName: m.toolName, isError: m.isError };
  });
}

async function transcript() {
  const page = await root!.entries({}, 500, undefined, ctx);

  return [...page.items].reverse().filter((e) => e.kind !== "pi.system").map((e) => ({ kind: e.kind, model: summarize(e.model) }));
}

async function submit(prompt: string) {
  return { submissionId: Number((await root!.submit({ type: "input", content: prompt }, ctx)).id) };
}

async function waitSubmission(id: number) {
  // SAFETY: SubmissionId 是带品牌的数字；id 是本页面 submit() 先前返回的同一个数字。
  const s = await harness!.submission(id as Parameters<Harness["submission"]>[0], ctx);

  return s ? (await s.wait(ctx)).status : "not_found";
}

/** 文档重建后：重开同一个库，记下待办，再 resume() 并等空闲。 */
async function resume(dbName: string) {
  const opened = await open(dbName);
  const pending = await harness!.inspect(ctx);
  const atOpen = await transcript();

  harness!.resume();
  await root!.waitForIdle(ctx);

  return { ...opened, pendingAtOpen: { tasks: pending.tasks.map((t) => ({ kind: t.record.kind, status: t.record.state.status, inspect: t.state.kind })), submissions: pending.submissions.map((s) => s.status) }, transcriptAtOpen: atOpen };
}

async function compact() {
  const id = await root!.compact(undefined, ctx);

  return (await harness!.waitForTask(id, ctx)).state.outcome.status;
}

Object.assign(globalThis, { probe: {
  setup, open, watch, submit, waitSubmission, resume, compact, transcript,
  count: async (key: string) => bump(key, 0),
  tapOn: () => { tap.on = true; },
  failNext: (n: number) => { tap.failNext = n; },
  record: () => ({ rows: rec.rows, provider: tap.provider, providerText: tap.text, consumerText: rec.done }),
  close: async () => { await stream?.stop(); await harness?.close(ctx); fs?.db.close(); },
} });

document.title = "Probe Page 7";
