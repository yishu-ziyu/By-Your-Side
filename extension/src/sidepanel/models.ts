import type { ModelOption } from "../../../shared/protocol.js";

interface ModelGroup {
  provider: string;
  models: ModelOption[];
}

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

const PROVIDER_LABELS: Record<string, string> = {
  custom: "自定义服务",
  cliproxy: "本机代理",
  "cli-proxy": "本机代理",
  "minimax-cn": "MiniMax",
  minimax: "MiniMax",
  "openai-codex": "ChatGPT 账号",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "kimi-coding": "Kimi",
  kimi: "Kimi",
  moonshot: "Kimi",
  google: "Google",
  gemini: "Google",
  inception: "Inception",
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

export function displayName(m: ModelOption): string {
  const raw = (m.name || m.modelId).trim();

  if (m.provider === "custom") return raw;
  const slash = raw.lastIndexOf("/");

  return (slash >= 0 ? raw.slice(slash + 1) : raw) || m.modelId;
}

export function chipLabel(model: string | undefined, models: readonly ModelOption[]): string {
  if (!model) return "选择模型";
  const found = models.find((m) => m.id === model);

  if (found) return displayName(found);
  const slash = model.lastIndexOf("/");

  return slash >= 0 ? model.slice(slash + 1) : model;
}

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
