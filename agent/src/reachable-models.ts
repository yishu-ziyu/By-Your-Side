import type { ModelOption } from "../../shared/protocol.js";

/**
 * 默认精选集：选择器默认只显示这些，其余模型仍可达，靠 UI 的「显示全部」展开。
 *
 * 2026-09-23 用户重新裁定为四项：阶跃星辰 Step 5，加三个入口的小米 MiMo V2.6 Flash。
 * 2026-09-10 用户曾裁到五个（MiniMax M3 / Grok 4.6 / MiMo V2.5 / V2.5 Pro /
 * OpenCode Go DeepSeek Flash），2026-09-22 增补 MiMo V2.6 Flash 并设为默认；
 * 那批已从默认集移除，但没有从可达集删除——「不在默认集」和「不可达」是两件事。
 *
 * 三个 MiMo V2.6 Flash 入口都保留，是因为用户明确要求都能自己挑：
 * - cliproxy：本地 CLIProxyAPI 池路由（当前 ~/.sideagent/config.json 默认值）
 * - commandcode：Command Code 池
 * - opencode-go：SDK 内置 provider 直连上游
 * 注：历史注释曾记录 opencode-go 直连 v2.6-flash 被上游 400 拒绝、故必须走本地池；
 * 该结论写于 models.json 注册 v2.6-flash 之前，现已过期，不要据此剔除，以实测为准。
 */
export const FEATURED_MODEL_IDS = new Set<string>([
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
