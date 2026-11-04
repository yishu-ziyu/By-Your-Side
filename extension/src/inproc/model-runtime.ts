import {
  createProvider, InMemoryCredentialStore,
  type Api, type AuthOperationOptions, type Credential, type Model, type MutableModels, type Provider,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerBundledOAuthFlowLoaders } from "@earendil-works/pi-ai/auth/oauth/load";
import { githubCopilotOAuth } from "@earendil-works/pi-ai/auth/oauth/github-copilot";
import { kimiCodingOAuth } from "@earendil-works/pi-ai/auth/oauth/kimi-coding";
import { openaiCodexOAuth } from "@earendil-works/pi-ai/auth/oauth/openai-codex";
import { xaiOAuth } from "@earendil-works/pi-ai/auth/oauth/xai";
import type { ModelPort } from "@sideagent/agent/browser-core";
import { isTransientModelError, retryWhenBusy } from "../../../shared/provider-busy.js";
import { isProviderBusyError } from "../../../shared/user-facing.js";
import { measuredModelIds, providerConcurrency, thinkingProfile, unlistedModel, withMeasuredCapability } from "../../../shared/model-capabilities.js";
import { gatedCall, gatedStream, ProviderGate, type ModelQueueWait, type QueuePurpose } from "./provider-gate.js";
import { COMMANDCODE_PROVIDER_ID, CUSTOM_PROVIDER_ID, CUSTOM_ENDPOINT_ENV, STEPFUN_PROVIDER_ID, type InprocModelConfig, type StoredCredentials } from "./shared.js";
import { codexIdentity, readCodexCatalog } from "./codex-catalog.js";
import { compactModelImages } from "./model-image-payload.js";

const unsupported = (name: string) => () => { throw new Error(`${name} 登录暂不支持在浏览器里完成`); };

registerBundledOAuthFlowLoaders({
  kimiCoding: () => kimiCodingOAuth, githubCopilot: () => githubCopilotOAuth, xai: () => xaiOAuth, openaiCodex: () => openaiCodexOAuth,
  anthropic: unsupported("Claude 订阅"), openrouter: unsupported("OpenRouter"), radius: unsupported("Radius"),
  openaiChatGPT: unsupported("ChatGPT（OpenAI 平台）"), meta: unsupported("Meta"),
});

const BROWSER_OAUTH = new Set(["kimi-coding", "github-copilot", "xai", "openai-codex"]);

const LOGIN_LABELS = new Map([["kimi-coding", "用 Kimi Code 账号登录"], ["xai", "用 SuperGrok 或 X Premium 登录"]]);

const NEEDS_EXTRA_CONFIG = new Set(["amazon-bedrock", "google-vertex", "azure-openai-responses", "cloudflare-ai-gateway", "cloudflare-workers-ai", "radius"]);

const RETIRED_JEV_PROVIDER = "typesafe";

export const omitCookies: typeof fetch = (input, init) => fetch(input, { ...init, credentials: "omit" });

export const FEATURED_PROVIDERS: ReadonlyArray<{ id: string; label: string; defaultModel: string }> = [
  { id: COMMANDCODE_PROVIDER_ID, label: "Command Code", defaultModel: "xiaomi/mimo-v2.6-flash" },
  { id: STEPFUN_PROVIDER_ID, label: "阶跃星辰", defaultModel: "step-3.7-flash" },
  { id: "opencode-go", label: "OpenCode Go", defaultModel: "mimo-v2.6-flash" },
  { id: "zai-coding-cn", label: "智谱 GLM 编程版", defaultModel: "glm-5.3-flash" },
  { id: "kimi-coding", label: "Kimi For Coding", defaultModel: "kimi-for-coding" },
];

const HIDDEN_MODELS = new Map<string, ReadonlySet<string>>([
  ["openai-codex", new Set(["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"])],
]);

export const DEFAULT_MODELS = new Map([["openai-codex", "gpt-6-luna"]]);

export interface ProviderChoice {
  id: string;
  name: string;
  apiKey: boolean;
  oauthLabel?: string;
  models: string[];
}

export class MirroredCredentialStore extends InMemoryCredentialStore {
  constructor(private readonly persist: (providerId: string, credential: Credential | undefined) => Promise<void> | void) {
    super();
  }

  async load(all: StoredCredentials): Promise<void> {
    for (const { providerId } of await super.list()) {
      if (!(providerId in all)) await super.delete(providerId);
    }

    for (const [providerId, credential] of Object.entries(all)) {
      await super.modify(providerId, async () => credential as Credential);
    }
  }

  override async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    const before = await super.read(providerId);
    const after = await super.modify(providerId, fn, options);

    if (after !== before) await this.persist(providerId, after);

    return after;
  }

  override async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await super.delete(providerId, options);
    await this.persist(providerId, undefined);
  }
}

export interface ModelRuntime {
  sessionId: string;
  credentials: MirroredCredentialStore;
  models: MutableModels;
  resolveModel(config: InprocModelConfig | null): Model<Api>;
  headersFor(model: Model<Api>): Record<string, string> | undefined;
  createCoreModels(selectedConfig: () => InprocModelConfig | null, fastConfig?: () => InprocModelConfig | null, backupConfig?: () => InprocModelConfig | null): ModelPort;
  providerChoices(): ProviderChoice[];
  loadProviderModels(signal?: AbortSignal): Promise<void>;
  applyCodexCatalog(value: unknown): Promise<void>;
}

interface CompatibleProvider { provider: Provider; models: Model<"openai-completions">[] }

function openAICompatible(id: string, name: string, baseUrl: string, modelIds: readonly string[]): CompatibleProvider {
  const models = modelIds.map((modelId): Model<"openai-completions"> => withMeasuredCapability({
    id: modelId, name: modelId, api: "openai-completions", provider: id, baseUrl,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384,
  }));

  const provider = createProvider({
    id, name, baseUrl,
    auth: { apiKey: { name: "API key", resolve: async ({ credential }) => {
      if (id !== CUSTOM_PROVIDER_ID && !credential?.key) return undefined;
      const endpoint = id === CUSTOM_PROVIDER_ID ? credential?.env?.[CUSTOM_ENDPOINT_ENV] : undefined;
      if (endpoint && !["http:", "https:"].includes(new URL(endpoint).protocol)) throw new Error("自定义服务地址无效，请在设置里重新连接。");
      return { auth: { apiKey: credential?.key ?? "", ...(endpoint ? { baseUrl: endpoint } : {}) }, source: "设置" };
    } } },
    models, api: openAICompletionsApi(),
  });

  return { provider, models };
}

const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider";

interface CommandCodeListing { id: string; name?: string; messages: boolean; contextWindow?: number }

const COMMANDCODE_FALLBACK: readonly CommandCodeListing[] = [
  { id: "xiaomi/mimo-v2.6-flash", name: "MiMo V2.6 Flash", messages: false },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", messages: true },
];

const COMMANDCODE_PRICES = new Map<string, Model<Api>["cost"]>([
  ["xiaomi/mimo-v2.6-flash", { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
]);

function commandCodeListing(value: unknown): CommandCodeListing | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return undefined;
  const endpoints = Array.isArray(value.supported_endpoints) ? value.supported_endpoints : [];
  const messages = endpoints.includes("/messages");

  if (!messages && !endpoints.includes("/chat/completions")) return undefined;

  return {
    id: value.id, messages,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.context_length === "number" && value.context_length > 0 ? { contextWindow: value.context_length } : {}),
  };
}

async function fetchCommandCodeModels(signal?: AbortSignal): Promise<CommandCodeListing[]> {
  const response = await omitCookies(`${COMMANDCODE_BASE_URL}/v1/models`, { signal });

  if (!response.ok) throw new Error(`Command Code 模型清单返回 ${response.status}`);
  const body: unknown = await response.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];

  return data.flatMap((item: unknown) => commandCodeListing(item) ?? []);
}

function commandCodeModel(listing: CommandCodeListing, anthropicCatalog: readonly Model<Api>[]): Model<"openai-completions" | "anthropic-messages"> | undefined {
  const cost = COMMANDCODE_PRICES.get(listing.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  if (listing.messages) {
    const template = anthropicCatalog.find((m) => m.id === listing.id) ?? anthropicCatalog.find((m) => m.id === "claude-sonnet-5-5");

    if (template?.api !== "anthropic-messages") return undefined;

    return {
      ...(template as Model<"anthropic-messages">), id: listing.id, name: listing.name ?? listing.id, provider: COMMANDCODE_PROVIDER_ID, baseUrl: COMMANDCODE_BASE_URL,
      cost, contextWindow: listing.contextWindow ?? template.contextWindow,
      compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
    };
  }

  return withMeasuredCapability<"openai-completions">({
    id: listing.id, name: listing.name ?? listing.id, api: "openai-completions", provider: COMMANDCODE_PROVIDER_ID, baseUrl: `${COMMANDCODE_BASE_URL}/v1`,
    reasoning: false, input: ["text"], cost, contextWindow: listing.contextWindow ?? 128_000, maxTokens: 32_768,
  });
}

function commandCodeProvider(listings: readonly CommandCodeListing[], anthropicCatalog: readonly Model<Api>[]): Provider {
  return createProvider<"openai-completions" | "anthropic-messages">({
    id: COMMANDCODE_PROVIDER_ID, name: "Command Code",
    auth: { apiKey: { name: "Command Code API key", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key, headers: { "anthropic-beta": null, "anthropic-dangerous-direct-browser-access": null } }, source: "设置" } : undefined } },
    models: listings.flatMap((l) => commandCodeModel(l, anthropicCatalog) ?? []),
    api: { "openai-completions": openAICompletionsApi(), "anthropic-messages": anthropicMessagesApi() },
  });
}

function withoutThinkingBlocks(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;

  const messages = payload.messages.map((message: unknown) => {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;

    return { ...message, content: message.content.filter((block: unknown) => !isRecord(block) || (block.type !== "thinking" && block.type !== "redacted_thinking")) };
  });

  return { ...payload, messages: messages.filter((message: unknown) => !isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length > 0) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const STEPFUN_MODELS = ["step-3.7-flash", "step-3.5-flash-2603", "step-5-preview"];

const STEPFUN_STEP_PLAN_BASE_URL = "https://api.stepfun.com/step_plan/v1";

export function createModelRuntime(persist: (providerId: string, credential: Credential | undefined) => Promise<void> | void): ModelRuntime {
  const credentials = new MirroredCredentialStore(persist);
  const models = builtinModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const codexProvider = models.getProvider("openai-codex");
  const codexBuiltins = models.getModels("openai-codex");
  let codexOnline = false;
  let codexCandidates = new Map<string, Model<Api>>();
  let codexCatalogGeneration = 0;
  models.setProvider(openAICompatible(STEPFUN_PROVIDER_ID, "阶跃星辰", STEPFUN_STEP_PLAN_BASE_URL, STEPFUN_MODELS).provider);
  models.setProvider(openAICompatible("inception", "Inception", "https://api.inceptionlabs.ai/v1", ["mercury-3"]).provider);
  const anthropicCatalog = models.getModels("anthropic");
  models.setProvider(commandCodeProvider(COMMANDCODE_FALLBACK, anthropicCatalog));
  const sessionId = crypto.randomUUID();

  function resolveModel(config: InprocModelConfig | null): Model<Api> {
    if (!config?.provider || !config.modelId) throw new Error("还没有连接模型。打开「更多 → 模型与语音」，选一个服务商。");

    if (config.provider === CUSTOM_PROVIDER_ID) {
      if (!config.baseUrl) throw new Error("自定义服务缺少地址：在「模型与语音」里填写。");
      const { provider, models: [model] } = openAICompatible(CUSTOM_PROVIDER_ID, "自定义 OpenAI 兼容", config.baseUrl, [config.modelId]);
      models.setProvider(provider);

      return model!;
    }

    const known = models.getModel(config.provider, config.modelId) ?? (config.provider === "openai-codex" ? codexCandidates.get(config.modelId) : undefined);

    if (known) return withMeasuredCapability(known);
    if (config.provider === COMMANDCODE_PROVIDER_ID) {
      const model = commandCodeModel({ id: config.modelId, messages: config.modelId.startsWith("claude-") }, anthropicCatalog);

      if (!model) throw new Error(`找不到模型 ${config.provider}/${config.modelId}`);

      return model;
    }
    const unlisted = unlistedModel(config.provider, config.modelId, models.getModels(config.provider));

    if (!unlisted) throw new Error(`找不到模型 ${config.provider}/${config.modelId}`);

    return unlisted;
  }

  function headersFor(model: Model<Api>): Record<string, string> | undefined {
    if (model.provider !== "opencode" && model.provider !== "opencode-go" && !model.baseUrl.includes("opencode.ai")) return undefined;

    return { "x-opencode-session": sessionId, "x-opencode-client": "by-your-side" };
  }

  function listedModels(providerId: string): string[] {
    const catalog = models.getModels(providerId).map((m) => m.id);
    if (providerId === "openai-codex" && codexOnline) return catalog;
    const hidden = HIDDEN_MODELS.get(providerId);
    const all = catalog.length ? [...new Set([...catalog, ...measuredModelIds(providerId)])] : catalog;

    return hidden ? all.filter((id) => !hidden.has(id)) : all;
  }

  function providerChoices(): ProviderChoice[] {
    const featured = new Map(FEATURED_PROVIDERS.map((p, i) => [p.id, i]));

    const choices = models.getProviders()
      .filter((p) => !NEEDS_EXTRA_CONFIG.has(p.id) && p.id !== RETIRED_JEV_PROVIDER && p.id !== CUSTOM_PROVIDER_ID)
      .map((p): ProviderChoice => ({
        id: p.id,
        name: FEATURED_PROVIDERS.find((f) => f.id === p.id)?.label ?? p.name,
        apiKey: !!p.auth.apiKey,
        oauthLabel: p.auth.oauth && BROWSER_OAUTH.has(p.id) ? LOGIN_LABELS.get(p.id) ?? p.auth.oauth.loginLabel ?? `用 ${p.name} 账号登录` : undefined,
        models: listedModels(p.id),
      }));

    return choices.sort((a, b) => (featured.get(a.id) ?? 99) - (featured.get(b.id) ?? 99) || a.name.localeCompare(b.name));
  }

  async function loadProviderModels(signal?: AbortSignal): Promise<void> {
    const listings = await fetchCommandCodeModels(signal);

    if (listings.length) models.setProvider(commandCodeProvider(listings, anthropicCatalog));
  }

  async function applyCodexCatalog(value: unknown): Promise<void> {
    if (!codexProvider) return;
    const generation = ++codexCatalogGeneration;
    const credential = await credentials.read("openai-codex");
    const identity = await codexIdentity(credential as StoredCredentials[string] | undefined);
    if (generation !== codexCatalogGeneration) return;
    const catalog = readCodexCatalog(value, identity);
    codexOnline = !!catalog;
    codexCandidates = new Map();
    if (!catalog) { models.setProvider(codexProvider); return; }
    const template = codexBuiltins[0];
    if (!template) { models.setProvider(codexProvider); codexOnline = false; return; }
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const entries = catalog.models.map(entry => {
      const known = codexBuiltins.find(model => model.id === entry.id);
      const base = known ? withMeasuredCapability(known) : template;
      const measuredLevels = known ? new Set(thinkingProfile(base).levels) : undefined;
      const thinkingLevelMap = Object.fromEntries(levels.map(level => {
        const remote = level === "off" ? "none" : level;
        return [level, entry.efforts.includes(remote) && (!measuredLevels || measuredLevels.has(level)) ? remote : null];
      }));
      return {
        ...base, id: entry.id, name: entry.name, reasoning: true,
        input: entry.input.filter(input => !known || base.input.includes(input)),
        contextWindow: entry.contextWindow, maxTokens: Math.min(base.maxTokens, entry.contextWindow, known ? base.maxTokens : 32_768),
        thinkingLevelMap, codexCatalogCapability: true,
      } satisfies Model<Api> & { codexCatalogCapability: true };
    });
    codexCandidates = new Map(entries.filter((_, i) => catalog.models[i]?.discoveryOnly).map(model => [model.id, model]));
    const available = entries.filter((_, i) => !catalog.models[i]?.discoveryOnly);
    models.setProvider({ ...codexProvider, getModels: () => available, getAllModels: () => available });
  }

  const runtime: ModelRuntime = {
    sessionId, credentials, models, resolveModel, headersFor, providerChoices, loadProviderModels, applyCodexCatalog,
    createCoreModels: (selectedConfig, fastConfig, backupConfig) => createCoreModelPort(runtime, selectedConfig, fastConfig, backupConfig),
  };

  return runtime;
}

export const PROBE_TIMEOUT_MS = 15_000;

export async function probeModel(probe: ModelRuntime, config: InprocModelConfig, signal: AbortSignal): Promise<void> {
  const model = probe.resolveModel(config);
  const [lowest] = thinkingProfile(model).levels;

  const reply = await probe.models.completeSimple(model, {
    messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }],
  }, { maxTokens: 256, signal, fetch: omitCookies, headers: probe.headersFor(model), sessionId: probe.sessionId, reasoning: lowest === "off" ? undefined : lowest });

  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "服务商返回错误");
}

const BUSY_RETRY_DELAYS_MS = [1_500, 3_000];

function queueOptions(options: object | undefined): { purpose: QueuePurpose; onQueued?: (sent: Promise<void>) => void } {
  const onQueued = options && "onQueued" in options && typeof options.onQueued === "function" ? options.onQueued : undefined;

  return {
    purpose: options && "userWaiting" in options && options.userWaiting === true ? "main" : "side",
    ...(onQueued ? { onQueued: (sent: Promise<void>) => { onQueued(sent); } } : {}),
  };
}

const pause = (ms: number, signal: AbortSignal | undefined) => new Promise<void>(done => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

function createCoreModelPort(
  runtime: ModelRuntime,
  selectedConfig: () => InprocModelConfig | null,
  fastConfig: () => InprocModelConfig | null = () => null,
  backupConfig: () => InprocModelConfig | null = () => null,
): ModelPort {
  const selectedModel = (provider: string, id: string): Model<Api> | undefined => {
    const config = selectedConfig();

    return config?.provider === provider && config.modelId === id ? runtime.resolveModel(config) : undefined;
  };

  const resolveOptional = (config: InprocModelConfig | null): Model<Api> | undefined => {
    if (!config) return undefined;

    try { return runtime.resolveModel(config); } catch { return undefined; }
  };

  const withHeaders = (model: Model<Api>, options: Parameters<ModelPort["streamSimple"]>[2]) => {
    const headers = runtime.headersFor(model);
    const merged = {
      ...options, fetch: omitCookies, ...(headers ? { headers: { ...options?.headers, ...headers } } : {}),
      ...(model.provider === COMMANDCODE_PROVIDER_ID && model.api === "anthropic-messages" ? { onPayload: withoutThinkingBlocks } : {}),
    };

    return { ...merged, ...(model.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
      onPayload: async (payload: unknown, selected: Model<Api>) => {
        const prepared = await merged.onPayload?.(payload, selected) ?? payload;
        return model.api === "openai-codex-responses" || model.provider === "minimax-cn" || model.provider === "minimax"
          ? compactModelImages(prepared) : prepared;
      },
    };
  };

  const gate = new ProviderGate(providerConcurrency);

  const complete = (model: Model<Api>, context: Parameters<ModelPort["completeSimple"]>[1], options: Parameters<ModelPort["completeSimple"]>[2], onWait: (wait: ModelQueueWait) => void) =>
    gatedCall(gate, model, queueOptions(options).purpose, options?.signal, () => runtime.models.completeSimple(model, context, withHeaders(model, options)), onWait);

  const completeWhenFree = async (model: Model<Api>, context: Parameters<ModelPort["completeSimple"]>[1], options: Parameters<ModelPort["completeSimple"]>[2], onWait: (wait: ModelQueueWait) => void) => {
    if (!gate.limited(model.provider)) return retryWhenBusy(() => complete(model, context, options, onWait), options?.signal);
    let reply = await complete(model, context, options, onWait);

    for (const delayMs of BUSY_RETRY_DELAYS_MS) {
      if (reply.stopReason !== "error" || !isProviderBusyError(reply.errorMessage) || options?.signal?.aborted) break;

      if (gate.busy(model.provider)) await gate.idle(model.provider, options?.signal);
      else await pause(delayMs, options?.signal);

      if (options?.signal?.aborted) break;
      reply = await complete(model, context, options, onWait);
    }

    return reply;
  };

  const port = (onWait: (wait: ModelQueueWait) => void): ModelPort => ({
    getModel: (provider, id) => selectedModel(provider, id) ?? runtime.models.getModel(provider, id),
    fastModel: () => resolveOptional(fastConfig()),
    backupModel: () => resolveOptional(backupConfig()),
    providerName: provider => FEATURED_PROVIDERS.find(p => p.id === provider)?.label ?? runtime.models.getProviders().find(p => p.id === provider)?.name,
    async getAvailable(provider, options) {
      const available = await runtime.models.getAvailable(provider, options);
      const config = selectedConfig();

      if (!config || (provider && provider !== config.provider)) return available;
      const selected = runtime.resolveModel(config);

      if (available.some(model => model.provider === selected.provider && model.id === selected.id)) return available;

      if (config.provider !== CUSTOM_PROVIDER_ID && !available.some(model => model.provider === config.provider)) return available;

      return [...available, selected];
    },
    streamSimple: (model, context, options) => gatedStream(gate, model, "main", options?.signal, () => runtime.models.streamSimple(model, context, withHeaders(model, options)), onWait, queueOptions(options).onQueued),
    async completeSimple(model, context, options) {
      const reply = await completeWhenFree(model, context, options, onWait);
      const backup = resolveOptional(backupConfig());

      if (reply.stopReason !== "error" || options?.signal?.aborted || !backup || `${backup.provider}/${backup.id}` === `${model.provider}/${model.id}` || !isTransientModelError(reply)) return reply;

      const [lowest] = thinkingProfile(backup).levels;
      console.debug("[sideagent]", `side call switched to backup: ${model.provider}/${model.id} -> ${backup.provider}/${backup.id}`);

      return complete(backup, context, { ...options, reasoning: lowest === "off" ? undefined : lowest }, onWait);
    },
    observeQueue: port,
    pi: runtime.models,
  });

  return port(() => {});
}
