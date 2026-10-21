import type { ModelOption } from "../../shared/protocol.js";

/**
 * 默认精选集：选择器默认只显示这些，其余模型仍可达，靠 UI 的「显示全部」展开。
 * 用户定的四项：阶跃星辰 Step 5，加三个入口的小米 MiMo V2.6 Flash。
 * 「不在默认集」和「不可达」是两件事：默认集外的模型仍可达。
 *
 * 三个 MiMo V2.6 Flash 入口都保留，是因为用户明确要求都能自己挑：
 * - cliproxy：本地 CLIProxyAPI 池路由（当前 ~/.sideagent/config.json 默认值）
 * - commandcode：Command Code 池
 * - opencode-go：SDK 内置 provider 直连上游
 */
const FEATURED_MODEL_IDS = new Set<string>([
  "step-plan/step-5-preview",
  "cliproxy/mimo-v2.6-flash",
  "commandcode/xiaomi/mimo-v2.6-flash",
  "opencode-go/mimo-v2.6-flash",
]);

/**
 * 给全量可达列表打 featured 标记：agent 侧下发全量，UI 默认只显示精选、可展开看全部。
 * 单一来源——过滤只发生在 UI，agent 不再替用户删模型。
 * 当前会话模型一律标记 featured：否则用户切到一个非精选模型后，它会从默认视图里消失，再也切不回去。
 */
export function annotateReachableModels(
  models: readonly ModelOption[],
  current?: string | null,
): ModelOption[] {
  const featured = new Set(FEATURED_MODEL_IDS);

  if (current != null) featured.add(current);

  return models.map((model) => ({ ...model, featured: featured.has(model.id) }));
}
