// Probe: re-send captured model request bodies from Node and time them, as-is and with one thing removed at a time.
//
//   NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--conditions=import npx tsx scripts/probes/request-replay/replay.mts --from=<capture dir> [--indexes=0,2] [--trials=5] [--variants=asis,no-images,effort-low,history-last-2,no-tools] [--model=openai-codex/gpt-6-luna] [--fresh-cache-key] [--out=dir]
//
// Reads <capture dir>/bodies.raw.jsonl. Headers are the captured ones (auth was never saved) plus a fresh
// Authorization and chatgpt-account-id from the ChatGPT login, the same fields pi-ai's codex provider sets.
// The body goes uncompressed, like the extension's (pi-ai zstd-compresses only in Node).
// Without --fresh-cache-key the captured prompt_cache_key / session-id are reused, so repeats hit a warm prefix cache.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_TEST_MODEL, loadModelPlan } from "../../acceptance/real-path/inproc-config.mts";
import { arg, imageCount, isOutputDelta, markdownTable, pct, sseParser, usageOf, type Body } from "./shared.mts";

const from = arg("from");

if (!from) throw new Error("--from=<capture dir> is required");
const trials = Number(arg("trials") ?? 5);
const ALL_VARIANTS = ["asis", "no-images", "effort-low", "history-last-2", "no-tools"] as const;
type Variant = typeof ALL_VARIANTS[number];
const variants = (arg("variants")?.split(",") ?? [...ALL_VARIANTS]) as Variant[];
const freshCacheKey = process.argv.includes("--fresh-cache-key");
const outDir = arg("out") ?? join(from, `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`);

if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");

for (const v of variants) if (!ALL_VARIANTS.includes(v)) throw new Error(`unknown variant ${v}; known: ${ALL_VARIANTS.join(",")}`);

type Captured = { index: number; url: string; requestHeaders: Record<string, string>; body: Body };
const captured = (await readFile(join(from, "bodies.raw.jsonl"), "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l) as Captured);
const indexes = arg("indexes")?.split(",").map(Number) ?? captured.map(c => c.index);
const selected = indexes.map(i => captured.find(c => c.index === i) ?? (() => { throw new Error(`index ${i} not in capture`); })());

// ---------- variants ----------

type Item = Record<string, unknown> & { type?: string; role?: string; call_id?: string; content?: unknown; output?: unknown };

function dropImages(body: Body): Body {
  const strip = (parts: unknown): unknown => {
    if (!Array.isArray(parts)) return parts;
    const kept = parts.filter(p => (p as Item)?.type !== "input_image");

    return kept.length || !parts.length ? kept : [{ type: "input_text", text: "[image removed]" }];
  };

  return { ...body, input: (body.input as Item[]).map(item => {
    const next: Item = { ...item };

    if (Array.isArray(item.content)) next.content = strip(item.content);

    if (Array.isArray(item.output)) next.output = strip(item.output);

    return next;
  }) };
}

/** Last 2 input items, plus leading system/developer messages and any function_call a kept function_call_output needs. */
function historyLast2(body: Body): Body {
  const input = body.input as Item[];
  const tailStart = Math.max(0, input.length - 2);
  const keep = new Set<number>();

  input.forEach((item, i) => { if (i >= tailStart || ((item.role === "system" || item.role === "developer") && i < tailStart && input.slice(0, i).every(x => x.role === "system" || x.role === "developer"))) keep.add(i); });
  const neededCalls = new Set(input.filter((it, i) => keep.has(i) && it.type === "function_call_output").map(it => it.call_id));
  input.forEach((item, i) => { if (item.type === "function_call" && neededCalls.has(item.call_id)) keep.add(i); });

  return { ...body, input: input.filter((_, i) => keep.has(i)) };
}

function applyVariant(v: Variant, body: Body): Body {
  const copy = structuredClone(body);

  switch (v) {
    case "asis": return copy;
    case "no-images": return dropImages(copy);
    case "effort-low": return { ...copy, reasoning: { ...(copy.reasoning ?? {}), effort: "low" } };
    case "history-last-2": return historyLast2(copy);
    case "no-tools": { const { tools: _t, tool_choice: _c, parallel_tool_calls: _p, ...rest } = copy; return rest as Body; }
  }
}

// ---------- auth + headers ----------

const plan = await loadModelPlan(arg("model") ?? DEFAULT_TEST_MODEL);
const token = String(plan.credential.access ?? "");

if (plan.credential.type !== "oauth" || !token) throw new Error("replay needs the ChatGPT-login (oauth) credential");
const accountId = String(plan.credential.accountId ?? (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: string }>)["https://api.openai.com/auth"]?.chatgpt_account_id ?? "");

if (!accountId) throw new Error("no ChatGPT account id in the login token");

function headersFor(c: Captured, cacheKey: string | undefined): Headers {
  const h = new Headers();

  for (const [k, v] of Object.entries(c.requestHeaders ?? {})) if (!k.startsWith(":") && !/^(content-length|host)$/i.test(k)) h.set(k, v);
  if (!h.has("originator")) h.set("originator", "pi");
  h.set("OpenAI-Beta", "responses=experimental");
  h.set("accept", "text/event-stream");
  h.set("content-type", "application/json");
  h.delete("content-encoding");

  if (cacheKey) { h.set("session-id", cacheKey); h.set("x-client-request-id", cacheKey); }
  h.set("Authorization", `Bearer ${token}`);
  h.set("chatgpt-account-id", accountId);

  return h;
}

// ---------- measure ----------

interface Row {
  trial: number; index: number; variant: Variant; bodyBytes: number; images: number; inputItems: number; tools: number; effort: string | null;
  status: number | null; headersMs: number | null; firstByteMs: number | null; firstEventMs: number | null; firstOutputDeltaMs: number | null; totalMs: number;
  events: number; input: number | null; cached: number | null; output: number | null; reasoning: number | null; error?: string;
}

async function measure(trial: number, c: Captured, variant: Variant): Promise<Row> {
  const body = applyVariant(variant, c.body);

  if (freshCacheKey) body.prompt_cache_key = randomUUID();
  const json = JSON.stringify(body);
  const base = { trial, index: c.index, variant, bodyBytes: Buffer.byteLength(json), images: imageCount(body), inputItems: body.input?.length ?? 0, tools: body.tools?.length ?? 0, effort: body.reasoning?.effort ?? null };
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  let status: number | null = null, headersMs: number | null = null, firstByteMs: number | null = null, firstEventMs: number | null = null, firstOutputDeltaMs: number | null = null;
  let events = 0, usage: ReturnType<typeof usageOf> = null, error: string | undefined;

  try {
    const res = await fetch(c.url, { method: "POST", headers: headersFor(c, body.prompt_cache_key as string | undefined), body: json, signal: AbortSignal.timeout(120_000) });
    headersMs = at();
    status = res.status;

    if (!res.ok || !res.body) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    else {
      const parse = sseParser(), decoder = new TextDecoder();

      for await (const chunk of res.body) {
        firstByteMs ??= at();

        for (const e of parse(decoder.decode(chunk, { stream: true }))) {
          events += 1;
          firstEventMs ??= at();

          if (firstOutputDeltaMs === null && isOutputDelta(e.type)) firstOutputDeltaMs = at();

          if (e.type === "response.completed" || e.type === "response.done") usage = usageOf(e.data) ?? usage;

          if (e.type === "response.failed" || e.type === "error") error = JSON.stringify(e.data).slice(0, 300);
        }
      }
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); }

  return { ...base, status, headersMs, firstByteMs, firstEventMs, firstOutputDeltaMs, totalMs: at(), events,
    input: usage?.input ?? null, cached: usage?.cached ?? null, output: usage?.output ?? null, reasoning: usage?.reasoning ?? null, ...(error ? { error } : {}) };
}

await mkdir(outDir, { recursive: true });
const rawFile = join(outDir, "raw.jsonl");
console.log(`replay ${from} · indexes ${indexes.join(",")} · variants ${variants.join(",")} · trials ${trials}${freshCacheKey ? " · fresh cache key" : ""}\nout ${outDir}`);
const rows: Row[] = [];

for (let trial = 0; trial < trials; trial += 1) {
  for (const c of selected) {
    // Rotate the start so no variant always runs first (first request also pays connection setup).
    for (let k = 0; k < variants.length; k += 1) {
      const v = variants[(trial + k) % variants.length]!;
      const row = await measure(trial, c, v);

      rows.push(row);
      await appendFile(rawFile, JSON.stringify(row) + "\n");
      console.log(`t${trial} #${c.index} ${v.padEnd(14)} ${row.bodyBytes}B img ${row.images} items ${row.inputItems} · headers ${row.headersMs} firstByte ${row.firstByteMs} firstOutput ${row.firstOutputDeltaMs} total ${row.totalMs} · in ${row.input} cached ${row.cached} out ${row.output}${row.error ? ` · ${row.error}` : ""}`);
    }
  }
}

const nums = (rs: Row[], key: keyof Row) => rs.map(r => r[key]).filter((x): x is number => typeof x === "number");
const table = selected.flatMap(c => variants.map(v => {
  const rs = rows.filter(r => r.index === c.index && r.variant === v);
  const ok = rs.filter(r => !r.error);

  return {
    index: c.index, variant: v, n: ok.length, errors: rs.length - ok.length, kB: Math.round((rs[0]?.bodyBytes ?? 0) / 1024), img: rs[0]?.images, items: rs[0]?.inputItems, effort: rs[0]?.effort,
    "headers p50": pct(nums(ok, "headersMs"), 0.5), "headers p90": pct(nums(ok, "headersMs"), 0.9),
    "firstByte p50": pct(nums(ok, "firstByteMs"), 0.5), "firstByte p90": pct(nums(ok, "firstByteMs"), 0.9),
    "firstOutput p50": pct(nums(ok, "firstOutputDeltaMs"), 0.5), "firstOutput p90": pct(nums(ok, "firstOutputDeltaMs"), 0.9),
    "total p50": pct(nums(ok, "totalMs"), 0.5), "total p90": pct(nums(ok, "totalMs"), 0.9),
    "in p50": pct(nums(ok, "input"), 0.5), "cached p50": pct(nums(ok, "cached"), 0.5), "reason p50": pct(nums(ok, "reasoning"), 0.5),
  };
}));
const md = markdownTable(table);
await writeFile(join(outDir, "summary.json"), JSON.stringify(table, null, 2));
await writeFile(join(outDir, "summary.md"), `# replay of ${from}\n\ntrials ${trials}${freshCacheKey ? ", fresh cache key" : ", captured cache key"}; ms from fetch start (Node, env proxy).\n\n${md}`);
console.log(md);
