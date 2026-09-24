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
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerBundledOAuthFlowLoaders } from "@earendil-works/pi-ai/auth/oauth/load";
import { githubCopilotOAuth } from "@earendil-works/pi-ai/auth/oauth/github-copilot";
import { kimiCodingOAuth } from "@earendil-works/pi-ai/auth/oauth/kimi-coding";
import { openaiCodexOAuth } from "@earendil-works/pi-ai/auth/oauth/openai-codex";
import { xaiOAuth } from "@earendil-works/pi-ai/auth/oauth/xai";
import type { ModelPort } from "../../../agent/src/agent-loop.js";
import { CUSTOM_PROVIDER_ID, STEPFUN_PROVIDER_ID, type InprocModelConfig, type StoredCredentials } from "./shared.js";

// Pi 默认用变量路径按需加载订阅登录模块，打包后找不到文件；这里把设备码类登录直接打进来。
// 需要本机回调服务的（Claude 订阅、OpenRouter）浏览器里用不了，明确报错。
const unsupported = (name: string) => () => { throw new Error(`${name} 登录暂不支持在浏览器里完成`); };

registerBundledOAuthFlowLoaders({
  kimiCoding: () => kimiCodingOAuth, githubCopilot: () => githubCopilotOAuth, xai: () => xaiOAuth, openaiCodex: () => openaiCodexOAuth,
  anthropic: unsupported("Claude 订阅"), openrouter: unsupported("OpenRouter"), radius: unsupported("Radius"),
});

/** 设备码登录能在浏览器里完成的服务商。Claude 订阅不接：Anthropic 不允许在第三方工具里使用。 */
const BROWSER_OAUTH = new Set(["kimi-coding", "github-copilot", "xai", "openai-codex"]);

/** 需要额外账号参数（区域、网关编号、云凭据）的服务商，第一版设置页不提供。 */
const NEEDS_EXTRA_CONFIG = new Set(["amazon-bedrock", "google-vertex", "azure-openai-responses", "cloudflare-ai-gateway", "cloudflare-workers-ai", "radius"]);

/** 设置页置顶的套餐，按用户实际在用的排序；默认模型是已在扩展内跑通「圈出保存按钮」的那个。 */
export const FEATURED_PROVIDERS: ReadonlyArray<{ id: string; label: string; defaultModel: string }> = [
  // 阶跃星辰排第一：同一个 key 还能用于实时语音；step-3.7-flash 实测约 1 秒返回且工具调用正确。
  { id: STEPFUN_PROVIDER_ID, label: "阶跃星辰", defaultModel: "step-3.7-flash" },
  { id: "opencode-go", label: "OpenCode Go", defaultModel: "mimo-v2.6-flash" },
  { id: "zai-coding-cn", label: "智谱 GLM 编程版", defaultModel: "glm-5.3-flash" },
  { id: "kimi-coding", label: "Kimi For Coding", defaultModel: "kimi-for-coding" },
];

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
  createCoreModels(selectedConfig: () => InprocModelConfig | null): ModelPort;
  /** 设置页里能选的服务商，常用套餐在前。 */
  providerChoices(): ProviderChoice[];
}

/** OpenAI 兼容服务：自定义地址和 pi-ai 目录里没有的阶跃星辰都用它注册。 */
interface CompatibleProvider { provider: Provider; models: Model<"openai-completions">[] }

function openAICompatible(id: string, name: string, baseUrl: string, modelIds: readonly string[]): CompatibleProvider {
  const models = modelIds.map((modelId): Model<"openai-completions"> => ({
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

const STEPFUN_MODELS = ["step-3.7-flash", "step-3.5-flash", "step-5-preview"];

export function createModelRuntime(persist: (providerId: string, credential: Credential | undefined) => Promise<void> | void): ModelRuntime {
  const credentials = new MirroredCredentialStore(persist);
  const models = builtinModels({ credentials });
  models.setProvider(openAICompatible(STEPFUN_PROVIDER_ID, "阶跃星辰", "https://api.stepfun.com/v1", STEPFUN_MODELS).provider);
  /** OpenCode 按会话路由，缺 x-opencode-session 会直接 400；Pi 的 coding-agent 层会补，直接用 pi-ai 时要自己补。 */
  const sessionId = crypto.randomUUID();

  function resolveModel(config: InprocModelConfig | null): Model<Api> {
    if (!config?.provider || !config.modelId) throw new Error("还没有配置模型：打开右上角「更多 → 模型与语音」选择服务商。");

    if (config.provider === CUSTOM_PROVIDER_ID) {
      if (!config.baseUrl) throw new Error("自定义服务缺少地址：在「模型与语音」里填写。");
      const { provider, models: [model] } = openAICompatible(CUSTOM_PROVIDER_ID, "自定义 OpenAI 兼容", config.baseUrl, [config.modelId]);
      models.setProvider(provider);

      return model!;
    }

    const known = models.getModel(config.provider, config.modelId);

    if (known) return known;
    // 目录滞后于服务商（如 OpenCode Go 的 mimo-v2.6-flash）：沿用该服务商 OpenAI 兼容模型的配置，只换 id。
    const template = models.getModels(config.provider).find((m) => m.api === "openai-completions");

    if (!template) throw new Error(`找不到模型 ${config.provider}/${config.modelId}`);

    return { ...template, id: config.modelId, name: config.modelId, maxTokens: Math.min(template.maxTokens, 32_768) };
  }

  function headersFor(model: Model<Api>): Record<string, string> | undefined {
    if (model.provider !== "opencode" && model.provider !== "opencode-go" && !model.baseUrl.includes("opencode.ai")) return undefined;

    return { "x-opencode-session": sessionId, "x-opencode-client": "by-your-side" };
  }

  function providerChoices(): ProviderChoice[] {
    const featured = new Map(FEATURED_PROVIDERS.map((p, i) => [p.id, i]));

    const choices = models.getProviders()
      .filter((p) => !NEEDS_EXTRA_CONFIG.has(p.id) && p.id !== CUSTOM_PROVIDER_ID)
      .map((p): ProviderChoice => ({
        id: p.id,
        name: FEATURED_PROVIDERS.find((f) => f.id === p.id)?.label ?? p.name,
        apiKey: !!p.auth.apiKey,
        oauthLabel: p.auth.oauth && BROWSER_OAUTH.has(p.id) ? p.auth.oauth.loginLabel ?? `用 ${p.name} 账号登录` : undefined,
        models: models.getModels(p.id).map((m) => m.id),
      }));

    return choices.sort((a, b) => (featured.get(a.id) ?? 99) - (featured.get(b.id) ?? 99) || a.name.localeCompare(b.name));
  }

  const runtime: ModelRuntime = {
    sessionId, credentials, models, resolveModel, headersFor, providerChoices,
    createCoreModels: selectedConfig => createCoreModelPort(runtime, selectedConfig),
  };

  return runtime;
}

/** 让扩展模型目录满足任务核心的模型接口，保留当前设置页的模型解析与 OpenCode 请求头。 */
function createCoreModelPort(runtime: ModelRuntime, selectedConfig: () => InprocModelConfig | null): ModelPort {
  const selectedModel = (provider: string, id: string): Model<Api> | undefined => {
    const config = selectedConfig();

    return config?.provider === provider && config.modelId === id ? runtime.resolveModel(config) : undefined;
  };

  const withHeaders = (model: Model<Api>, options: Parameters<ModelPort["streamSimple"]>[2]) => {
    const headers = runtime.headersFor(model);

    return headers ? { ...options, headers: { ...options?.headers, ...headers } } : options;
  };

  return {
    getModel: (provider, id) => selectedModel(provider, id) ?? runtime.models.getModel(provider, id),
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
    streamSimple: (model, context, options) => runtime.models.streamSimple(model, context, withHeaders(model, options)),
    completeSimple: (model, context, options) => runtime.models.completeSimple(model, context, withHeaders(model, options)),
  };
}
