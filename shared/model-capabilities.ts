import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";

interface MeasuredCapability {
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ("text" | "image")[];
  systemRole?: true;
  template?: string;
  contextWindow?: number;
  start?: ModelThinkingLevel;
  firstEventMs?: number;
  hedgeMs?: number;
}

const MEASURED = new Map<string, MeasuredCapability>([
  ["inception/mercury-3", { reasoning: true, input: ["text"], thinkingLevelMap: { off: null, minimal: "instant" }, systemRole: true, start: "low" }],
  ...(["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol"] as const).map((id): [string, MeasuredCapability] => [
    `openai-codex/${id}`,
    {
      reasoning: true, input: ["text", "image"], start: "low", firstEventMs: 30_000,
      ...(id === "gpt-6-luna" ? { hedgeMs: 6_000 } : id === "gpt-6.1-sol" ? { hedgeMs: 8_000 } : {}),
      thinkingLevelMap: id === "gpt-6.1-sol" ? { off: null, minimal: null, xhigh: "xhigh", max: "max" } : { xhigh: "xhigh", max: "max", minimal: "low" },
    },
  ]),
  ["minimax-cn/MiniMax-M3.1-Flash-Preview", {
    template: "MiniMax-M3", reasoning: true, input: ["text", "image"], hedgeMs: 12_000,
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  }],
  ["opencode-go/mimo-v2.6-flash", { reasoning: true, input: ["text"], thinkingLevelMap: { minimal: null } }],
  ["commandcode/xiaomi/mimo-v2.6-flash", { reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: null }, start: "low" }],
  ["stepfun/step-3.7-flash", { reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null }, systemRole: true }],
  ["stepfun/step-5-preview", { reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: null }, systemRole: true, start: "low", hedgeMs: 11_000 }],
  ["stepfun/step-3.5-flash-2603", { reasoning: true, input: ["text"], thinkingLevelMap: { off: null, minimal: null, medium: null }, systemRole: true }],
  ...(["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"] as const).map((id): [string, MeasuredCapability] => [`kimi-coding/${id}`, { hedgeMs: 0 }]),
]);

const key = (model: Pick<Model<Api>, "provider" | "id">) => `${model.provider}/${model.id}`;

export function measuredModelIds(provider: string): string[] {
  const prefix = `${provider}/`;

  return [...MEASURED.keys()].flatMap((id) => id.startsWith(prefix) ? [id.slice(prefix.length)] : []);
}

export function withMeasuredCapability<TApi extends Api>(model: Model<TApi>): Model<TApi> {
  if ("codexCatalogCapability" in model && model.codexCatalogCapability === true) return model;
  const measured = MEASURED.get(key(model));

  if (measured?.reasoning === undefined || !measured.input) return model;
  const resolved: Model<TApi> = { ...model, reasoning: measured.reasoning, thinkingLevelMap: measured.thinkingLevelMap, input: measured.input };

  if (measured.systemRole && model.api === "openai-completions") {
    resolved.compat = { ...model.compat, supportsDeveloperRole: false } as Model<TApi>["compat"];
  }

  return resolved;
}

export function unlistedModel(provider: string, id: string, siblings: readonly Model<Api>[]): Model<Api> | undefined {
  const named = MEASURED.get(`${provider}/${id}`)?.template;

  const template = (named ? siblings.find(model => model.id === named) : undefined)
    ?? siblings.find(model => model.api === "openai-completions") ?? siblings[0];

  if (!template) return undefined;
  const { thinkingLevelMap: _inherited, ...transport } = template;

  const measured = MEASURED.get(`${provider}/${id}`);

  return withMeasuredCapability({
    ...transport, id, name: id, reasoning: false, input: ["text"],
    contextWindow: measured?.contextWindow ?? template.contextWindow,
    maxTokens: measured?.contextWindow ? template.maxTokens : Math.min(template.maxTokens, 32_768),
  });
}

export function firstEventTimeout(model: Pick<Model<Api>, "provider" | "id">): number | undefined {
  return MEASURED.get(key(model))?.firstEventMs ?? (model.provider === "openai-codex" ? 30_000 : undefined);
}

export function hedgeAfter(model: Pick<Model<Api>, "provider" | "id">): number | undefined {
  return MEASURED.get(key(model))?.hedgeMs;
}

interface ThinkingProfile {
  levels: ModelThinkingLevel[];
  canDisable: boolean;
  image: boolean;
  start?: ModelThinkingLevel;
}

export function thinkingProfile(model: Model<Api>): ThinkingProfile {
  const resolved = withMeasuredCapability(model);
  const supported = getSupportedThinkingLevels(resolved);
  const distinct = supported.filter(level => {
    const mapped = resolved.thinkingLevelMap?.[level];
    return !(typeof mapped === 'string' && mapped !== level && supported.some(other => other === mapped));
  });
  const levels = distinct.length ? distinct : ["off" as const];
  const start = MEASURED.get(key(model))?.start;
  return { levels, canDisable: levels.includes("off"), image: (resolved.input ?? []).includes("image"), start: start && levels.includes(start) ? start : undefined };
}

const PROVIDER_CONCURRENCY = new Map<string, number>([
  ["kimi-coding", 1],
]);

export function providerConcurrency(provider: string): number | undefined {
  return PROVIDER_CONCURRENCY.get(provider);
}
