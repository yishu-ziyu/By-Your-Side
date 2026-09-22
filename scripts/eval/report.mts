#!/usr/bin/env npx tsx
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, verifyReport, type EvalReport } from "./lib/verify.js";

const run = (process.argv.find((a) => a.startsWith("--run=")) ?? "").slice("--run=".length);

if (!run) {
  console.error("usage: npm run eval:report -- --run <run-id>");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(join(REPO_ROOT, "eval", "runs", run, "report.json"), "utf8")) as { report: EvalReport };

const result = verifyReport(raw.report);

console.log(JSON.stringify(result, null, 2));

if (result.verdict === "FAIL") process.exit(1);
