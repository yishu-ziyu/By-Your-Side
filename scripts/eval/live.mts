#!/usr/bin/env npx tsx
/**
 * Live eval. Requires an explicit budget file. Missing budget/credentials/hardware → BLOCKED, not PASS.
 */
import { existsSync } from "node:fs";
import { verifyReport, loadGates, type EvalReport } from "./lib/verify.js";
import { DEFAULT_BUDGET_FILE, loadBudget, loadSpend, remaining } from "./lib/budget.js";

function arg(name: string): string | undefined {
  const flag = process.argv.find((a) => a.startsWith(`${name}=`));

  return flag ? flag.slice(name.length + 1) : undefined;
}

const budgetFile = arg("--budget-file") ?? DEFAULT_BUDGET_FILE;

const profile = arg("--profile") ?? "reference-macos";

if (!existsSync(budgetFile)) {
  console.error("eval:live BLOCKED: missing --budget-file. Offline/integration work may continue; paid loops will not start.");

  const report: EvalReport = {
    profile,
    run_id: "live-blocked-no-budget",
    started_at: new Date().toISOString(),
    observations: loadGates().metrics.map((m) => ({
      id: m.id,
      missing: true,
      blocked_reason: "no evaluation budget file",
    })),
    human_review: { signed: false },
  };

  const result = verifyReport(report);
  console.log(JSON.stringify({ verdict: result.verdict, reason: result.reason }, null, 2));
  process.exit(0);
}

const budget = loadBudget(budgetFile);

const spend = loadSpend();

const left = remaining(budget, spend);

console.log(JSON.stringify({
  budget_file: budgetFile,
  currency: budget.currency,
  cap: {
    cost: budget.maximum_evaluation_cost,
    model_calls: budget.maximum_model_calls,
    audio_minutes: budget.maximum_audio_minutes,
  },
  spent: { cost: spend.cost, model_calls: spend.model_calls, audio_minutes: spend.audio_minutes },
  remaining: left,
  task_model: budget.task_model ?? null,
  profile,
}, null, 2));

if (left.cost <= 0 || left.model_calls <= 0 || left.audio_minutes <= 0) {
  console.error("eval:live stopped: budget already exhausted.");
  process.exit(0);
}

// 原 live-suite 在 Node 里直接跑任务核心（扩展外路径），2026-10-04 随扩展外路径一起删除
// （docs/evals/20261004-cut-unused.md）。真实模型的产品路径验收改走 accept:real-path；这里如实报 BLOCKED，不报 PASS。
const report: EvalReport = {
  profile,
  run_id: "live-blocked-no-suite",
  started_at: new Date().toISOString(),
  observations: loadGates().metrics.map((m) => ({
    id: m.id,
    missing: true,
    blocked_reason: "no in-extension live suite yet; the out-of-extension live suite was deleted",
  })),
  human_review: { signed: false },
};

const result = verifyReport(report);

console.log(JSON.stringify({ verdict: result.verdict, reason: result.reason }, null, 2));

process.exit(0);
