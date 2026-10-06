/**
 * R5 接管→交还、R6 两个任务同时跑：扩展页面里的实验代码。驱动脚本经 CDP 调 window.r56.*。
 * 页面状态（表单、工具执行记录）放 localStorage，重载后还在，扮演“网页”。
 * 模型与登录同 spike.ts：openai-codex gpt-6-luna，只读访问令牌，刷新直接报错。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, Type, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type Conversation, createRegistry, defineExtension, defineTool, Harness, watchEvents } from "@earendil-works/pi-durable";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { type IdbFileSystem, openIdbFileSystem } from "../idb-fs.ts";

const ctx = BACKGROUND_CONTEXT;

const MODEL = { provider: "openai-codex", modelId: "gpt-6-luna" } as const;


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

// SAFETY: 只替换了 auth.oauth，其余字段原样来自 codex 服务商（与 spike.ts 相同）。
models.setProvider(provider as typeof codex);

async function setup(login: { access: string; expires: number; accountId?: string }) {
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: login.access, refresh: "spike-no-refresh", expires: login.expires, accountId: login.accountId }));

  return { ok: true };
}

// ---------- 页面状态（localStorage，重载后还在） ----------
type Exec = { tool: string; conv: string; callId: string; arg: string; start: number; end?: number; aborted?: boolean };

const load = <T>(key: string, empty: T): T => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(empty));

type Form = { name: string; phone: string; email: string; city: string };

const store = (key: string, value: Form | Exec[] | Req[]) => localStorage.setItem(key, JSON.stringify(value));

const form = (): Form => load("form", { name: "", phone: "", email: "", city: "" });

const execs = (): Exec[] => load("execs", []);

const logExec = (row: Exec) => store("execs", [...execs(), row]);

const patchExec = (callId: string, start: number, patch: Partial<Exec>) => store("execs", execs().map((e) => (e.callId === callId && e.start === start ? { ...e, ...patch } : e)));

/** 等 ms 毫秒；接管（abort）时提前结束并返回 true。 */
const wait = (ms: number, signal: AbortSignal | undefined) => new Promise<boolean>((resolve) => {
  if (signal?.aborted) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);

  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(true); }, { once: true });
});

// ---------- R5 工具：表单 ----------
const readForm = defineTool({
  name: "read_form",
  description: "Read the current values of the form on the page.",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: JSON.stringify(form()) }] }),
});

const fillField = defineTool({
  name: "fill_field",
  description: "Type a value into one form field on the page (name, phone, email or city). Takes about 1.5 s to settle.",
  parameters: Type.Object({ field: Type.Union([Type.Literal("name"), Type.Literal("phone"), Type.Literal("email"), Type.Literal("city")]), value: Type.String() }),
  executionMode: "sequential",
  // 写入立刻生效（产品里“进行中的写入会写完”），之后 1.5 s 等页面稳定；接管时提前结束。
  execute: async (args, api, context) => {
    const start = Date.now();

    logExec({ tool: "fill_field", conv: String(api.conversationId), callId: api.callId, arg: `${args.field}=${args.value}`, start });
    store("form", { ...form(), [args.field]: args.value });
    const aborted = await wait(1500, context.abortSignal);

    patchExec(api.callId, start, { end: Date.now(), aborted });

    return { content: [{ type: "text", text: `${args.field} set to ${args.value}` }] };
  },
});

// ---------- R6 工具：慢查询，每次 1.5 s ----------
const WORDS = new Map([["a1", "PELICAN"], ["a2", "GRANITE"], ["a3", "SAFFRON"], ["b1", "WALRUS"], ["b2", "COBALT"], ["b3", "TAMARIND"]]);

const slowWord = defineTool({
  name: "slow_word",
  description: "Look up the secret word for a key. Takes about 1.5 s.",
  parameters: Type.Object({ key: Type.String() }),
  executionMode: "sequential",
  replay: "safe", // 只读查询：中断后可以按同一调用编号重跑
  execute: async (args, api, context) => {
    const start = Date.now();

    logExec({ tool: "slow_word", conv: String(api.conversationId), callId: api.callId, arg: args.key, start });
    const aborted = await wait(1500, context.abortSignal);

    patchExec(api.callId, start, { end: Date.now(), aborted });

    return { content: [{ type: "text", text: `secret word for ${args.key}: ${WORDS.get(args.key) ?? "UNKNOWN"}` }] };
  },
});

// R6：记每次模型请求的开始与收到响应头的时间，看两个任务的模型请求是否也同时在跑。
type Req = { task: string; start: number; headers?: number };

const reqs = (): Req[] => load("reqs", []);

const pageFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const body = String(init?.body ?? "");
  const task = body.includes("slow_word for key \\\"a1\\\"") ? "a" : body.includes("slow_word for key \\\"b1\\\"") ? "b" : "other";
  const start = Date.now();
  const res = await pageFetch(input, init);

  store("reqs", [...reqs(), { task, start, headers: Date.now() }]);

  return res;
};

const registry = createRegistry();

registry.install(defineExtension({ name: "r56", tools: [readForm, fillField, slowWord] }));

// ---------- pi-durable ----------
let fs: IdbFileSystem | undefined;

let harness: Harness | undefined;

let root: Conversation | undefined;

const convs = new Map<string, Conversation>();

const firstToken = new Map<string, number>();

const watchers: Array<Awaited<ReturnType<typeof watchEvents>>> = [];

async function open(dbName: string) {
  const t0 = performance.now();

  fs = await openIdbFileSystem(dbName);
  const storage = await JsonlStorage.open("/session", fs, ctx);

  harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse" } }, onReport: (e) => console.warn("durable report", e) }, ctx);
  root = await harness.root(ctx, { agent: { model: MODEL, thinkingLevel: "low" } });
  convs.clear();
  convs.set(String(root.id), root);

  return { rootId: String(root.id), openMs: Math.round(performance.now() - t0) };
}

async function conv(id: string) {
  const known = convs.get(id);

  if (known) return known;
  // SAFETY: ConversationId 是带品牌的数字；id 是本页面先前用 String() 返回的同一个数字。
  const c = await harness!.conversation(Number(id) as Conversation["id"], ctx);

  if (!c) throw new Error(`没有会话 ${id}`);
  convs.set(id, c);

  return c;
}

async function newConversation() {
  const c = await harness!.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL, thinkingLevel: "low" } }, ctx);

  convs.set(String(c.id), c);

  return String(c.id);
}

function summarize(messages: readonly Message[] | undefined) {
  return (messages ?? []).map((m) => {
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];

    const row = {
      role: m.role,
      parts: parts.map((p: any) => (p.type === "text" ? `text:${p.text.slice(0, 240)}` : p.type === "toolCall" ? `toolCall:${p.name}(${JSON.stringify(p.arguments)})#${p.id}` : p.type)),
    };

    if (m.role !== "toolResult") return row;

    return { ...row, toolName: m.toolName, callId: m.toolCallId, isError: m.isError };
  });
}

async function transcript(id: string) {
  const page = await (await conv(id)).entries({}, 500, undefined, ctx);

  return [...page.items].reverse().filter((e) => e.kind !== "pi.system").map((e) => ({ kind: e.kind, model: summarize(e.model) }));
}

/** 提交但不等；同时开始记首字时间（第一条助手 message_start / message_update）。 */
async function start(id: string, prompt: string) {
  const c = await conv(id);
  const events = await watchEvents(harness!, c.id, ctx);
  const t0 = Date.now();

  events.start(async (batch) => {
    for (const ev of batch) {
      const assistant = ev.type === "message_update" || (ev.type === "message_start" && ev.message.role === "assistant");

      if (assistant && !firstToken.has(id)) firstToken.set(id, Date.now() - t0);
    }
  });
  watchers.push(events);
  const s = await c.submit({ type: "input", content: prompt }, ctx);

  return { submissionId: s.id, t0 };
}

async function waitSubmission(id: number) {
  const t0 = Date.now();
  // SAFETY: SubmissionId 是带品牌的数字；id 是本页面 start() 先前返回的同一个数字。
  const s = await harness!.submission(id as Parameters<Harness["submission"]>[0], ctx);

  if (!s) return { status: "not_found", waitedMs: 0 };

  return { status: (await s.wait(ctx)).status, waitedMs: Date.now() - t0 };
}

/** 接管：Conversation.abort()，量从调用到空闲的时间。 */
async function takeover(id: string) {
  const t0 = Date.now();

  await (await conv(id)).abort(ctx);

  return { abortMs: Date.now() - t0, form: form(), execs: execs() };
}

/** 重载后：重开同一个库，看待办，再 resume()。 */
async function reopen(dbName: string) {
  const opened = await open(dbName);
  const pending = await harness!.inspect(ctx);

  harness!.resume();

  return { ...opened, pendingAtOpen: { tasks: pending.tasks.map((t) => ({ kind: t.record.kind, status: t.record.state.status })), submissions: pending.submissions.map((s) => s.status) } };
}

async function close() {
  for (const w of watchers.splice(0)) await w.stop().catch(() => {});
  await harness?.close(ctx);
  fs?.db.close();
  harness = undefined;
  root = undefined;
}

Object.assign(globalThis, { r56: {
  setup, open, reopen, newConversation, start, waitSubmission, takeover, transcript, close,
  firstToken: (id: string) => firstToken.get(id),
  state: () => ({ form: form(), execs: execs(), reqs: reqs() }),
  userEdit: (field: string, value: string) => {
    store("form", { ...form(), [field]: value });

    return form();
  },
  reset: () => localStorage.clear(),
} });

document.title = "R5 R6 page";
