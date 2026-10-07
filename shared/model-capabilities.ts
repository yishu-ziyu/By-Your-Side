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
  reasoning: boolean;
  /** null = 该档不可用；off: null = 不能关闭思考。 */
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
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
}

/** 实测记录见 docs/evals/20261001-model-effort-and-side-judgments.md。 */
const MEASURED = new Map<string, MeasuredCapability>([
  // ChatGPT 账号的 gpt-6 系列（2026-10-06 实测）；pi-ai 1.0.4 目录已收录，上下文与连接参数取目录。
  // 起始档用低档（用户 10-07 定：默认低，难的事由升档信号或用户自己调高）。订会议室真实路径各 12 次：
  // 高 12/12 中位 25 秒，中 11/12（一次没订却说订好了）21 秒，低 11/12（一次如实说没提交）22 秒，关 8/12 21 秒（docs/evals/20261007-effort-low.md）。
  // 更早的 10-06 两道核对题（高 7/8、中 0/7、低 2/6）只测判断题，不是浏览器操作。
  // 首个事件等 30 秒：服务端偶尔排队，10-06 实测 12 次有 2 次 16–17 秒才出第一个事件、随后正常答完；15 秒会误判挂起重来。
  ...(["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol"] as const).map((id): [string, MeasuredCapability] => [
    `openai-codex/${id}`,
    { reasoning: true, input: ["text", "image"], thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" }, start: "low", firstEventMs: 30_000 },
  ]),
  // 不发档位时适配层发「关闭思考」，服务端 400「requires adaptive thinking」；low 起可用，最高 max；能看图。
  ["minimax-cn/MiniMax-M3.1-Flash-Preview", {
    template: "MiniMax-M3", reasoning: true, input: ["text", "image"],
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  }],
  // reasoning_effort=minimal 回 400「Invalid request parameters」；none/low/medium 可用。看图未测。
  ["opencode-go/mimo-v2.6-flash", { reasoning: true, input: ["text"], thinkingLevelMap: { minimal: null } }],
  // 始终思考，接受 reasoning_effort minimal–high；developer 角色里的指令被忽略、直接和用户聊天，system 角色正常；能看图。
  ["stepfun/step-3.7-flash", { reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null }, systemRole: true }],
  // 能看图（同一张图实测答对）；思考参数未测，按保守默认不发。
  ["stepfun/step-5-preview", { reasoning: false, input: ["text", "image"] }],
  // 发图回 400「doesn't support image input」。
  ["stepfun/step-3.5-flash", { reasoning: false, input: ["text"] }],
]);

const key = (model: Pick<Model<Api>, "provider" | "id">) => `${model.provider}/${model.id}`;

/** 某服务商在实测登记里有的模型 id：设置页把它们与目录合并列出（目录滞后时仍能选到）。 */
export function measuredModelIds(provider: string): string[] {
  const prefix = `${provider}/`;

  return [...MEASURED.keys()].flatMap((id) => id.startsWith(prefix) ? [id.slice(prefix.length)] : []);
}

/** 把实测登记覆盖到模型对象上；没有登记的原样返回。可重复调用。 */
export function withMeasuredCapability<TApi extends Api>(model: Model<TApi>): Model<TApi> {
  const measured = MEASURED.get(key(model));

  if (!measured) return model;
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

export interface ThinkingProfile {
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
  const levels = supported.length ? supported : ["off" as const];

  return { levels, canDisable: levels.includes("off"), image: (resolved.input ?? []).includes("image"), start: MEASURED.get(key(model))?.start };
}
