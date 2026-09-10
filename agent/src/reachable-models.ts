import type { ModelOption } from "../../shared/protocol.js";

/**
 * 选择器放行名单。2026-09-10 用户裁到五个：MiniMax M3、Grok 4.6、
 * 小米 MiMo V2.5 / V2.5 Pro、OpenCode Go 的 DeepSeek V4.1 Flash。
 * 本地 CLIProxyAPI 池（cli-proxy / cliproxy）、MiniMax M2.7 系列和 Grok 4.3 / 4.5
 * 为有意隐藏；名单外的模型连通过也不进选择器。
 */
export const REACHABLE_MODEL_IDS = new Set<string>([
  "minimax-cn/MiniMax-M3",
  "xai/grok-4.6",
  "xiaomi-token-plan-cn/mimo-v2.5-pro",
  "xiaomi-token-plan-cn/mimo-v2.5",
  "opencode-go/deepseek-flash",
]);

/** Keep catalog order. Always retain the session's current model so the user can switch away. */
export function filterReachableModels(models: readonly ModelOption[], current?: string | null): ModelOption[] {
  return models.filter((model) => REACHABLE_MODEL_IDS.has(model.id) || (current != null && model.id === current));
}
