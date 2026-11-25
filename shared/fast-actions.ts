import type { PageTransformAction, SelectorFieldSpec } from "./page-phase2.js";

export type FastActionPayload =
  | { kind: "page_transform"; actions: PageTransformAction[] }
  | { kind: "selector_extract"; fields: SelectorFieldSpec[] };

export interface LocalFastAction {
  id: string;
  site: string;
  name: string;
  payload: FastActionPayload;
  runCount: number;
  lastUsedAt: number;
}

export interface FastActionRunResult {
  ok: boolean;
  elapsedMs: number;
  summary: string;
  data?: Record<string, string>;
}

export function rankFastActionsForSite(actions: readonly LocalFastAction[], site: string, limit = 4): LocalFastAction[] {
  return actions
    .filter((action) => action.site === site)
    .sort((a, b) => (b.runCount - a.runCount) || (b.lastUsedAt - a.lastUsedAt))
    .slice(0, limit);
}

export function recordFastActionUse(
  actions: readonly LocalFastAction[],
  actionId: string,
  now: number = Date.now(),
): LocalFastAction[] {
  return actions.map((action) =>
    action.id === actionId
      ? { ...action, runCount: action.runCount + 1, lastUsedAt: now }
      : action,
  );
}
