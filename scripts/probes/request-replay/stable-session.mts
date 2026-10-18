// Does a stable session-id header (not only prompt_cache_key) let a new conversation's first request hit the prefix cache?
// NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--conditions=import npx tsx scripts/probes/request-replay/stable-session.mts --rounds=8
import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadModelPlan } from "../../acceptance/real-path/inproc-config.mts";
import { arg, pct, sseParser } from "./shared.mts";

const rounds = Number(arg("rounds") ?? 8);
const experiment = randomUUID();
const stable = randomUUID();
const corpus = Array.from({ length: 384 }, (_, i) => "Record " + String(i + 1).padStart(4, "0") + ": copper book, north window, quiet garden, blue triangle, three shelves; inert catalog data for a fixed prefix.").join("\n");
const systemPrompt = "Synthetic cache experiment " + experiment + ".\nReply with exactly OK. Do not call tools.\n" + corpus + "\nEnd of records.";
const plan = await loadModelPlan("openai-codex/gpt-6-luna");
const credentials = new InMemoryCredentialStore();
const models = builtinModels({ credentials });
const provider = models.getProvider(plan.providerId)!;
models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!, refresh: async () => { throw new Error("no refresh"); } } } });
await credentials.modify(plan.providerId, async () => plan.credential as never);
const model = models.getModel(plan.providerId, plan.modelId)!;

async function one(arm: string, sessionId: string, task: string) {
  const t0 = performance.now(); let firstText: number | null = null; let cached: number | null = null; let input: number | null = null;
  const fetchHook: typeof fetch = async (input0, init) => {
    const res = await fetch(input0, { ...init, credentials: "omit" });
    const parse = sseParser(), dec = new TextDecoder();
    const body = res.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) {
      for (const e of parse(dec.decode(c, { stream: true }))) {
        if (e.type === "response.output_text.delta") firstText ??= Math.round(performance.now() - t0);
        if (e.type === "response.completed") { const u = (e.data as any)?.response?.usage; input = u?.input_tokens ?? null; cached = u?.input_tokens_details?.cached_tokens ?? null; }
      }
      ctl.enqueue(c);
    } }));
    return new Response(body, { status: res.status, headers: res.headers });
  };
  const s = models.streamSimple(model, { systemPrompt, messages: [{ role: "user", content: task, timestamp: 0 }], tools: [] }, { sessionId, reasoning: "low", maxTokens: 64, maxRetries: 0, transport: "sse", fetch: fetchHook } as never);
  let error: string | undefined;
  for await (const e of s) if (e.type === "error") error = String((e as any).error?.errorMessage ?? "error").slice(0, 160);
  const row = { arm, cached, input, firstText, error };
  console.log(JSON.stringify(row));
  return row;
}

const gap = Number(arg("gap-ms") ?? 3000);
const rows = [];
// prewarm: a throwaway request with the same session, then the real first request. control: real first request on a cold session.
for (let r = 0; r < rounds; r++) {
  const arms = r % 2 ? ["control", "prewarm"] : ["prewarm", "control"];
  for (const arm of arms) {
    const sid = randomUUID();
    if (arm === "prewarm") { await one("warm", sid, "Warm-up. Return OK."); await new Promise(res => setTimeout(res, gap)); }
    rows.push(await one(arm, sid, `Task ${randomUUID()}. Return OK.`));
  }
}
for (const arm of ["control", "prewarm"]) {
  const a = rows.filter(r => r.arm === arm && !r.error);
  console.log(arm, "hits", a.filter(r => (r.cached ?? 0) > 0).length + "/" + a.length, "firstText p50", pct(a.flatMap(r => r.firstText ?? []), 0.5), "errors", rows.filter(r => r.arm === arm && r.error).length);
}
