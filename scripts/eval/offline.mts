#!/usr/bin/env npx tsx
/**
 * L0 offline eval: unit tests + verifier self-checks. No Chrome, no model.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATES_PATH, REPO_ROOT, loadGates, sha256File, verifyReport, type EvalReport } from "./lib/verify.js";

function arg(name: string): string | undefined {
  const flag = process.argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
}

const candidate = arg("--candidate") ?? "WORKTREE";
const runId = `offline-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outDir = join(REPO_ROOT, "eval", "runs", runId);
mkdirSync(outDir, { recursive: true });

const tests = spawnSync("npm", ["test"], { cwd: REPO_ROOT, encoding: "utf8" });
writeFileSync(join(outDir, "npm-test.log"), `${tests.stdout}\n${tests.stderr}`);
const typecheck = spawnSync("npm", ["run", "typecheck"], { cwd: REPO_ROOT, encoding: "utf8" });
writeFileSync(join(outDir, "typecheck.log"), `${typecheck.stdout}\n${typecheck.stderr}`);

const report: EvalReport = {
  candidate_sha: candidate,
  baseline_sha: loadGates().review_baseline_sha,
  dirty_tree_flag: true,
  lockfile_sha256: sha256File(join(REPO_ROOT, "package-lock.json")),
  artifact_sha256: "not-built",
  evaluation_revision: sha256File(GATES_PATH),
  dataset_manifest_sha256: sha256File(join(REPO_ROOT, "eval", "samples", "dev-manifest.json")),
  profile: "offline",
  run_id: runId,
  started_at: new Date().toISOString(),
  gates_sha256: sha256File(GATES_PATH),
  observations: loadGates().metrics.map((m) => ({
    id: m.id,
    missing: true,
    blocked_reason: "offline run does not measure live metrics",
  })),
  absolute_checks: {
    typecheck_pass: typecheck.status === 0 ? "PASS" : "FAIL",
    all_applicable_unit_tests_pass_no_critical_skips: tests.status === 0 ? "PASS" : "FAIL",
    production_build_pass: { verdict: "BLOCKED", reason: "offline profile does not build unless asked" },
    human_review_signed_with_no_unresolved_release_blocker: { verdict: "BLOCKED", reason: "no human review" },
    evaluation_policy_and_oracle_are_independently_protected: { verdict: "BLOCKED", reason: "GitHub main unprotected; no CODEOWNERS" },
    native_full_user_entry_path_pass: { verdict: "BLOCKED", reason: "offline" },
  },
  human_review: { signed: false },
};

const result = verifyReport(report);
writeFileSync(join(outDir, "report.json"), JSON.stringify({ report, result }, null, 2));
console.log(`run_id=${runId}`);
console.log(`npm test exit=${tests.status}`);
console.log(`typecheck exit=${typecheck.status}`);
console.log(`verify=${result.verdict} ${result.reason}`);
if (tests.status !== 0 || typecheck.status !== 0 || result.verdict === "FAIL") process.exit(1);
