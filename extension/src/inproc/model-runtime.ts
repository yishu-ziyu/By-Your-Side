/**
 * 扩展内的模型运行时：服务商目录、凭据、模型解析。
 *
 * offscreen 里的 agent 和设置页共用这一份，保证「设置页测试连接通过」和「agent 实际调用」走同一条解析路径。
 * 凭据落盘方式由调用方决定：设置页直接写 chrome.storage，offscreen 文档只能经 background 转写。
 */
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
import type { ModelPort } from "../../../agent/src/agent-loop.js";
import { isTransientModelError, retryWhenBusy } from "../../../shared/provider-busy.js";
import { isProviderBusyError } from "../../../shared/user-facing.js";
import { measuredModelIds, providerConcurrency, thinkingProfile, unlistedModel, withMeasuredCapability } from "../../../shared/model-capabilities.js";
import { gatedCall, gatedStream, ProviderGate, type ModelQueueWait, type QueuePurpose } from "./provider-gate.js";
import { COMMANDCODE_PROVIDER_ID, CUSTOM_PROVIDER_ID, STEPFUN_PROVIDER_ID, type InprocModelConfig, type StoredCredentials } from "./shared.js";

// Pi 默认用变量路径按需加载订阅登录模块，打包后找不到文件；这里把设备码类登录直接打进来。
// 需要本机回调服务的（Claude 订阅、OpenRouter）浏览器里用不了，明确报错。
const unsupported = (name: string) => () => { throw new Error(`${name} 登录暂不支持在浏览器里完成`); };

registerBundledOAuthFlowLoaders({
  kimiCoding: () => kimiCodingOAuth, githubCopilot: () => githubCopilotOAuth, xai: () => xaiOAuth, openaiCodex: () => openaiCodexOAuth,
  anthropic: unsupported("Claude 订阅"), openrouter: unsupported("OpenRouter"), radius: unsupported("Radius"),
  // Pi 1.0 新增；两者都要本机回调服务。
  openaiChatGPT: unsupported("ChatGPT（OpenAI 平台）"), meta: unsupported("Meta"),
});

/** 设备码登录能在浏览器里完成的服务商。Claude 订阅不接：Anthropic 不允许在第三方工具里使用。 */
const BROWSER_OAUTH = new Set(["kimi-coding", "github-copilot", "xai", "openai-codex"]);

/** pi-ai 给这几家的登录文案是英文。 */
const LOGIN_LABELS = new Map([["kimi-coding", "用 Kimi Code 账号登录"], ["xai", "用 SuperGrok 或 X Premium 登录"]]);

/** 需要额外账号参数（区域、网关编号、云凭据）的服务商，第一版设置页不提供。 */
const NEEDS_EXTRA_CONFIG = new Set(["amazon-bedrock", "google-vertex", "azure-openai-responses", "cloudflare-ai-gateway", "cloudflare-workers-ai", "radius"]);

/** TypeSafe 只提供给 Jev 用的分类接口，不能当对话模型；Jev 已于 2026-10-01 退役（docs/ROADMAP.md 第 9 条），设置页不列它。 */
const RETIRED_JEV_PROVIDER = "typesafe";

/** 设置页置顶的套餐，按用户实际在用的排序；默认模型是已在扩展内跑通「圈出保存按钮」的那个。 */
const omitCookies: typeof fetch = (input, init) => fetch(input, { ...init, credentials: "omit" });

export const FEATURED_PROVIDERS: ReadonlyArray<{ id: string; label: string; defaultModel: string }> = [
  { id: COMMANDCODE_PROVIDER_ID, label: "Command Code", defaultModel: "xiaomi/mimo-v2.6-flash" },
  // 阶跃星辰排第一：同一个 key 还能用于实时语音；step-3.7-flash 实测约 1 秒返回且工具调用正确。
  { id: STEPFUN_PROVIDER_ID, label: "阶跃星辰", defaultModel: "step-3.7-flash" },
  { id: "opencode-go", label: "OpenCode Go", defaultModel: "mimo-v2.6-flash" },
  { id: "zai-coding-cn", label: "智谱 GLM 编程版", defaultModel: "glm-5.3-flash" },
  { id: "kimi-coding", label: "Kimi For Coding", defaultModel: "kimi-for-coding" },
];

/** ChatGPT 账号调用会被拒（「not supported when using Codex with a ChatGPT account」，2026-10-06 实测），设置页不列出。 */
const HIDDEN_MODELS = new Map<string, ReadonlySet<string>>([
  ["openai-codex", new Set(["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"])],
]);

/** 不在置顶套餐里、但目录第一项不适合当默认的服务商。 */
export const DEFAULT_MODELS = new Map([["openai-codex", "gpt-6-luna"]]);

export interface ProviderChoice {
  id: string;
  name: string;
  apiKey: boolean;
  /** 设备码登录按钮上的文字；没有表示只能填 key。 */
  oauthLabel?: string;
  models: string[];
}

/**
 * 凭据改动时回调落盘。pi-ai 的 Models 在 modify 里做令牌刷新，所以刷新后的令牌也经这里写回，
 * 扩展重启后不会拿着已轮换作废的旧令牌。
 */
export class MirroredCredentialStore extends InMemoryCredentialStore {
  constructor(private readonly persist: (providerId: string, credential: Credential | undefined) => Promise<void> | void) {
    super();
  }

  /** 用存储里的整表替换内存内容；这是读入，不回写。 */
  async load(all: StoredCredentials): Promise<void> {
    for (const { providerId } of await super.list()) {
      if (!(providerId in all)) await super.delete(providerId);
    }

    for (const [providerId, credential] of Object.entries(all)) {
      // SAFETY: StoredCredential 按 pi-ai Credential 的形状声明（见 shared.ts），pickCredentials 已逐项核对。
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
  /** 同一个扩展进程内的请求共用一个会话编号（OpenCode 按它路由，部分服务商按它做缓存）。 */
  sessionId: string;
  credentials: MirroredCredentialStore;
  models: MutableModels;
  /** 按设置解析出要调用的模型；自定义服务在这里注册成一个服务商。 */
  resolveModel(config: InprocModelConfig | null): Model<Api>;
  /** 某些服务商要求的额外请求头。 */
  headersFor(model: Model<Api>): Record<string, string> | undefined;
  /** 供同一任务核心使用，当前设置由 offscreen 宿主提供。 */
  createCoreModels(selectedConfig: () => InprocModelConfig | null, fastConfig?: () => InprocModelConfig | null, backupConfig?: () => InprocModelConfig | null): ModelPort;
  /** 设置页里能选的服务商，常用套餐在前。 */
  providerChoices(): ProviderChoice[];
}

/** OpenAI 兼容服务：自定义地址和 pi-ai 目录里没有的阶跃星辰都用它注册。能力（思考档、能否看图）取实测登记，没有登记按保守默认。 */
interface CompatibleProvider { provider: Provider; models: Model<"openai-completions">[] }

function openAICompatible(id: string, name: string, baseUrl: string, modelIds: readonly string[]): CompatibleProvider {
  const models = modelIds.map((modelId): Model<"openai-completions"> => withMeasuredCapability({
    id: modelId, name: modelId, api: "openai-completions", provider: id, baseUrl,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384,
  }));

  const provider = createProvider({
    id, name, baseUrl,
    // 自定义地址可能是不要 key 的本机服务（如 Ollama），所以没填也算已配置。
    auth: { apiKey: { name: "API key", resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key ?? "" }, source: "设置" }) } },
    models, api: openAICompletionsApi(),
  });

  return { provider, models };
}

/**
 * Command Code 的 GOAT 套餐里每个模型有单独的月度额度，用户只用这两个、互相切换（MiMo 便宜、可高频调用）。
 * 同一个 key 两种接口：MiMo 走 OpenAI 兼容的 /chat/completions，Claude 只开放 Anthropic 的 /messages
 * （SDK 自己拼 /v1/messages，所以它的地址不带 /v1）。pi-ai 目录里还没有 Haiku 5.5：它和 Sonnet 5.5 同代、只收自适应思考（沿用 Haiku 4.5 的接法会回 400「thinking.type.enabled is not supported」），所以沿用 Sonnet 5.5 的接法，编号、价格（≤10 万 token 档）和上下文按 Command Code 的模型页；缓存写入价页面没写，按 Anthropic 惯例取输入价的 1.25 倍。
 */
const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider";

function commandCodeProvider(haikuTemplate: Model<Api> | undefined): Provider {
  const mimo = withMeasuredCapability<"openai-completions">({
    id: "xiaomi/mimo-v2.6-flash", name: "MiMo V2.6 Flash", api: "openai-completions", provider: COMMANDCODE_PROVIDER_ID, baseUrl: `${COMMANDCODE_BASE_URL}/v1`,
    reasoning: true, input: ["text", "image"], cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 32_768,
  });
  const haiku: Model<"anthropic-messages"> | undefined = haikuTemplate?.api === "anthropic-messages"
    ? {
      ...(haikuTemplate as Model<"anthropic-messages">), id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: COMMANDCODE_PROVIDER_ID, baseUrl: COMMANDCODE_BASE_URL,
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, contextWindow: 1_000_000, maxTokens: 64_000,
      // Command Code 的 /messages 不收对话中途的 system 消息（回 400「Invalid input at messages.1.role」），只保留自适应思考等其余兼容项。
      compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
    }
    : undefined;

  return createProvider<"openai-completions" | "anthropic-messages">({
    id: COMMANDCODE_PROVIDER_ID, name: "Command Code",
    auth: { apiKey: { name: "Command Code API key", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "设置" } : undefined } },
    models: haiku ? [mimo, haiku] : [mimo],
    api: { "openai-completions": openAICompletionsApi(), "anthropic-messages": anthropicMessagesApi() },
  });
}

const STEPFUN_MODELS = ["step-3.7-flash", "step-3.5-flash-2603", "step-5-preview"];

/**
 * 文字模型只走 Step Plan 通道，扣套餐 Credit。同一个 key 发到普通 `/v1` 也能成功，但扣的是 API 余额，
 * 所以通道只由地址决定。按 API 计费的只有实时语音（`/v1/realtime`，stepaudio-3 不在 Step Plan 里）。
 */
const STEPFUN_STEP_PLAN_BASE_URL = "https://api.stepfun.com/step_plan/v1";

export function createModelRuntime(persist: (providerId: string, credential: Credential | undefined) => Promise<void> | void): ModelRuntime {
  const credentials = new MirroredCredentialStore(persist);
  const models = builtinModels({ credentials });
  models.setProvider(openAICompatible(STEPFUN_PROVIDER_ID, "阶跃星辰", STEPFUN_STEP_PLAN_BASE_URL, STEPFUN_MODELS).provider);
  models.setProvider(commandCodeProvider(models.getModel("anthropic", "claude-sonnet-5-5")));
  /** OpenCode 按会话路由，缺 x-opencode-session 会直接 400；Pi 的 coding-agent 层会补，直接用 pi-ai 时要自己补。 */
  const sessionId = crypto.randomUUID();

  function resolveModel(config: InprocModelConfig | null): Model<Api> {
    if (!config?.provider || !config.modelId) throw new Error("还没有连接模型。打开「更多 → 模型与语音」，选一个服务商。");

    if (config.provider === CUSTOM_PROVIDER_ID) {
      if (!config.baseUrl) throw new Error("自定义服务缺少地址：在「模型与语音」里填写。");
      const { provider, models: [model] } = openAICompatible(CUSTOM_PROVIDER_ID, "自定义 OpenAI 兼容", config.baseUrl, [config.modelId]);
      models.setProvider(provider);

      return model!;
    }

    const known = models.getModel(config.provider, config.modelId);

    if (known) return withMeasuredCapability(known);
    // 目录滞后于服务商（如 MiniMax-M3.1-Flash-Preview、OpenCode Go 的 mimo-v2.6-flash）：连接参数沿用同服务商的模型，能力取实测登记或保守默认。
    const unlisted = unlistedModel(config.provider, config.modelId, models.getModels(config.provider));

    if (!unlisted) throw new Error(`找不到模型 ${config.provider}/${config.modelId}`);

    return unlisted;
  }

  function headersFor(model: Model<Api>): Record<string, string> | undefined {
    if (model.provider !== "opencode" && model.provider !== "opencode-go" && !model.baseUrl.includes("opencode.ai")) return undefined;

    return { "x-opencode-session": sessionId, "x-opencode-client": "by-your-side" };
  }

  /** 目录里的模型加上实测登记过、目录还没收的（如 MiniMax-M3.1-Flash-Preview）；登记的模型要靠同服务商目录模型解析，目录为空的不加。 */
  function listedModels(providerId: string): string[] {
    const catalog = models.getModels(providerId).map((m) => m.id);
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

  const runtime: ModelRuntime = {
    sessionId, credentials, models, resolveModel, headersFor, providerChoices,
    createCoreModels: (selectedConfig, fastConfig, backupConfig) => createCoreModelPort(runtime, selectedConfig, fastConfig, backupConfig),
  };

  return runtime;
}

/** 试连最多等 15 秒：设置页「测试连接」、保存前试连和侧栏换 key 共用。OpenCode Go 排队时可能超过它，超时会如实说并给重试。 */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * 向模型发一句「回 OK」，确认这组凭据能用：设置页「测试连接」和侧栏换 key 面板共用。
 * 失败时抛出服务商原文；超时由调用方的 signal 决定。
 */
export async function probeModel(probe: ModelRuntime, config: InprocModelConfig, signal: AbortSignal): Promise<void> {
  const model = probe.resolveModel(config);
  // 取能力表里最低的一档：不发档位时适配层会发「关闭思考」，始终思考的模型（GLM-5.3-flash）回 400。
  const [lowest] = thinkingProfile(model).levels;

  const reply = await probe.models.completeSimple(model, {
    messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }],
  }, { maxTokens: 256, signal, headers: probe.headersFor(model), sessionId: probe.sessionId, reasoning: lowest === "off" ? undefined : lowest });

  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "服务商返回错误");
}

/** 后台短调用遇到「忙」、本扩展里这家服务商又没有别的请求可等时的重试间隔：与 retryWhenBusy 相同。 */
const BUSY_RETRY_DELAYS_MS = [1_500, 3_000];

/** ModelQueueOptions 不是 pi-ai 的字段：按形状读出，不做类型断言。 */
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

/**
 * 让扩展模型目录满足任务核心的模型接口，保留当前设置页的模型解析与 OpenCode 请求头。
 * 任务核心（主任务、对冲请求、后台判断、翻译、阅读）的模型请求都从这个接口发出，所以服务商并发闸门放在这里；
 * 设置页的试连和测速在另一个页面里用自己的运行时，不经过它。
 */
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
    // 模型请求只靠我们自己的凭据。扩展有网站权限，fetch 默认会带上用户在这个网站的 cookie（比如 chatgpt.com 网页版的登录），
    // 一律不带。提前建连接（conversation-manager 的 warmUp）也用 omit：Chrome 按凭据模式分连接池，两边不一致就复用不上。
    const merged = { ...options, fetch: omitCookies, ...(headers ? { headers: { ...options?.headers, ...headers } } : {}) };

    // 浏览器的 WebSocket 不能带请求头：ChatGPT 登录的模型默认先试 WebSocket，必失败再退回 SSE，每次都留一条假的连接失败。直接用 SSE。
    return model.api === "openai-codex-responses" ? { ...merged, transport: "sse" as const } : merged;
  };

  const gate = new ProviderGate(providerConcurrency);

  const complete = (model: Model<Api>, context: Parameters<ModelPort["completeSimple"]>[1], options: Parameters<ModelPort["completeSimple"]>[2], onWait: (wait: ModelQueueWait) => void) =>
    gatedCall(gate, model, queueOptions(options).purpose, options?.signal, () => runtime.models.completeSimple(model, context, withHeaders(model, options)), onWait);

  /**
   * 一次性调用遇到「忙」，登记了并发上限的服务商：本扩展里这家还有在途或排着的请求，就等它们结束再试；
   * 没有（真被限流，或别的程序在用同一个账号）就照旧按固定间隔重试。没登记的服务商照旧按固定间隔重试。
   */
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
    // 设置里没选或选的模型解析不了时回到主模型，不让即时动作因为快速模型配置出错而失败。
    fastModel: () => resolveOptional(fastConfig()),
    // 主任务的备用模型；没选或解析不了时不换。
    backupModel: () => resolveOptional(backupConfig()),
    providerName: provider => FEATURED_PROVIDERS.find(p => p.id === provider)?.label ?? runtime.models.getProviders().find(p => p.id === provider)?.name,
    async getAvailable(provider, options) {
      const available = await runtime.models.getAvailable(provider, options);
      const config = selectedConfig();

      if (!config || (provider && provider !== config.provider)) return available;
      const selected = runtime.resolveModel(config);

      if (available.some(model => model.provider === selected.provider && model.id === selected.id)) return available;

      // 自定义地址可以不需要 key；其他目录外模型只有该服务商鉴权可用时才展示。
      if (config.provider !== CUSTOM_PROVIDER_ID && !available.some(model => model.provider === config.provider)) return available;

      return [...available, selected];
    },
    streamSimple: (model, context, options) => gatedStream(gate, model, "main", options?.signal, () => runtime.models.streamSimple(model, context, withHeaders(model, options)), onWait, queueOptions(options).onQueued),
    // 记忆判断、目标核对这些短调用常和主模型同时发出：服务商回「忙」就等一下再试，不让判断悄悄失败。
    // 还是暂时出错（与主任务同一判断：401、额度用尽不算）时，有和它不同的备用模型就在备用上再问一次（R3）。
    // 主任务只走 streamSimple，不经过这里，所以不会和主任务的换模型叠在一起。
    async completeSimple(model, context, options) {
      const reply = await completeWhenFree(model, context, options, onWait);
      const backup = resolveOptional(backupConfig());

      if (reply.stopReason !== "error" || options?.signal?.aborted || !backup || `${backup.provider}/${backup.id}` === `${model.provider}/${model.id}` || !isTransientModelError(reply)) return reply;

      // 调用方按原模型定的思考档换了服务商可能被拒：备用取它能力表里最低的一档。
      const [lowest] = thinkingProfile(backup).levels;
      console.debug("[sideagent]", `side call switched to backup: ${model.provider}/${model.id} -> ${backup.provider}/${backup.id}`);

      return complete(backup, context, { ...options, reasoning: lowest === "off" ? undefined : lowest }, onWait);
    },
    observeQueue: port,
  });

  return port(() => {});
}
