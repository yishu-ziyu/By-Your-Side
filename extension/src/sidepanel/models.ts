/**
 * 模型选择器的纯逻辑（与 DOM 解耦，可单测）：
 * - groupModelsByProvider：把 agent 下发的扁平模型列表按 provider 分组（保留首现顺序）
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
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * 模型不存在/404 类错误改为人话；其他错误原文返回。
 * agent 透传的错误形如 "模型请求最终失败：Not Found"（见 agent/src/session.ts）。
 */
export function humanizeModelError(message: string): string {
  if (MODEL_NOT_FOUND.test(message)) {
    return "模型不可用（Not Found）：模型可能已下线或当前账号无访问权限，请在顶栏切换模型后重试";
  }
  return message;
}
