import type { ModelOption } from "../../shared/protocol.js";

/**
 * Temporary picker allowlist from the 2026-09-09 live probe (plus Xiaomi Token Plan
 * after the new key answered). Models not in this set stay hidden until they connect.
 */
export const REACHABLE_MODEL_IDS = new Set<string>([
  "minimax-cn/MiniMax-M2.7",
  "minimax-cn/MiniMax-M2.7-highspeed",
  "minimax-cn/MiniMax-M3",
  "xai/grok-4.3",
  "xai/grok-4.5",
  "xai/grok-4.6",
  "cliproxy/grok-3-mini",
  "cliproxy/grok-4.3",
  "cliproxy/grok-4.5",
  "cliproxy/grok-4.6",
  "cliproxy/grok-build-0.1",
  "cliproxy/gemini-3-flash",
  "cliproxy/gemini-3.1-flash-lite",
  "cliproxy/gemini-3.1-pro-low",
  "cliproxy/gemini-3.7-flash-high",
  "cliproxy/gemini-3.8-flash-high",
  "cliproxy/claude-sonnet-4-6",
  "cliproxy/claude-opus-4-6-thinking",
  "cli-proxy/gpt-oss-120b-medium",
  "cli-proxy/claude-sonnet-4-6",
  "cli-proxy/claude-opus-4-6-thinking",
  "cli-proxy/gemini-3.6-flash-high",
  "cli-proxy/gemini-3.8-flash-high",
  "xiaomi-token-plan-cn/mimo-v2.5-pro",
  "xiaomi-token-plan-cn/mimo-v2.5",
]);

/** Keep catalog order. Always retain the session's current model so the user can switch away. */
export function filterReachableModels(models: readonly ModelOption[], current?: string | null): ModelOption[] {
  return models.filter((model) => REACHABLE_MODEL_IDS.has(model.id) || (current != null && model.id === current));
}
