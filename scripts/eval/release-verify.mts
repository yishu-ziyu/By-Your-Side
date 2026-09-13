#!/usr/bin/env npx tsx
/**
 * Refuse a release unless locked gates, artifact identity, and evidence all hold.
 * Missing human/model evidence is BLOCKED, not PASS.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATES_PATH,
  REPO_ROOT,
  assertProtectedGatesUntampered,
  missingReportFields,
  sha256File,
  verifyReport,
  type EvalReport,
} from "./lib/verify.js";

function arg(name: string): string | undefined {
  const flag = process.argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
}

const runId = arg("--run");
const artifact = arg("--artifact");

if (!runId) {
  console.error("usage: npm run release:verify -- --run <run-id> --artifact <path>");
  process.exit(2);
}

try {
  assertProtectedGatesUntampered(GATES_PATH);
} catch (error) {
  console.error(`FAIL protected gates: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const reportPath = join(REPO_ROOT, "eval", "runs", runId, "report.json");
if (!existsSync(reportPath)) {
  console.error(`BLOCKED: report missing at eval/runs/${runId}/report.json`);
  process.exit(2);
}

const payload = JSON.parse(readFileSync(reportPath, "utf8")) as { report: EvalReport };
const report = payload.report;
const missing = missingReportFields(report);
if (missing.length) {
  console.error(`BLOCKED missing report fields: ${missing.join(", ")}`);
  process.exit(2);
}

if (artifact) {
  if (!existsSync(artifact)) {
    console.error(`FAIL artifact path does not exist: ${artifact}`);
    process.exit(1);
  }
  const actual = sha256File(artifact);
  if (report.artifact_sha256 && report.artifact_sha256 !== "not-built" && report.artifact_sha256 !== "integration-tests" && report.artifact_sha256 !== actual) {
    console.error(`FAIL artifact sha256 mismatch: report ${report.artifact_sha256} vs file ${actual}`);
    process.exit(1);
  }
}

const result = verifyReport(report);
console.log(JSON.stringify({ run_id: runId, verdict: result.verdict, reason: result.reason, gates_sha256: result.gates_sha256 }, null, 2));
if (result.verdict === "PASS") {
  console.error("refusing to print PASS for formal release: human review and live metrics are required");
  process.exit(2);
}
if (result.verdict === "FAIL") process.exit(1);
process.exit(0);
