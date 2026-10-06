/**
 * P3(b) 扩展页面里的流式探针：像产品一样用 providers/all + 打包进来的登录模块 + openai-completions.lazy，
 * 经 Models.streamSimple 流式取一句话。凭据只在内存里；登录刷新被替换成直接报错，实验不会轮换令牌。
 */
import { createProvider, InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { registerBundledOAuthFlowLoaders } from "@earendil-works/pi-ai/auth/oauth/load";
import { githubCopilotOAuth } from "@earendil-works/pi-ai/auth/oauth/github-copilot";
import { kimiCodingOAuth } from "@earendil-works/pi-ai/auth/oauth/kimi-coding";
import { openaiCodexOAuth } from "@earendil-works/pi-ai/auth/oauth/openai-codex";
import { xaiOAuth } from "@earendil-works/pi-ai/auth/oauth/xai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

registerBundledOAuthFlowLoaders({
  kimiCoding: () => kimiCodingOAuth, githubCopilot: () => githubCopilotOAuth, xai: () => xaiOAuth, openaiCodex: () => openaiCodexOAuth,
  anthropic: () => { throw new Error("n/a"); }, openrouter: () => { throw new Error("n/a"); }, radius: () => { throw new Error("n/a"); },
});

const PROMPT = "Say hello in five words.";

const credentials = new InMemoryCredentialStore();

const models = builtinModels({ credentials });

// 订阅登录：只把 refresh 换成报错，toAuth 仍走真实登录模块。
for (const id of ["openai-codex", "kimi-coding", "xai", "github-copilot"]) {
  const p = models.getProvider(id);

  if (p?.auth.oauth) models.setProvider({ ...p, auth: { ...p.auth, oauth: { ...p.auth.oauth, refresh: async () => { throw new Error("probe: OAuth refresh disabled"); } } } });
}

const CUSTOM_ID = "custom-probe";

const customModel = (id: string, baseUrl: string): Model<"openai-completions"> => ({
  id, name: id, api: "openai-completions", provider: CUSTOM_ID, baseUrl,
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384,
});

models.setProvider(createProvider({
  id: CUSTOM_ID, name: "custom", baseUrl: "https://api.deepseek.com/v1",
  auth: { apiKey: { name: "API key", resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key ?? "" }, source: "probe" }) } },
  models: [customModel("deepseek-flash", "https://api.deepseek.com/v1")], api: openAICompletionsApi(),
}));

type Cred = { type: "api_key"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number; accountId?: string };

async function setup(providerId: string, cred: Cred) {
  await credentials.modify(providerId, async () => cred);

  return { ok: true };
}

async function run(providerId: string, modelId: string, customBaseUrl?: string) {
  const model: Model<Api> | undefined = providerId === CUSTOM_ID ? customModel(modelId, customBaseUrl!) : models.getModel(providerId, modelId);

  if (!model) return { ok: false, error: `model not found ${providerId}/${modelId}` };

  const t0 = performance.now();

  const types: string[] = [];

  let firstEventMs: number | undefined;

  let firstTextMs: number | undefined;

  let text = "";

  const ctl = new AbortController();

  const timer = setTimeout(() => ctl.abort(), 60_000);

  try {
    const stream = models.streamSimple(model, { messages: [{ role: "user", content: PROMPT, timestamp: Date.now() }] }, { signal: ctl.signal });

    for await (const ev of stream) {
      firstEventMs ??= Math.round(performance.now() - t0);

      if (types.at(-1) !== ev.type) types.push(ev.type);

      if (ev.type === "text_delta") { firstTextMs ??= Math.round(performance.now() - t0); text += ev.delta; }
    }

    const msg = await stream.result();

    const totalMs = Math.round(performance.now() - t0);

    return { ok: msg.stopReason !== "error" && msg.stopReason !== "aborted", stopReason: msg.stopReason, error: msg.errorMessage?.slice(0, 300), firstEventMs, firstTextMs, totalMs, text: text.slice(0, 200), eventTypes: types, usage: msg.usage?.totalTokens };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e).slice(0, 300), firstEventMs, firstTextMs, totalMs: Math.round(performance.now() - t0), eventTypes: types };
  } finally {
    clearTimeout(timer);
  }
}

Object.assign(globalThis, { probe: { setup, run } });
