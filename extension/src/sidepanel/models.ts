/**
 * 模型选择器的纯逻辑（与 DOM 解耦，可单测）：
 * - groupModelsByProvider：把 agent 下发的扁平模型列表按 provider 分组（保留首现顺序）
 * - displayName / chipLabel / filterModels / providerMark：输入区芯片与搜索菜单
 * - humanizeModelError：把模型请求失败的裸错误（如 Not Found）改写成可行动的中文提示
 */
import type { ModelOption } from "../../../shared/protocol.js";

export interface ModelGroup {
  provider: string;
  models: ModelOption[];
}

/** 按 provider 分组；组内与组间都保留输入的首现顺序（agent 侧已按目录序给出）。 */
export function groupModelsByProvider(models: readonly ModelOption[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const byProvider = new Map<string, ModelGroup>();
  for (const m of models) {
    let g = byProvider.get(m.provider);
    if (!g) {
      g = { provider: m.provider, models: [] };
      byProvider.set(m.provider, g);
      groups.push(g);
    }
    g.models.push(m);
  }
  return groups;
}

const MODEL_NOT_FOUND = /模型请求最终失败：(?:.*\b404\b.*|Not Found)/i;

/** provider id → 面板分组显示名；未收录的原样显示 id。 */
const PROVIDER_LABELS: Record<string, string> = {
  cliproxy: "本地池",
  "minimax-cn": "MiniMax",
  minimax: "MiniMax",
  "openai-codex": "Codex",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "kimi-coding": "Kimi",
  kimi: "Kimi",
  moonshot: "Kimi",
  google: "Google",
  gemini: "Google",
  xai: "xAI",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 芯片/列表用的短名：优先 SDK name，去掉 provider/ 前缀。 */
export function displayName(m: ModelOption): string {
  const raw = (m.name || m.modelId).trim();
  const slash = raw.lastIndexOf("/");
  return (slash >= 0 ? raw.slice(slash + 1) : raw) || m.modelId;
}

/** 输入区芯片文案：有列表则用展示名，否则剥掉 id 里的 provider 前缀。 */
export function chipLabel(model: string | undefined, models: readonly ModelOption[]): string {
  if (!model) return "选择模型";
  const found = models.find((m) => m.id === model);
  if (found) return displayName(found);
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export function filterModels(models: readonly ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => {
    const hay = [m.id, m.name, m.modelId, m.provider, providerLabel(m.provider), displayName(m)]
      .join("\n")
      .toLowerCase();
    return hay.includes(q);
  });
}

/** 分组字母标：取展示名首字，色相由 provider id 稳定哈希。 */
export function providerMark(provider: string): { letter: string; hue: number } {
  const label = providerLabel(provider);
  const letter = [...label][0]?.toUpperCase() ?? "?";
  let h = 0;
  for (let i = 0; i < provider.length; i++) h = (h * 31 + provider.charCodeAt(i)) >>> 0;
  return { letter, hue: h % 360 };
}

/**
 * 模型不存在/404 类错误改为人话；其他错误原文返回。
 * agent 透传的错误形如 "模型请求最终失败：Not Found"（见 agent/src/session.ts）。
 */
export function humanizeModelError(message: string): string {
  if (MODEL_NOT_FOUND.test(message)) {
    return "模型不可用（Not Found）：模型可能已下线或当前账号无访问权限，请在输入区切换模型后重试";
  }
  return message;
}

export type ReasoningTier = "native" | "effort" | "direct";

export interface ModelReasoningMeta {
  tier: ReasoningTier;
  tag: string;
}

/**
 * 识别真实模型的思考能力机制（与真实后端严格对齐）：
 * - native: 原生内置深度思考（如 MiniMax-M3、Thinking 衍生模型，不可外部调档）
 * - effort: 支持档位调节（如 OpenAI o1/o3/gpt-5.6）
 * - direct: 标准极速直接响应（无思考链延迟，如 Kimi Coding、标准 Flash）
 */
export function modelReasoningMeta(provider: string, modelId: string): ModelReasoningMeta {
  const p = (provider || "").toLowerCase();
  const m = (modelId || "").toLowerCase();

  // 1. OpenAI 系列推理模型（支持 effort 档位调节）
  if (
    p === "openai" ||
    p === "openai-codex" ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("gpt-5.6") ||
    m.includes("gpt-5.6")
  ) {
    return { tier: "effort", tag: "支持档位调节" };
  }

  // 2. MiniMax 原生内置深度思考
  if (p === "minimax-cn" || p === "minimax" || m.includes("minimax")) {
    return { tier: "native", tag: "内置深度思考" };
  }

  // 3. 含 thinking 关键字或指定高推理模型
  if (
    m.includes("thinking") ||
    m.includes("flash-high") ||
    m.includes("pro-low")
  ) {
    return { tier: "native", tag: "内置深度思考" };
  }

  // 4. 其余默认为极速直接响应（如 Kimi Coding、Gemini Flash、Claude Sonnet）
  return { tier: "direct", tag: "极速直接响应" };
}
