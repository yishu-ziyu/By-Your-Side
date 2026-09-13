#!/usr/bin/env npx tsx
/**
 * Installation / environment doctor. Never prints keys or raw recordings.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./lib/verify.js";

type Check = { name: string; ok: boolean; detail: string; blocked?: boolean };

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function present(path: string): boolean {
  return existsSync(path);
}

const checks: Check[] = [];
const node = process.version;
checks.push({ name: "node", ok: Number(node.slice(1).split(".")[0]) >= 20, detail: node });

const os = `${process.platform} ${run("sw_vers -productVersion") || process.arch}`.trim();
checks.push({ name: "os", ok: process.platform === "darwin", detail: os, blocked: process.platform !== "darwin" });

const cpu = run("sysctl -n machdep.cpu.brand_string") || process.arch;
const ramGiB = Number(run("sysctl -n hw.memsize") || 0) / 1024 ** 3;
checks.push({ name: "reference_machine", ok: true, detail: `${cpu}; ram_gib=${ramGiB.toFixed(1)}` });

const sha = run("git rev-parse HEAD");
const dirty = run("git status --porcelain");
checks.push({ name: "git", ok: Boolean(sha), detail: `${sha}${dirty ? " dirty" : " clean"}` });

const chrome = run(`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version`);
checks.push({ name: "chrome", ok: Boolean(chrome), detail: chrome || "not found", blocked: !chrome });

const hostManifest = join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sideagent.host.json");
let hostDetail = "missing";
if (present(hostManifest)) {
  try {
    const json = JSON.parse(readFileSync(hostManifest, "utf8")) as { name?: string; path?: string; allowed_origins?: string[] };
    hostDetail = `name=${json.name ?? "?"} origins=${json.allowed_origins?.length ?? 0} path=${json.path ? "set" : "missing"}`;
    checks.push({ name: "native_host", ok: json.name === "com.sideagent.host" && Array.isArray(json.allowed_origins) && json.allowed_origins.length > 0, detail: hostDetail });
  } catch (error) {
    checks.push({ name: "native_host", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
} else {
  checks.push({ name: "native_host", ok: false, detail: "not installed (npm run install:host)", blocked: true });
}

const dist = join(REPO_ROOT, "extension", "dist", "manifest.json");
checks.push({ name: "extension_build", ok: present(dist), detail: present(dist) ? "extension/dist present" : "run npm run build", blocked: !present(dist) });

const piAuth = present(join(homedir(), ".pi", "agent", "auth.json"));
checks.push({ name: "model_credentials", ok: piAuth, detail: piAuth ? "present (not printed)" : "missing ~/.pi/agent/auth.json", blocked: !piAuth });

const sideagentConfig = present(join(homedir(), ".sideagent", "config.json"));
checks.push({ name: "sideagent_config", ok: true, detail: sideagentConfig ? "present (not printed)" : "optional ~/.sideagent/config.json missing" });

const stepKey = Boolean(process.env.STEPFUN_API_KEY || process.env.STEP_API_KEY);
checks.push({ name: "step_plan_voice", ok: true, detail: stepKey ? "env credential present (not printed)" : "STEPFUN_API_KEY not in env; may still live in ~/.pi — live audio BLOCKED until proven", blocked: !stepKey });

checks.push({ name: "microphone", ok: true, detail: "not probed (requires user gesture / OS permission UI)", blocked: true });
checks.push({ name: "github_branch_protection", ok: false, detail: "main is not protected", blocked: true });
checks.push({ name: "holdout_custodian", ok: false, detail: "no independent holdout custodian", blocked: true });
const budgetPath = process.env.SIDEAGENT_EVAL_BUDGET_FILE || join(homedir(), ".sideagent", "eval-budget.json");
let budgetOk = false;
let budgetDetail = `missing ${budgetPath}`;
if (present(budgetPath)) {
  try {
    const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as { maximum_evaluation_cost?: number; maximum_model_calls?: number; maximum_audio_minutes?: number; currency?: string };
    budgetOk = Boolean(budget.maximum_evaluation_cost && budget.maximum_model_calls && budget.maximum_audio_minutes);
    budgetDetail = budgetOk
      ? `cap ${budget.currency ?? "USD"} ${budget.maximum_evaluation_cost} / ${budget.maximum_model_calls} calls / ${budget.maximum_audio_minutes} audio-min`
      : "budget file present but incomplete";
  } catch {
    budgetDetail = "budget file unreadable (contents not printed)";
  }
}
checks.push({ name: "evaluation_budget", ok: budgetOk, detail: budgetDetail, blocked: !budgetOk });

for (const check of checks) {
  const mark = check.ok && !check.blocked ? "OK" : check.blocked ? "BLOCKED" : "FAIL";
  console.log(`${mark.padEnd(8)} ${check.name}: ${check.detail}`);
}

const failed = checks.filter((c) => !c.ok && !c.blocked);
if (failed.length) process.exit(1);
