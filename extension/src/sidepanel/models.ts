/**
 * 模型选择器的纯逻辑（与 DOM 解耦，可单测）：
 * - groupModelsByProvider：把 agent 下发的扁平模型列表按 provider 分组（保留首现顺序）
 * - displayName / chipLabel / filterModels / providerMark：输入区芯片与搜索菜单
 * - humanizeModelError：把模型请求失败的裸错误（如 Not Found）改写成可行动的中文提示
 */
import type { ModelOption } from "../../../shared/protocol.js";
import { plainModelError } from "../../../shared/user-facing.js";

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

/** provider id → 面板分组显示名；未收录的原样显示 id。 */
const PROVIDER_LABELS: Record<string, string> = {
  cliproxy: "本地池",
  "cli-proxy": "本地池",
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
  commandcode: "Command Code",
  "opencode-go": "OpenCode Go",
  "step-plan": "阶跃星辰",
  "zai-coding-cn": "智谱",
  "xiaomi-token-plan-cn": "小米 MiMo",
  deepseek: "DeepSeek",
  antigravity: "Antigravity",
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

/**
 * 过滤 + 可选「只看常用」。
 * featuredOnly=true 时只留 agent 打了 featured 标的模型（默认精选集 + 当前会话模型）；
 * agent 下发的是全量，标记缺失（旧 agent）时视为非精选，此时若结果为空会让 UI 落到「暂无可用模型」，
 * 所以调用方应在结果为空且确实没传 featured 时退回全量——由 picker 的 fallback 处理。
 */
export function filterModels(
  models: readonly ModelOption[],
  query: string,
  featuredOnly = false,
): ModelOption[] {
  const q = query.trim().toLowerCase();
  const base = featuredOnly ? models.filter((m) => m.featured === true) : [...models];

  if (!q) return base;

  return base.filter((m) => {
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
 * 模型服务的报错改成人话（状态码、原始 JSON 不上侧栏，原文留在诊断记录里）；其他错误本来就是中文说明，原样返回。
 * agent 透传的模型错误形如 "模型请求最终失败：503: {...}"（见 agent/src/session.ts）。
 */
export function humanizeModelError(message: string): string {
  return message.startsWith("模型请求最终失败：") ? plainModelError(message) : message;
}

export type ReasoningTier = "unknown" | "native" | "effort" | "direct";

export interface ModelReasoningMeta {
  tier: ReasoningTier;
  /** 展示标签；null 表示没有可信能力证据，UI 不得渲染任何能力标签。 */
  tag: string | null;
}

/**
 * 能力标签的唯一合法证据来源是已验证的 runtime/SDK/适配器元数据。
 * 当前协议（ModelOption 只有 id/provider/modelId/name）与 ClientMessage
 * 均不携带能力信息，provider/modelId 字符串推不出任何能力，
 * 因此对一切输入保守降级为无标签（issue #2 / 验收 B1–B3）。
 * 接入真实能力元数据前，不要在这里恢复任何按名称/供应商的推断。
 */
export function modelReasoningMeta(provider: string, modelId: string): ModelReasoningMeta {
  void provider;
  void modelId;

  return { tier: "unknown", tag: null };
}
