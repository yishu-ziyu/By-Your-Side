/**
 * 跑在隔离扩展的 offscreen 文档里。驱动脚本经 CDP 调 window.exp 的方法；扩展重载会杀掉这个文档，重开后
 * 从同一个 OPFS 目录打开存储，看 pi-durable 能否接着做完。
 */
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { createOpfsFileSystem } from "./opfs-fs.ts";

const fs = createOpfsFileSystem();
const STORE = "/pi/run";

let harness: Harness | undefined;
let config: { baseUrl: string; toolUrl: string } | undefined;

function assertions() {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const partial = (a: unknown, b: unknown): boolean => b !== null && typeof b === "object"
    ? a !== null && typeof a === "object" && Object.entries(b).every(([k, v]) => partial((a as Record<string, unknown>)[k], v))
    : Object.is(a, b);
  return {
    ok(value: unknown, message?: string) { if (!value) throw new Error(message ?? "expected truthy"); },
    strictEqual(a: unknown, b: unknown) { if (!Object.is(a, b)) throw new Error(`strictEqual ${String(a)} !== ${String(b)}`); },
    deepEqual(a: unknown, b: unknown) { if (!same(a, b)) throw new Error(`deepEqual ${JSON.stringify(a)?.slice(0, 300)} vs ${JSON.stringify(b)?.slice(0, 300)}`); },
    partialDeepEqual(a: unknown, b: unknown) { if (!partial(a, b)) throw new Error(`partialDeepEqual ${JSON.stringify(a)?.slice(0, 300)} vs ${JSON.stringify(b)?.slice(0, 300)}`); },
    greaterThan(a: number, b: number) { if (!(a > b)) throw new Error(`${a} > ${b}`); },
    async rejects(op: Promise<unknown>, includes: string) {
      try { await op; } catch (e) { if (String((e as Error)?.message ?? e).includes(includes)) return; throw new Error(`rejected with ${String(e)}, wanted "${includes}"`); }
      throw new Error(`did not reject (${includes})`);
    },
  };
}

async function conformance() {
  let n = 0;
  const cases = createStorageConformance({
    assertions: assertions(),
    withStorage: async (use) => {
      const dir = `/conformance/case-${++n}`;
      const storage = await JsonlStorage.open(dir, fs, ctx);
      try { await use(storage); } finally { await storage.close?.(ctx); await fs.remove(dir, { recursive: true, force: true }, ctx); }
    },
  });
  const failed: Array<{ name: string; error: string }> = [];
  const started = performance.now();
  for (const c of cases) {
    try { await c.run(); } catch (e) { failed.push({ name: c.name, error: String((e as Error)?.message ?? e).slice(0, 300) }); }
  }
  return { total: cases.length, passed: cases.length - failed.length, failed, ms: Math.round(performance.now() - started), usesNodeGlobals: typeof (globalThis as { process?: unknown }).process !== "undefined" };
}

const counter = defineTool({
  name: "count_hit",
  description: "Record one visit for the given label and report the running total.",
  parameters: Type.Object({ label: Type.String() }),
  execute: async (args) => {
    const reply = await fetch(`${config!.toolUrl}?label=${encodeURIComponent(args.label)}`, { method: "POST" });
    return { content: [{ type: "text", text: await reply.text() }] };
  },
});

// 声明可重做：执行到一半被打断时，pi-durable 重开后会再执行一次。用来和 count_hit（默认不可重做）对照。
const safeCounter = defineTool({ ...counter, name: "count_hit_safe", replay: "safe" });

async function open(next: { baseUrl: string; toolUrl: string }) {
  config = next;
  const models = createModels();
  models.setProvider(createProvider({
    id: "scripted",
    name: "Scripted",
    auth: { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "scripted" } }) } },
    models: [{
      id: "demo-model", name: "demo", api: "openai-completions", provider: "scripted", baseUrl: next.baseUrl, reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096, type: "chat",
    }],
    api: { "openai-completions": openAICompletionsApi() },
  }));
  const registry = createRegistry();
  registry.install(defineExtension({ name: "counter", tools: [counter, safeCounter] }));
  const storage = await JsonlStorage.open(STORE, fs, ctx);
  harness = await Harness.open(storage, { models, registry, settings: { retry: { maxRetries: 0 } } }, ctx);
  return "opened";
}

const AGENT = { model: { provider: "scripted", modelId: "demo-model" } };

async function conversation(name: string): Promise<Conversation> {
  if (name === "a") return harness!.root(ctx, { agent: AGENT });
  const idFile = `/pi/conv-${name}.txt`;
  const known = await fs.readTextFile(idFile, ctx);
  if (known.ok) return (await harness!.conversation(Number(known.value) as never, ctx))!;
  const created = await harness!.createConversation({ ownership: { kind: "ownerless" }, agent: AGENT }, ctx);
  await fs.writeFile(idFile, String(created.id), ctx);
  return created;
}

async function submit(name: string, content: string, requestId: string, whenBusy?: "follow-up" | "steer") {
  const conv = await conversation(name);
  const submission = await conv.submit({ type: "input", content, requestId, ...(whenBusy ? { whenBusy } : {}) } as never, ctx);
  return submission.id as number;
}

const textOf = (data: unknown): string => {
  const content = (data as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  // 工具结果消息的 content 也是分段数组，下面一起处理。
  if (Array.isArray(content)) return content.map((p: { type?: string; text?: string; name?: string; arguments?: unknown }) => p.type === "toolCall" ? `[call ${p.name} ${JSON.stringify(p.arguments)}]` : p.text ?? "").join("");
  return JSON.stringify(data)?.slice(0, 120) ?? "";
};

async function snapshot(name: string) {
  const conv = await conversation(name);
  const page = await conv.entries({}, 200, undefined, ctx);
  const view = await conv.viewState(ctx);
  const value = view.value as { docs?: Record<string, unknown> };
  view.dispose();
  return {
    id: String(conv.id),
    entries: [...page.items].sort((x, y) => (x.id as number) - (y.id as number)).filter((e) => e.kind !== "pi.system")
      .map((e) => `${e.kind}: ${(e.model ?? []).map(textOf).join(" | ").slice(0, 140)}`),
    inbox: value.docs?.["pi.inbox"] ?? null,
  };
}

async function status(id: number) {
  const s = await harness!.submission(id as never, ctx);
  return s ? (await s.status(ctx)).status : "missing";
}

async function waitIdle() { await harness!.waitForIdle(ctx); return "idle"; }

(globalThis as Record<string, unknown>).exp = {
  conformance, open, submit, snapshot, status, waitIdle,
  resume: () => { harness!.resume(); return "resumed"; },
  wipe: async () => { await fs.remove("/pi", { recursive: true, force: true }, ctx); return "wiped"; },
};
document.title = "exp-ready";
