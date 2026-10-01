#!/usr/bin/env node
/**
 * BYS eval harness (extension-only: each job is a headless Chrome with only the extension; see job.mjs).
 *   node eval/harness/run.mjs --models zai-coding-cn/glm-5.3-flash,minimax-cn/MiniMax-M3.1-Flash-Preview+zai-coding-cn/glm-5.3-flash \
 *        --tasks BYS-006,BYS-008 [--concurrency 2] [--run-id X] [--cap-sec 240] [--no-judge]
 * A model spec is main[+fast], each provider/modelId; fast defaults to main.
 * Output: $BYS_RUNS_DIR (default eval/runs)/<run-id>/<model slug>/<task>.json (+ .png page+panel, -page.png, -panel.png, .trace.jsonl, .artifact.*, .dl.*)
 *         <runs>/<run-id>/judge/<model slug>/<task>.json, summary.csv
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runJob, killLive, slugOf } from "./job.mjs";
import os from "node:os";
import { judgeRun } from "./judge.mjs";
import { RUNS_DIR, TASKS_FILE } from "./paths.mjs";

export function writeSummary(runDir, results) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);

    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };

  const rows = [["task", "model", "pass", "seconds_to_first_output", "seconds_total", "n_steps", "status", "error", "judge_reason"]];

  for (const r of results.sort((a, b) => a.task.localeCompare(b.task) || a.model.localeCompare(b.model))) {
    rows.push([r.task, r.model, r.pass, r.tr?.seconds_to_first_output, r.tr?.seconds_total, r.tr?.n_steps, r.tr?.status, (r.tr?.errors ?? [])[0]?.split("\n")[0]?.slice(0, 200) ?? "", r.reason]);
  }

  writeFileSync(join(runDir, "summary.csv"), rows.map((r) => r.map(esc).join(",")).join("\n") + "\n");
  console.log(rows.map((r) => r.slice(0, 7).join("\t")).join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);

    return i > 0 ? process.argv[i + 1] : d;
  };

  const resume = process.argv.includes("--resume");
  // --resume --run-id X: reuse X's models/tasks unless given, run only (model, task) pairs without a valid result
  const prev = resume && arg("run-id") && existsSync(join(RUNS_DIR, arg("run-id"), "run.json")) ? JSON.parse(readFileSync(join(RUNS_DIR, arg("run-id"), "run.json"), "utf8")) : null;

  if (resume && !prev) throw new Error("--resume needs --run-id of an existing run");

  const models = arg("models", prev?.models?.join(",") ?? "zai-coding-cn/glm-5.3-flash").split(",");
  const all = readFileSync(TASKS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ids = arg("tasks", "") ? arg("tasks").split(",") : prev?.tasks ?? all.map((t) => t.id);

  const tasks = ids.map((id) => {
    const t = all.find((x) => x.id === id);

    if (!t) throw new Error(`unknown task ${id}`);

    return t;
  });

  const runId = arg("run-id", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  const concurrency = Number(arg("concurrency", String(Math.min(2, models.length * tasks.length))));
  const capMs = Number(arg("cap-sec", "240")) * 1000;
  const runDir = join(RUNS_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  const isQuota = (r) => (r?.errors ?? []).some((e) => /额度用完|GoUsageLimitError/.test(e));

  const validResult = (model, id) => {
    const p = join(runDir, slugOf(model), `${id}.json`);

    if (!existsSync(p)) return false;

    try {
      const r = JSON.parse(readFileSync(p, "utf8"));

      return r.status !== "setup_error" && !isQuota(r);
    } catch { return false; }
  };

  if (prev) writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...prev, models: [...new Set([...(prev.models ?? []), ...models])], resumes: [...(prev.resumes ?? []), { at: new Date().toISOString(), concurrency, models }] }, null, 2));
  else writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, models, tasks: ids, concurrency, capMs, started_at: new Date().toISOString() }, null, 2));
  // interleave models so parallel slots compare models on the same task at the same time
  const jobs = [];

  for (const task of tasks) for (const model of models) if (!resume || !validResult(model, task.id)) jobs.push({ task, model });
  let quotaHits = 0, stopped = false;
  // never let a stray socket error kill the whole run; the job in flight is marked error/retried
  process.on("uncaughtException", (e) => console.log(`[${new Date().toLocaleTimeString("en-GB")}] uncaught (ignored): ${e.code ?? ""} ${e.message}`));
  process.on("unhandledRejection", (e) => console.log(`[${new Date().toLocaleTimeString("en-GB")}] unhandled rejection (ignored): ${e?.message ?? e}`));

  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killLive(); process.exit(130); });
  process.on("exit", () => killLive());
  const maxLoad = Number(arg("max-load", String(os.cpus().length * 2)));

  const waitForLoad = async () => {
    const t0 = Date.now();

    while (os.loadavg()[0] > maxLoad && Date.now() - t0 < 15 * 60000) await new Promise((r) => setTimeout(r, 15000));
  };

  const retries = Number(arg("retries", "2"));
  let next = 0;
  const log = (s) => console.log(`[${new Date().toLocaleTimeString("en-GB")}] ${s}`);
  log(`run ${runId}: ${jobs.length} jobs, concurrency ${concurrency}`);
  await Promise.all(Array.from({ length: concurrency }, () => (async () => {
    while (next < jobs.length && !stopped) {
      const { task, model } = jobs[next++];
      const outDir = join(runDir, slugOf(model));
      log(`start ${model} ${task.id}`);
      let rec;

      for (let attempt = 0; attempt <= retries; attempt++) {
        await waitForLoad();

        if (os.loadavg()[0] > maxLoad) log(`load ${os.loadavg()[0].toFixed(1)} > ${maxLoad} after 15 min wait; running anyway`);

        try { rec = await runJob({ task, model, outDir, capMs, log, dryRun: process.argv.includes("--dry-run") }); }
        catch (e) { rec = { status: "error", errors: [`runner: ${e.message}`] }; }

        const crashed = rec.status === "setup_error" || (rec.errors ?? []).some((e) => /CDP pipe closed|chrome\/pipe died/.test(e));

        if (!crashed || isQuota(rec)) break;
        log(`retry ${attempt + 1}/${retries} ${model} ${task.id} (${rec.status}: ${(rec.errors ?? [])[0]?.split("\n")[0]?.slice(0, 100)})`);
        await new Promise((r) => setTimeout(r, 10000));
      }

      // quota guard: park the result in _quota_errors/ and stop after 2 quota errors
      if (isQuota(rec)) {
        const qdir = join(runDir, "_quota_errors", slugOf(model)); mkdirSync(qdir, { recursive: true });

        for (const f of readdirSync(outDir).filter((f) => f.startsWith(`${task.id}.`) || f.startsWith(`${task.id}-`))) renameSync(join(outDir, f), join(qdir, f));

        if (++quotaHits >= 2) { stopped = true; log("QUOTA LIMIT: stopping run (results parked in _quota_errors/)"); }
      }
    }
  })()));

  if (!process.argv.includes("--no-judge") && !process.argv.includes("--dry-run")) {
    log("judging...");
    const res = await judgeRun(runDir, tasks, models, { onlyExisting: true });
    writeSummary(runDir, res);
  }

  log(`done: ${runDir}`);
}
