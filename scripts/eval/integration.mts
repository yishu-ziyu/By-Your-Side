#!/usr/bin/env npx tsx
/**
 * Isolated integration eval. Headless is required. Does not connect personal Chrome.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATES_PATH, REPO_ROOT, sha256File, verifyReport, type EvalReport } from "./lib/verify.js";

if (!process.argv.includes("--headless") && !process.argv.includes("--headless=new")) {
  console.error("eval:integration refuses to run without --headless. It will not open a visible window or the daily Chrome profile.");
  process.exit(2);
}

const candidate = (process.argv.find((a) => a.startsWith("--candidate=")) ?? "--candidate=WORKTREE").slice("--candidate=".length);
const runId = `integration-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outDir = join(REPO_ROOT, "eval", "runs", runId);
mkdirSync(outDir, { recursive: true });

const tests = spawnSync("npx", ["vitest", "run", "agent/test/effect-policy.test.ts", "agent/test/consent-ticket.test.ts", "agent/test/eval-gates.test.ts", "extension/test/fetch-guard.test.ts", "extension/test/fetch-effect-policy.test.ts"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});
writeFileSync(join(outDir, "integration.log"), `${tests.stdout}\n${tests.stderr}`);

const report: EvalReport = {
  candidate_sha: candidate,
  baseline_sha: "176e23fd103497e522c5fc0428af2c559733e6c8",
  dirty_tree_flag: true,
  lockfile_sha256: sha256File(join(REPO_ROOT, "package-lock.json")),
  artifact_sha256: "integration-tests",
  evaluation_revision: sha256File(GATES_PATH),
  dataset_manifest_sha256: sha256File(join(REPO_ROOT, "eval", "samples", "dev-manifest.json")),
  profile: "integration-headless",
  run_id: runId,
  started_at: new Date().toISOString(),
  gates_sha256: sha256File(GATES_PATH),
  observations: [],
  absolute_checks: {
    effect_policy_covers_fetch_pages_raw_js_and_nested_program_actions: tests.status === 0 ? "PASS" : "FAIL",
    fetch_incremental_read_cancel_deadline_and_utf8_tests_pass: tests.status === 0 ? "PASS" : "FAIL",
    consent_ticket_scope_expiry_and_one_time_consumption_pass: tests.status === 0 ? "PASS" : "FAIL",
    diagnostic_capture_requires_separate_explicit_consent: tests.status === 0 ? "PASS" : "FAIL",
    native_full_user_entry_path_pass: { verdict: "BLOCKED", reason: "integration is tool_integration / ui_mock, not native e2e" },
    human_review_signed_with_no_unresolved_release_blocker: { verdict: "BLOCKED", reason: "no human review" },
    evaluation_policy_and_oracle_are_independently_protected: { verdict: "BLOCKED", reason: "GitHub main unprotected" },
  },
  human_review: { signed: false },
};
const result = verifyReport(report);
writeFileSync(join(outDir, "report.json"), JSON.stringify({ report, result, measurement_mode: "tool_integration" }, null, 2));
console.log(`run_id=${runId} measurement_mode=tool_integration verify=${result.verdict}`);
if (tests.status !== 0) process.exit(1);
