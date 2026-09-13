/**
 * team 视图与产生它的任务 run 的身份关联。
 *
 * 同一会话里任务 A 中止后立刻开始任务 B 时，A 的 team（phase=aborted）属于旧 run：
 * 若不按 runId 隔离，它会盖住 B 的运行状态（接管/中止按钮消失、末尾显示"已中止"）。
 * 这里只放纯判定，sidepanel / background / 测试共用同一套规则。
 */
import type { TeamView } from "../../../shared/protocol.js";

export interface TeamRunState {
  team: TeamView | null;
  /** 产生 team 的 run id；null 表示来源没有携带身份（旧路径 / 本地广播）。 */
  runId: string | null;
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function emptyTeamRun(): TeamRunState {
  return { team: null, runId: null };
}

/** 两个 run 身份是否冲突：都已知且不同。只知一边时不能判定，避免误清。 */
export function conflictingRuns(a: string | null | undefined, b: string | null | undefined): boolean {
  return isRunId(a) && isRunId(b) && a !== b;
}

/**
 * 新的 run 开始（agent_start 携带 runId）时更新绑定：
 * - 不同 run：丢掉旧 team，只留新 run 身份，避免旧"已中止"盖住新任务。
 *   同一个 run 因交还触发的 agent_start（runId 不变）必须保留 team。
 * - 只知旧身份、新 run 未带身份：不动（无 runId 兼容）。
 * - 旧身份未知但已有 team：采用新身份，但不据此清掉 team（无法证明它属于别的 run）。
 */
export function observeRunStarted(state: TeamRunState, runId: string | null | undefined): TeamRunState {
  if (!isRunId(runId)) return state;
  if (state.runId === runId) return state;
  if (isRunId(state.runId)) return { team: null, runId };
  return { team: state.team, runId };
}

export interface TeamStatusDecision {
  accept: boolean;
  state: TeamRunState;
}

/**
 * 收到 team_status 时的判定：
 * - 携带 runId 且与已绑定 run 冲突 → 丢弃（旧 run 的晚到状态不覆盖当前 run）。
 * - 携带 runId 且一致（或当前没有绑定）→ 接受并绑定该 run。
 * - 没有 runId → 接受，沿用已有绑定（旧路径兼容）。
 */
export function acceptTeamStatus(
  state: TeamRunState,
  team: TeamView,
  runId: string | null | undefined,
  historical = false,
): TeamStatusDecision {
  // 旧版本存的无身份历史只用于展示，不重新施加到已知的新任务控制状态。
  if (historical && isRunId(state.runId) && !isRunId(runId)) return {accept:false, state};
  if (isRunId(runId)) {
    if (conflictingRuns(runId, state.runId)) return { accept: false, state };
    return { accept: true, state: { team, runId } };
  }
  return { accept: true, state: { team, runId: state.runId } };
}

/**
 * 面板重开同步 / 后台回放：已绑定的 team 是否已经不属于当前 run。
 * 身份未知（无 runId）时无法判定，按"不算过期"处理，保证旧路径仍能显示。
 */
export function staleTeamForRun(state: TeamRunState, currentRunId: string | null | undefined): boolean {
  if (!state.team) return false;
  return conflictingRuns(state.runId, currentRunId);
}
