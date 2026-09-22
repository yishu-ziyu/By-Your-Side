import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BUDGET_FILE = join(homedir(), ".sideagent", "eval-budget.json");

export const DEFAULT_SPEND_FILE = join(homedir(), ".sideagent", "eval-spend.json");

export interface EvalBudget {
  currency?: string;
  maximum_evaluation_cost: number;
  maximum_model_calls: number;
  maximum_audio_minutes: number;
  task_model?: string;
}

export interface EvalSpend {
  cost: number;
  model_calls: number;
  audio_minutes: number;
  stopped_reason?: string;
  entries: Array<{ at: string; model_calls: number; audio_minutes: number; cost: number; note: string }>;
}

export function loadBudget(path = DEFAULT_BUDGET_FILE): EvalBudget {
  if (!existsSync(path)) throw new Error(`budget file missing: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as EvalBudget;

  if (!raw.maximum_evaluation_cost || !raw.maximum_model_calls || !raw.maximum_audio_minutes) {
    throw new Error("budget file missing maximum_evaluation_cost, maximum_model_calls, or maximum_audio_minutes");
  }

  return raw;
}

export function loadSpend(path = DEFAULT_SPEND_FILE): EvalSpend {
  if (!existsSync(path)) return { cost: 0, model_calls: 0, audio_minutes: 0, entries: [] };

  return JSON.parse(readFileSync(path, "utf8")) as EvalSpend;
}

export function remaining(budget: EvalBudget, spend: EvalSpend): { cost: number; model_calls: number; audio_minutes: number } {
  return {
    cost: budget.maximum_evaluation_cost - spend.cost,
    model_calls: budget.maximum_model_calls - spend.model_calls,
    audio_minutes: budget.maximum_audio_minutes - spend.audio_minutes,
  };
}

export function assertWithinBudget(budget: EvalBudget, spend: EvalSpend): void {
  const left = remaining(budget, spend);

  if (left.cost <= 0 || left.model_calls <= 0 || left.audio_minutes <= 0) {
    throw new Error(`eval budget exhausted: remaining cost=${left.cost} calls=${left.model_calls} audio_min=${left.audio_minutes}`);
  }
}

export function recordSpend(delta: { cost?: number; model_calls?: number; audio_minutes?: number; note: string }, paths?: { budget?: string; spend?: string }): EvalSpend {
  const budget = loadBudget(paths?.budget);
  const spendPath = paths?.spend ?? DEFAULT_SPEND_FILE;
  const spend = loadSpend(spendPath);
  spend.cost += delta.cost ?? 0;
  spend.model_calls += delta.model_calls ?? 0;
  spend.audio_minutes += delta.audio_minutes ?? 0;
  spend.entries.push({
    at: new Date().toISOString(),
    model_calls: delta.model_calls ?? 0,
    audio_minutes: delta.audio_minutes ?? 0,
    cost: delta.cost ?? 0,
    note: delta.note,
  });
  mkdirSync(dirname(spendPath), { recursive: true });
  writeFileSync(spendPath, `${JSON.stringify(spend, null, 2)}\n`);

  try {
    assertWithinBudget(budget, spend);
  } catch (error) {
    spend.stopped_reason = error instanceof Error ? error.message : String(error);
    writeFileSync(spendPath, `${JSON.stringify(spend, null, 2)}\n`);
    throw error;
  }

  return spend;
}
