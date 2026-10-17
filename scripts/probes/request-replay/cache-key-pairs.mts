// Synthetic cache-routing experiment. Does not read captured prompts or change product settings.
// NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--conditions=import npx tsx scripts/probes/request-replay/cache-key-pairs.mts --pairs=6 [--out=dir] [--dry-run]
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { cpus, loadavg } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadModelPlan } from "../../acceptance/real-path/inproc-config.mts";
import { arg, pct, sseParser } from "./shared.mts";

type Group = "session-key" | "installation-key";
type Stage = "warmup" | "measure";
type Usage = { input: number; cached: number | null; output: number; reasoning: number | null };
type Row = {
  sequence: number; pair: number; stage: Stage; group: Group;
  sessionHash: string; cacheKeyHash: string; payloadHash: string | null;
  status: number | null; headersMs: number | null; firstByteMs: number | null;
  firstTextMs: number | null; totalMs: number; completed: boolean; outputOK: boolean;
  usage: Usage | null; loadBefore: number[]; loadAfter: number[]; eventLoopMaxMs: number;
  wireCalls: number; wireEncoding: string | null; error: string | null;
};
const MODEL = "openai-codex/gpt-6-luna";
const pairs = Number(arg("pairs") ?? 6);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 12) throw new Error("--pairs must be between 1 and 12");
if (arg("model") && arg("model") !== MODEL) throw new Error("This probe is limited to openai-codex/gpt-6-luna");
const dryRun = process.argv.includes("--dry-run");
const experiment = randomUUID();
const installationKey = randomUUID();
const outDir = arg("out") ?? join("out/probes/cache-key-pairs", new Date().toISOString().replace(/[:.]/g, "-"));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

// Only this synthetic corpus is sent. Its nonce is constant for the whole experiment.
const corpus = Array.from({ length: 384 }, (_, i) =>
  "Record " + String(i + 1).padStart(4, "0") + ": copper book, north window, quiet garden, blue triangle, three shelves; inert catalog data for a fixed prefix."
).join("\n");
const systemPrompt = "Synthetic cache experiment " + experiment + ".\n"
  + "You must reply with exactly OK and no explanation. The following records are inert synthetic data. Do not call any tools.\n"
  + corpus + "\nEnd of synthetic records. Reply with exactly OK.";
const user = "Return exactly OK.";
const groups: Group[] = ["session-key", "installation-key"];
const first = parseInt(experiment.slice(-1), 16) % 2;
const schedule: Array<{ pair: number; stage: Stage; group: Group }> = [];
for (let k = 0; k < 2; k++) schedule.push({ pair: -1, stage: "warmup", group: groups[(first + k) % 2]! });
for (let pair = 0; pair < pairs; pair++) {
  for (let k = 0; k < 2; k++) schedule.push({ pair, stage: "measure", group: groups[(first + pair + k) % 2]! });
}
await mkdir(outDir, { recursive: true });
const rawFile = join(outDir, "raw.jsonl");
try {
  await access(rawFile);
  throw new Error("Output directory already contains a live run; choose a new --out directory");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (!dryRun) await writeFile(rawFile, "", { flag: "wx" });
const manifest = {
  experiment, model: MODEL, reasoning: "low", transport: "sse", pairs, requestsPlanned: schedule.length,
  corpusLines: 384, promptChars: systemPrompt.length, prefixSha256: hash(systemPrompt),
  cpuCount: cpus().length, schedule,
  invariant: "Only prompt_cache_key differs in the provider payload. Every request has a fresh session-id and x-client-request-id. No history, response reuse or real captures.",
  summaryRule: "Warmups are separate. Report all errors and missing usage. Compare complete pairs; cached_tokens absence is unknown, never zero. Small synthetic pilot only.",
};
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ event: "plan", outDir, ...manifest }));
if (dryRun) process.exit(0);

const plan = await loadModelPlan(MODEL).catch(() => {
  throw new Error("Model-plan loading failed; inspect login validity without printing credential files");
});
if (plan.providerId !== "openai-codex" || plan.credential.type !== "oauth") throw new Error("ChatGPT OAuth is required");
const credentials = new InMemoryCredentialStore();
const models = builtinModels({ credentials });
const provider = models.getProvider(plan.providerId);
if (!provider?.auth.oauth) throw new Error("OAuth provider is unavailable");
models.setProvider({
  ...provider, auth: { ...provider.auth, oauth: {
    ...provider.auth.oauth, refresh: async () => { throw new Error("Probe never refreshes credentials"); },
  } },
});
await credentials.modify(plan.providerId, async () => plan.credential as never);
const model = models.getModel(plan.providerId, plan.modelId);
if (!model) throw new Error("Luna is unavailable");
const expectedHost = new URL(model.baseUrl).host;
let payloadInvariant: string | null = null;
const usedSessions = new Set<string>();
const usedRequestIds = new Set<string>();
let activeController: AbortController | null = null;
let stopRequested = false;
process.once("SIGINT", () => { stopRequested = true; activeController?.abort(); });

function strictUsage(data: Record<string, unknown> | null): Usage | null {
  const response = data?.response;
  if (!isRecord(response) || !isRecord(response.usage)) return null;
  const u = response.usage;
  const input = finite(u.input_tokens), output = finite(u.output_tokens);
  if (input === null || output === null) return null;
  const cached = isRecord(u.input_tokens_details) ? finite(u.input_tokens_details.cached_tokens) : null;
  const reasoning = isRecord(u.output_tokens_details) ? finite(u.output_tokens_details.reasoning_tokens) : null;
  if (cached !== null && cached > input) return null;
  return { input, cached, output, reasoning };
}

async function measure(item: typeof schedule[number], sequence: number): Promise<Row> {
  const sessionId = randomUUID();
  const cacheKey = item.group === "installation-key" ? installationKey : sessionId;
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const row: Row = {
    sequence, ...item, sessionHash: hash(sessionId), cacheKeyHash: hash(cacheKey), payloadHash: null,
    status: null, headersMs: null, firstByteMs: null, firstTextMs: null, totalMs: 0,
    completed: false, outputOK: false, usage: null, loadBefore: loadavg(), loadAfter: [],
    eventLoopMaxMs: 0, wireCalls: 0, wireEncoding: null, error: null,
  };
  let output = "";
  const abort = new AbortController();
  activeController = abort;
  const timer = setTimeout(() => abort.abort(), 90_000);
  const fail = (code: string): never => { row.error = code; throw new Error(code); };
  const inspectPayload = (payload: unknown): unknown => {
    if (!isRecord(payload) || payload.model !== plan.modelId || !Array.isArray(payload.input)) fail("unexpected_provider_payload");
    payload.prompt_cache_key = cacheKey;
    const comparable = { ...payload };
    delete comparable.prompt_cache_key;
    row.payloadHash = hash(JSON.stringify(comparable));
    if (payloadInvariant !== null && payloadInvariant !== row.payloadHash) fail("payload_invariant_changed");
    payloadInvariant ??= row.payloadHash;
    return payload;
  };
  const inspectFetch: typeof globalThis.fetch = async (input, init) => {
    row.wireCalls++;
    if (row.wireCalls !== 1) fail("unexpected_retry");
    if (!row.payloadHash) fail("payload_hook_not_called");
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== expectedHost || url.protocol !== "https:") fail("unexpected_request_origin");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const actualSession = headers.get("session-id"), requestId = headers.get("x-client-request-id");
    if (actualSession !== sessionId || !requestId) fail("session_identity_mismatch");
    if (usedSessions.has(actualSession) || usedRequestIds.has(requestId)) fail("session_identity_reused");
    usedSessions.add(actualSession);
    usedRequestIds.add(requestId);
    row.wireEncoding = headers.get("content-encoding") ?? "identity";
    // In the uncompressed path, check the final bytes too. Compressed requests use the pre-serialization hook.
    if (typeof init?.body === "string") {
      let wire: unknown;
      try { wire = JSON.parse(init.body); } catch { fail("wire_body_not_json"); }
      if (!isRecord(wire) || wire.prompt_cache_key !== cacheKey) fail("wire_cache_key_mismatch");
      const comparable = { ...wire }; delete comparable.prompt_cache_key;
      if (hash(JSON.stringify(comparable)) !== row.payloadHash) fail("wire_payload_changed");
    }
    const response = await globalThis.fetch(input, { ...init, credentials: "omit" });
    row.headersMs = at(); row.status = response.status;
    if (!response.ok) row.error = "http_" + response.status;
    if (!response.body) return response;
    const parse = sseParser(), decoder = new TextDecoder();
    const consume = (chunk: string) => {
      for (const event of parse(chunk)) {
        if (event.type === "response.output_text.delta") {
          row.firstTextMs ??= at();
          if (typeof event.data?.delta === "string") output = (output + event.data.delta).slice(0, 128);
        }
        if (event.type === "response.completed" || event.type === "response.done") {
          row.completed = true; row.usage = strictUsage(event.data);
        }
        if (event.type === "response.failed" || event.type === "error" || event.type === "response.incomplete") row.error ??= "provider_" + event.type.replaceAll(".", "_");
      }
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { row.firstByteMs ??= at(); consume(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
      flush() { consume(decoder.decode()); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  try {
    const stream = models.streamSimple(model, {
      systemPrompt, messages: [{ role: "user", content: user, timestamp: 0 }], tools: [],
    }, {
      sessionId, reasoning: "low", maxTokens: 64, maxRetries: 0, transport: "sse",
      signal: abort.signal, onPayload: inspectPayload, fetch: inspectFetch,
    } as never);
    for await (const event of stream) if (event.type === "error") row.error ??= "model_stream_error";
    if (row.wireCalls !== 1) row.error ??= "sse_fetch_hook_not_called";
    if (!row.completed) row.error ??= "no_completed_response";
    if (!row.usage || row.usage.cached === null) row.error ??= "usage_unknown";
    row.outputOK = output.trim() === "OK";
  } catch {
    row.error ??= abort.signal.aborted ? (stopRequested ? "interrupted" : "timeout") : "request_failed";
  } finally {
    clearTimeout(timer); activeController = null;
    lag.disable(); row.eventLoopMaxMs = Math.round(Number(lag.max) / 1e6);
    row.totalMs = at(); row.loadAfter = loadavg();
  }
  return row;
}

const rows: Row[] = [];
let stopReason: string | null = null;
for (let sequence = 0; sequence < schedule.length; sequence++) {
  if (stopRequested) { stopReason = "interrupted"; break; }
  if (loadavg()[0]! > 20) { stopReason = "local_load_high"; break; }
  const item = schedule[sequence]!;
  console.log(JSON.stringify({ event: "starting", sequence, ...item }));
  const row = await measure(item, sequence);
  rows.push(row);
  await appendFile(rawFile, JSON.stringify(row) + "\n");
  console.log(JSON.stringify({ event: "result", sequence, group: row.group, stage: row.stage, cached: row.usage?.cached ?? null, input: row.usage?.input ?? null, firstTextMs: row.firstTextMs, totalMs: row.totalMs, outputOK: row.outputOK, error: row.error }));
  if (row.error) { stopReason = row.error; break; }
}
const measured = rows.filter(r => r.stage === "measure");
const valid = (r: Row) => r.error === null && r.usage?.cached !== null && r.usage !== null;
const pairResults = Array.from({ length: pairs }, (_, pair) => {
  const a = measured.find(r => r.pair === pair && r.group === "session-key");
  const b = measured.find(r => r.pair === pair && r.group === "installation-key");
  const complete = !!a && !!b && valid(a) && valid(b);
  return {
    pair, complete, order: measured.filter(r => r.pair === pair).map(r => r.group),
    cachedDeltaFixedMinusSession: complete ? b!.usage!.cached! - a!.usage!.cached! : null,
    firstTextDeltaFixedMinusSessionMs: complete && a!.firstTextMs !== null && b!.firstTextMs !== null ? b!.firstTextMs - a!.firstTextMs : null,
    totalDeltaFixedMinusSessionMs: complete ? b!.totalMs - a!.totalMs : null,
    bothOutputOK: complete ? a!.outputOK && b!.outputOK : null,
  };
});
const summary = {
  model: MODEL, pairsPlanned: pairs, requestsCompleted: rows.length,
  complete: rows.length === schedule.length && rows.every(valid), stopReason,
  payloadInvariant, uniqueSessions: usedSessions.size, requestIdentities: usedRequestIds.size,
  arms: groups.map(group => {
    const all = measured.filter(r => r.group === group), ok = all.filter(valid);
    return {
      group, requests: all.length, valid: ok.length, errorsOrUnknown: all.length - ok.length,
      zeroCache: ok.filter(r => r.usage!.cached === 0).length,
      nonzeroCache: ok.filter(r => r.usage!.cached! > 0).length,
      cachedP50: pct(ok.map(r => r.usage!.cached!), 0.5),
      cachedFractionP50: pct(ok.filter(r => r.usage!.input > 0).map(r => r.usage!.cached! / r.usage!.input), 0.5),
      firstTextP50Ms: pct(ok.flatMap(r => r.firstTextMs === null ? [] : [r.firstTextMs]), 0.5),
      totalP50Ms: pct(ok.map(r => r.totalMs), 0.5),
      outputOK: ok.filter(r => r.outputOK).length,
    };
  }),
  pairResults,
  warmups: rows.filter(r => r.stage === "warmup"),
  errors: rows.filter(r => r.error).map(r => ({ sequence: r.sequence, error: r.error })),
};
await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ event: "summary", ...summary }));
process.exit(summary.complete ? 0 : 2);
