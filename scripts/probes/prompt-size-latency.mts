// Probe: does the size of the fixed request content (system prompt + tool list) change model latency?
// Experiment only: no browser, no product integration, no token refresh, no retries.
//
//   NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--conditions=import npx tsx scripts/probes/prompt-size-latency.mts [--trials=8] [--out=dir] [--model=openai-codex/gpt-6-luna] [--effort=low] [--trace=traces.jsonl] [--core=a,b,c]
//
// The "full" variant is built with the product's own builders, the way the lead conversation assembles it:
// composeSystemPrompt(leadSystemPrompt(), [], "/") passed through ProductContext's before_agent_start hook,
// and the lead conversation's active tools from their factories. Per-user memory rows are not included.
import { mkdir, readFile, readdir, appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { InMemoryCredentialStore, type Tool } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadModelPlan, DEFAULT_TEST_MODEL } from "../acceptance/real-path/inproc-config.mts";
import { REPO } from "../acceptance/real-path/harness.mts";
import { leadSystemPrompt } from "../../agent/src/prompt.ts";
import { composeSystemPrompt } from "../../agent/src/system-prompt.ts";
import { ProductContext } from "../../agent/src/product-context.ts";
import { createBrowserTools } from "../../agent/src/tools.ts";
import { createTakeTabTool } from "../../agent/src/tab-control.ts";
import { MemoryRuntime } from "../../agent/src/memory-runtime.ts";
import { createSendUserMessageTool } from "../../agent/src/user-delivery.ts";
import { createArtifactsTool } from "../../agent/src/artifacts-tool.ts";

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const trials = Number(arg("trials") ?? 8);
const modelArg = arg("model") ?? DEFAULT_TEST_MODEL;
const effort = arg("effort") ?? "low";
const outDir = arg("out") ?? join(REPO, "out/probes/prompt-size-latency", new Date().toISOString().replace(/[:.]/g, "-"));

if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");

// ---------- production tools ----------

/** Definition-only stubs: the factories read their dependencies inside execute(), which this probe never calls. */
const stub = {} as never;

/** hand_to_user is a closure inside conversation-runtime.ts; it is taken from the newest captured request instead. */
async function capturedTool(traceFile: string, name: string): Promise<Tool> {
  const lines = (await readFile(traceFile, "utf8")).split("\n").filter(Boolean);
  const chunks = new Map<string, Array<{ index: number; text: string }>>();

  for (const line of lines) {
    if (!line.includes('"tools_manifest"')) continue;
    const r = JSON.parse(line);
    const list = chunks.get(r.data.sha256) ?? [];

    if (!list.some(c => c.index === r.data.index)) list.push({ index: r.data.index, text: r.data.text });
    chunks.set(r.data.sha256, list);
  }

  // Redaction can break other tools' JSON in the dump, so only this tool's own object is parsed.
  for (const list of [...chunks.values()].reverse()) {
    const text = list.sort((a, b) => a.index - b.index).map(c => c.text).join("");
    const start = text.indexOf(`{"name":"${name}","description"`);

    if (start < 0) continue;
    const end = text.indexOf(`},{"name":"`, start);
    const tool = JSON.parse(text.slice(start, end < 0 ? text.lastIndexOf("]") : end + 1));

    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  }

  throw new Error(`${name} not found in ${traceFile}`);
}

async function newestTrace(): Promise<string> {
  const explicit = arg("trace");

  if (explicit) return explicit;
  const dir = join(REPO, "out/daily-logs");
  const dirs = (await readdir(dir).catch(() => [])).sort().reverse();

  for (const d of dirs) {
    const file = join(dir, d, "traces.jsonl");

    if ((await readFile(file, "utf8").catch(() => "")).includes('"tools_manifest"')) return file;
  }

  // Worktrees share no out/: fall back to the main checkout's daily logs.
  const main = join(REPO, "../By-Your-Side/out/daily-logs");

  for (const d of (await readdir(main).catch(() => [])).sort().reverse()) {
    const file = join(main, d, "traces.jsonl");

    if ((await readFile(file, "utf8").catch(() => "")).includes('"tools_manifest"')) return file;
  }

  throw new Error("No daily-log trace with a tools manifest; pass --trace=");
}

const traceFile = await newestTrace();
const memoryTools = new MemoryRuntime(stub, "probe", () => {}).tools();
// Lead conversation order: browser tools, take_tab, hand_to_user (conversation-runtime.ts), then memory, send_user_message, artifacts (session.ts).
// record_task_results is registered but inactive in the lead conversation, so it is not sent.
const definitions: Array<ToolDefinition | Tool> = [
  ...createBrowserTools(stub),
  createTakeTabTool(stub),
  await capturedTool(traceFile, "hand_to_user"),
  ...memoryTools,
  createSendUserMessageTool(stub),
  createArtifactsTool({ emit: () => {}, store: stub }),
];
/** What the model receives: name, description, parameters (promptGuidelines are not sent as tool schema). */
const allTools: Tool[] = definitions.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

// ---------- production system prompt ----------

async function productSystemPrompt(tools: Array<ToolDefinition | Tool>): Promise<string> {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    on: (event: string, handler: (event: unknown) => unknown) => { handlers.set(event, handler); },
    getActiveTools: () => tools.map(t => t.name),
    getAllTools: () => tools,
  };

  new ProductContext().extension()(pi as never);
  const result = await handlers.get("before_agent_start")!({ systemPrompt: composeSystemPrompt(leadSystemPrompt(), [], "/") }) as { systemPrompt: string };

  return result.systemPrompt;
}

const fullPrompt = await productSystemPrompt(definitions);

// ---------- variants ----------

async function coreToolNames(): Promise<{ names: string[]; source: string; counts: Record<string, number> }> {
  const explicit = arg("core");

  if (explicit) return { names: explicit.split(","), source: "--core", counts: {} };
  const counts: Record<string, number> = {};

  for (const line of (await readFile(traceFile, "utf8")).split("\n")) {
    if (!line.includes('"tool_execution_start"')) continue;
    const name = JSON.parse(line).data?.toolName;

    if (allTools.some(t => t.name === name)) counts[name] = (counts[name] ?? 0) + 1;
  }

  const names = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n]) => n);

  return { names, source: `tool_execution_start counts in ${traceFile}`, counts };
}

/** Drop the longest "# " sections until the prompt is at most half its size; the text before the first heading stays. */
function halvePrompt(prompt: string): { text: string; dropped: Array<{ heading: string; chars: number }> } {
  const parts = prompt.split(/(?=^# )/m);
  const sections = parts.map((text, i) => ({ i, text, heading: text.startsWith("# ") ? text.split("\n")[0] : "(preamble)" }));
  const target = prompt.length / 2;
  const dropped = new Set<number>();
  let size = prompt.length;

  for (const s of sections.filter(s => s.i > 0).sort((a, b) => b.text.length - a.text.length)) {
    if (size <= target) break;
    dropped.add(s.i);
    size -= s.text.length;
  }

  return { text: sections.filter(s => !dropped.has(s.i)).map(s => s.text).join(""), dropped: sections.filter(s => dropped.has(s.i)).map(s => ({ heading: s.heading, chars: s.text.length })) };
}

const core = await coreToolNames();
const coreTools = allTools.filter(t => core.names.includes(t.name));
const half = halvePrompt(fullPrompt);
const minimalPrompt = "You are By Your Side, a browser agent in the user's Chrome sidebar. You operate the user's own logged-in browser through tools; act on real pages, not assumptions. Answer questions about the current page from the page observation without tools. State the conclusion in the first sentence, keep replies short, and reply in the user's language.";

const variants = [
  { id: "full", systemPrompt: fullPrompt, tools: allTools },
  { id: "tools-core", systemPrompt: fullPrompt, tools: coreTools },
  { id: "prompt-half", systemPrompt: half.text, tools: allTools },
  { id: "minimal", systemPrompt: minimalPrompt, tools: coreTools },
];

const PAGE = "[FRESH PAGE OBSERVATION — https://example.com/blog/remote-work]\nTitle: Four lessons from two years of remote work\nMain text: Our team of 14 moved fully remote in 2024. Lesson one: write decisions down; meetings without notes were repeated within a month. Lesson two: overlap hours matter more than total hours; we kept 3 shared hours across time zones. Lesson three: async status updates replaced the daily standup and saved about 4 hours per person per week. Lesson four: meet in person twice a year; most hard conversations waited for those weeks. Costs fell 18% after we gave up the office, but onboarding new hires took twice as long.";
const USER = `${PAGE}\n\n用三句话概括这个页面。`;

// ---------- model ----------

const plan = await loadModelPlan(modelArg);
const credentials = new InMemoryCredentialStore(), models = builtinModels({ credentials }), provider = models.getProvider(plan.providerId)!;

if (provider.auth.oauth) models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth, refresh: async () => { throw new Error("Probe never refreshes tokens."); } } } });
await credentials.modify(plan.providerId, async () => plan.credential as never);
const model = models.getModel(plan.providerId, plan.modelId);

if (!model) throw new Error(`Unknown model ${modelArg}`);

interface Row {
  trial: number; variant: string; condition: "cold" | "warm"; promptChars: number; toolsChars: number; toolCount: number;
  firstEventMs: number | null; firstRawMs: number | null; firstContentMs: number | null; totalMs: number;
  stopReason: string; input: number | null; cacheRead: number | null; output: number | null; error?: string;
  /** Warm request whose cold request failed: nothing was cached, so it is left out of the summary. */
  coldFailed?: boolean;
}

async function measure(trial: number, v: typeof variants[number], condition: "cold" | "warm", systemPrompt: string, sessionId: string): Promise<Row> {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  let firstEventMs: number | null = null, firstRawMs: number | null = null, firstContentMs: number | null = null;
  let stopReason = "unknown", usage: { input?: number; cacheRead?: number; output?: number } | undefined, error: string | undefined;

  try {
    const stream = models.streamSimple(model!, { systemPrompt, messages: [{ role: "user", content: USER, timestamp: Date.now() }], tools: v.tools }, {
      reasoning: effort as never, sessionId, maxRetries: 0, signal: AbortSignal.timeout(90_000),
      onProviderStreamEvent: () => { firstRawMs ??= at(); },
    } as never);

    for await (const event of stream) {
      firstEventMs ??= at();

      if (firstContentMs === null && (event.type === "text_delta" || event.type === "toolcall_start" || event.type === "toolcall_delta")) firstContentMs = at();

      if (event.type === "done") { stopReason = event.reason; usage = event.message.usage; }

      if (event.type === "error") { stopReason = event.reason; usage = event.error.usage; error = event.error.errorMessage; }
    }
  } catch (e) { stopReason = "thrown"; error = e instanceof Error ? e.message : String(e); }

  return {
    trial, variant: v.id, condition, promptChars: systemPrompt.length, toolsChars: JSON.stringify(v.tools).length, toolCount: v.tools.length,
    firstEventMs, firstRawMs, firstContentMs, totalMs: at(), stopReason,
    input: usage?.input ?? null, cacheRead: usage?.cacheRead ?? null, output: usage?.output ?? null, ...(error ? { error: error.slice(0, 300) } : {}),
  };
}

await mkdir(outDir, { recursive: true });
const rawFile = join(outDir, "raw.jsonl");
const sizes = variants.map(v => ({ variant: v.id, systemPromptChars: v.systemPrompt.length, toolsJsonChars: JSON.stringify(v.tools).length, toolCount: v.tools.length }));
await writeFile(join(outDir, "variants.json"), JSON.stringify({ model: modelArg, effort, trials, traceFile, coreTools: core, promptHalfDropped: half.dropped, sizes, userMessageChars: USER.length }, null, 2));
console.log(`model ${modelArg} · effort ${effort} · trials ${trials} · out ${outDir}`);
console.table(sizes);
console.log(`tools-core (${core.source}): ${core.names.join(", ")}`);
console.log(`prompt-half dropped: ${half.dropped.map(d => `${d.heading} (${d.chars})`).join("; ")}`);

const rows: Row[] = [];

for (let trial = 0; trial < trials; trial += 1) {
  // Round-robin with a rotating start so no variant always goes first.
  for (let k = 0; k < variants.length; k += 1) {
    const v = variants[(trial + k) % variants.length];
    // A new nonce line and cache-routing session id make the prefix unseen; warm resends the identical request.
    const systemPrompt = `Request nonce: ${randomUUID()}\n${v.systemPrompt}`;
    const sessionId = randomUUID();

    for (const condition of ["cold", "warm"] as const) {
      const row = await measure(trial, v, condition, systemPrompt, sessionId);

      if (condition === "warm" && rows.at(-1)?.error) row.coldFailed = true;
      rows.push(row);
      await appendFile(rawFile, JSON.stringify(row) + "\n");
      console.log(`trial ${trial} ${v.id.padEnd(11)} ${condition} first ${row.firstEventMs}ms content ${row.firstContentMs}ms total ${row.totalMs}ms in ${row.input} cached ${row.cacheRead} ${row.stopReason}${row.error ? ` ${row.error}` : ""}`);
    }
  }
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const nums = (rs: Row[], key: keyof Row) => rs.map(r => r[key]).filter((x): x is number => typeof x === "number");
const table = variants.flatMap(v => (["cold", "warm"] as const).map(condition => {
  const rs = rows.filter(r => r.variant === v.id && r.condition === condition);
  const ok = rs.filter(r => !r.error && !r.coldFailed);

  return {
    variant: v.id, condition, n: ok.length, excluded: rs.length - ok.length,
    "first p50": pct(nums(ok, "firstEventMs"), 0.5), "first p90": pct(nums(ok, "firstEventMs"), 0.9),
    "content p50": pct(nums(ok, "firstContentMs"), 0.5), "content p90": pct(nums(ok, "firstContentMs"), 0.9),
    "total p50": pct(nums(ok, "totalMs"), 0.5), "total p90": pct(nums(ok, "totalMs"), 0.9),
    "input p50": pct(nums(ok, "input"), 0.5), "cached p50": pct(nums(ok, "cacheRead"), 0.5),
  };
}));
console.table(table);
await writeFile(join(outDir, "summary.json"), JSON.stringify(table, null, 2));
// Something in the imported product modules keeps the event loop alive after the last request.
process.exit(0);
