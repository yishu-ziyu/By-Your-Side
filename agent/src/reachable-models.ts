import type { ModelOption } from "../../shared/protocol.js";

const FEATURED_MODEL_IDS = new Set<string>([
  "step-plan/step-5-preview",
  "cliproxy/mimo-v2.6-flash",
  "commandcode/xiaomi/mimo-v2.6-flash",
  "opencode-go/mimo-v2.6-flash",
]);

export function annotateReachableModels(
  models: readonly ModelOption[],
  current?: string | null,
): ModelOption[] {
  const featured = new Set(FEATURED_MODEL_IDS);

  if (current != null) featured.add(current);

  return models.map((model) => ({ ...model, featured: featured.has(model.id) }));
}
