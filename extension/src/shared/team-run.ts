import type { TeamView } from "../../../shared/protocol.js";

export interface TeamRunState {
  team: TeamView | null;
  runId: string | null;
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function emptyTeamRun(): TeamRunState {
  return { team: null, runId: null };
}

function conflictingRuns(a: string | null | undefined, b: string | null | undefined): boolean {
  return isRunId(a) && isRunId(b) && a !== b;
}

export function observeRunStarted(state: TeamRunState, runId: string | null | undefined): TeamRunState {
  if (!isRunId(runId)) return state;

  if (state.runId === runId) return state;

  if (isRunId(state.runId)) return { team: null, runId };

  return { team: state.team, runId };
}

interface TeamStatusDecision {
  accept: boolean;
  state: TeamRunState;
}

export function acceptTeamStatus(
  state: TeamRunState,
  team: TeamView,
  runId: string | null | undefined,
  historical = false,
): TeamStatusDecision {
  if (historical && isRunId(state.runId) && !isRunId(runId)) return {accept:false, state};

  if (isRunId(runId)) {
    if (conflictingRuns(runId, state.runId)) return { accept: false, state };

    return { accept: true, state: { team, runId } };
  }

  return { accept: true, state: { team, runId: state.runId } };
}
