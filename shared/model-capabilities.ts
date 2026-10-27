/**
 * 模型能力的唯一来源：支持哪些思考档、最低档、能否关闭思考、能否收图。
 *
 * 用 pi-ai 模型对象自带的三个字段表达（`reasoning`、`thinkingLevelMap`、`input`），不另造一套词：
 * - 目录（pi-ai 内置模型表）有的模型照目录；
 * - 目录缺失或与实测不符的模型，在 MEASURED 里按「服务商/模型 id」精确登记实测结果；
 * - 两边都没有的模型按保守默认：不发思考参数（由服务商自己决定）、只收文字。不按名字猜。
 * 扩展注册模型、主任务定档、后台判断取档都只从这里读。
 */
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";

interface MeasuredCapability {
  /** reasoning 与 input 一起登记；两项都不写的条目只登记时间，能力照目录。 */
  reasoning?: boolean;
  /** null = 该档不可用；off: null = 不能关闭思考。 */
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ("text" | "image")[];
  /** 系统提示词必须用 system 角色：开了 reasoning 后适配层默认改发 developer 角色，有的服务商会忽略它。 */
  systemRole?: true;
  /** 目录里没有的模型：从同服务商的这个模型复制连接参数（地址、协议、兼容项）。 */
  template?: string;
  /** 目录里没有的模型：上下文窗口（token）；不写则沿用 template 的。 */
  contextWindow?: number;
  /** 主任务起始档；不写则用中档。 */
  start?: ModelThinkingLevel;
  /** 连上后最多等多久出第一个事件，超过算挂起；不写则用主循环默认值。 */
  firstEventMs?: number;
  /**
   * 发出后这么久还没有第一个事件，就再发一份相同的请求，先出事件的那份胜出（对冲请求）。
   * 取该模型首字耗时 p90 左右：更早会给大多数正常请求白发一份，更晚就省不下等待。不写则用主循环默认值；0 表示不对冲。
   */
  hedgeMs?: number;
}

/** */
const MEASURED = new Map<string, MeasuredCapability>([
  // ChatGPT 账号的 gpt-6 系列；pi-ai 1.0.4 目录已收录，上下文与连接参数取目录。
  // 起始档用低档（默认低，难的事由升档信号或用户自己调高）。订会议室真实路径各 12 次：
  // 高 12/12 中位 25 秒，中 11/12（一次没订却说订好了）21 秒，低 11/12（一次如实说没提交）22 秒，关 8/12 21 秒。
  // 首个事件等 30 秒：服务端偶尔排队，16–17 秒才出第一个事件、随后正常答完；15 秒会误判挂起重来。
  // gpt-6.1-sol 不能关闭思考：发 none 回「'none' is not supported … Supported values are: 'low', …」，最低 low。
  ...(["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol"] as const).map((id): [string, MeasuredCapability] => [
    `openai-codex/${id}`,
    {
      reasoning: true, input: ["text", "image"], start: "low", firstEventMs: 30_000,
      ...(id === "gpt-6-luna" ? { hedgeMs: 6_000 } : id === "gpt-6.1-sol" ? { hedgeMs: 8_000 } : {}),
      thinkingLevelMap: id === "gpt-6.1-sol" ? { off: null, minimal: null, xhigh: "xhigh", max: "max" } : { xhigh: "xhigh", max: "max", minimal: "low" },
    },
  ]),
  // 不发档位时适配层发「关闭思考」，服务端 400「requires adaptive thinking」；low 起可用，最高 max；能看图。
  ["minimax-cn/MiniMax-M3.1-Flash-Preview", {
    template: "MiniMax-M3", reasoning: true, input: ["text", "image"], hedgeMs: 12_000,
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  }],
  // reasoning_effort=minimal 回 400「Invalid request parameters」；none/low/medium 可用。看图未测。
  ["opencode-go/mimo-v2.6-flash", { reasoning: true, input: ["text"], thinkingLevelMap: { minimal: null } }],
  // Command Code 的 reasoning_effort 只收 low–max：none、minimal 回 400，off 回「does not support reasoning off」。
  // low 出字最快（约 3.5 秒，medium 7.5 秒、high 17 秒），所以起始档用低档；能看图（蓝色图答对）。
  ["commandcode/xiaomi/mimo-v2.6-flash", { reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: null }, start: "low" }],
  // 始终思考，接受 reasoning_effort minimal–high；developer 角色里的指令被忽略、直接和用户聊天，system 角色正常；能看图。
  ["stepfun/step-3.7-flash", { reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null }, systemRole: true }],
  // 能看图（同一张图实测答对）。reasoning_effort 接受 low / medium / high，low 出字最快（2.7 秒，中档 6.0 秒），
  // 所以起始档用低档；developer 角色里「只回 JSON」5 次全被忽略，system 角色 5 次全守。
  ["stepfun/step-5-preview", { reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: null }, systemRole: true, start: "low", hedgeMs: 11_000 }],
  // 用户定：取代 step-3.5-flash（旧的发图回 400，档位不起作用）。文档只写 low / high；developer 角色里「只回 JSON」被忽略，所以用 system 角色。
  // 看图未测，按保守默认只收文字。
  ["stepfun/step-3.5-flash-2603", { reasoning: true, input: ["text"], thinkingLevelMap: { off: null, minimal: null, medium: null }, systemRole: true }],
  // Kimi 编程套餐同一时间只允许 1 个请求（同时发 2 个必有 1 个被拒 concurrent request limit），对冲那份必然被拒，所以不对冲。
  ...(["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"] as const).map((id): [string, MeasuredCapability] => [`kimi-coding/${id}`, { hedgeMs: 0 }]),
]);

const key = (model: Pick<Model<Api>, "provider" | "id">) => `${model.provider}/${model.id}`;

/** 某服务商在实测登记里有的模型 id：设置页把它们与目录合并列出（目录滞后时仍能选到）。 */
export function measuredModelIds(provider: string): string[] {
  const prefix = `${provider}/`;

  return [...MEASURED.keys()].flatMap((id) => id.startsWith(prefix) ? [id.slice(prefix.length)] : []);
}

/** 把实测登记覆盖到模型对象上；没有登记的原样返回。可重复调用。 */
export function withMeasuredCapability<TApi extends Api>(model: Model<TApi>): Model<TApi> {
  if ("codexCatalogCapability" in model && model.codexCatalogCapability === true) return model;
  const measured = MEASURED.get(key(model));

  if (measured?.reasoning === undefined || !measured.input) return model;
  const resolved: Model<TApi> = { ...model, reasoning: measured.reasoning, thinkingLevelMap: measured.thinkingLevelMap, input: measured.input };

  if (measured.systemRole && model.api === "openai-completions") {
    // SAFETY: supportsDeveloperRole 是 OpenAI 兼容协议的兼容项，上面已确认是该协议的模型。
    resolved.compat = { ...model.compat, supportsDeveloperRole: false } as Model<TApi>["compat"];
  }

  return resolved;
}

/**
 * 目录里没有的模型：连接参数取自同服务商的模型（登记了 template 的用它，否则优先 OpenAI 兼容的那个），
 * 能力取实测登记；没有登记就是保守默认。找不到同服务商模型时返回 undefined。
 */
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

/** 实测登记的首个事件等待上限；没有登记为 undefined。 */
export function firstEventTimeout(model: Pick<Model<Api>, "provider" | "id">): number | undefined {
  return MEASURED.get(key(model))?.firstEventMs;
}

/** 实测登记的对冲时间点；没有登记为 undefined。 */
export function hedgeAfter(model: Pick<Model<Api>, "provider" | "id">): number | undefined {
  return MEASURED.get(key(model))?.hedgeMs;
}

interface ThinkingProfile {
  /** 可请求的档位，从低到高；"off" 表示不发思考参数（目录标为不支持思考的模型只有这一档，由服务商默认）。 */
  levels: ModelThinkingLevel[];
  /** levels 里有 "off"。 */
  canDisable: boolean;
  image: boolean;
  /** 实测登记的主任务起始档；没有登记为 undefined。 */
  start?: ModelThinkingLevel;
}

export function thinkingProfile(model: Model<Api>): ThinkingProfile {
  const resolved = withMeasuredCapability(model);
  const supported = getSupportedThinkingLevels(resolved);
  // 两个名字映射到同一个服务端档位时，只显示真实档名，也不做一次无效升档。
  const distinct = supported.filter(level => {
    const mapped = resolved.thinkingLevelMap?.[level];
    return !(typeof mapped === 'string' && mapped !== level && supported.some(other => other === mapped));
  });
  const levels = distinct.length ? distinct : ["off" as const];
  const start = MEASURED.get(key(model))?.start;
  return { levels, canDisable: levels.includes("off"), image: (resolved.input ?? []).includes("image"), start: start && levels.includes(start) ? start : undefined };
}

/** 同一账号同时在途请求的上限，按服务商（不按模型）登记；没登记的不限。扩展内所有模型请求按它排队。 */
const PROVIDER_CONCURRENCY = new Map<string, number>([
  // 实测同时 2 个请求必有 1 个被拒（403「concurrent request limit」）。
  ["kimi-coding", 1],
]);

export function providerConcurrency(provider: string): number | undefined {
  return PROVIDER_CONCURRENCY.get(provider);
}
