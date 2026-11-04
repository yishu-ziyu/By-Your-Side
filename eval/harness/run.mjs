#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runJob, killLive, slugOf } from "./job.mjs";
import os from "node:os";
import { judgeRun } from "./judge.mjs";
import { startLadderSites } from "./ladder-sites.mjs";
import { REPO, RUNS_DIR, TASKS_FILE } from "./paths.mjs";

export { writeSummary } from "./summary.mjs";

import { writeSummary } from "./summary.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);

    return i > 0 ? process.argv[i + 1] : d;
  };

  const resume = process.argv.includes("--resume");
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

      return r.status !== "setup_error" && !isQuota(r) && !(!r.environment && (r.panel_messages ?? []).some((m) => /模型返回了空响应/.test(m.text)));
    } catch { return false; }
  };

  const armsArg = arg("arms", prev?.arms ? Object.entries(prev.arms).map(([k, v]) => `${k}=${v.dist}`).join(",") : "");
  const repeats = Number(arg("repeats", String(prev?.repeats ?? 1)));
  const files = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();

  const distSha = (dir) => {
    const h = createHash("sha256");

    for (const f of files(dir)) h.update(relative(dir, f)).update(readFileSync(f));

    return h.digest("hex").slice(0, 16);
  };

  const arms = armsArg ? Object.fromEntries(armsArg.split(",").map((a) => { const [name, dist] = a.split("="); return [name, { dist, dist_sha: distSha(dist) }]; })) : null;
  const armNames = arms ? Object.keys(arms) : [null];
  const specOf = (arm, rep, model) => arm ? `${arm}--r${rep}--${model}` : model;
  const repoHead = (() => { try { return execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"]).toString().trim(); } catch { return null; } })();
  const code = { repo: REPO, repo_head: repoHead, arms };

  for (const [name, a] of Object.entries(prev?.arms ?? {})) if (arms?.[name]?.dist_sha !== a.dist_sha) throw new Error(`--resume: arm ${name} is now ${arms?.[name]?.dist_sha ?? "missing"}, the run used ${a.dist_sha}`);

  if (prev) writeFileSync(join(runDir, "run.json"), JSON.stringify({ ...prev, models: [...new Set([...(prev.models ?? []), ...models])], resumes: [...(prev.resumes ?? []), { at: new Date().toISOString(), concurrency, models, code }] }, null, 2));
  else writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, models, tasks: ids, concurrency, capMs, ...(arms ? { arms, repeats } : {}), code, started_at: new Date().toISOString() }, null, 2));
  const jobs = [];

  for (let rep = 1; rep <= (arms ? repeats : 1); rep++) for (const task of tasks) for (const model of models) {
    const order = rep % 2 ? armNames : [...armNames].reverse();

    for (const arm of order) if (!resume || !validResult(specOf(arm, rep, model), task.id)) jobs.push({ task, model, arm, spec: specOf(arm, rep, model) });
  }

  if (tasks.some((t) => JSON.stringify(t).includes("{ladder}"))) process.env.BYS_LADDER_BASE = (await startLadderSites()).base;
  const hostOf = (task) => new URL(task.site_url.replace("{ladder}", process.env.BYS_LADDER_BASE)).hostname;
  let quotaHits = 0, stopped = false;
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
  const pending = jobs.slice();
  const activeSites = new Set();
  const log = (s) => console.log(`[${new Date().toLocaleTimeString("en-GB")}] ${s}`);
  log(`run ${runId}: ${jobs.length} jobs, concurrency ${concurrency}`);
  await Promise.all(Array.from({ length: concurrency }, () => (async () => {
    while (pending.length && !stopped) {
      const available = pending.findIndex(j => !activeSites.has(hostOf(j.task)));

      if (available < 0) { await new Promise(r => setTimeout(r, 200)); continue; }

      const { task, model, arm, spec } = pending.splice(available, 1)[0];
      const site = hostOf(task);
      activeSites.add(site);
      const outDir = join(runDir, slugOf(spec));
      log(`start ${spec} ${task.id}`);
      let rec;

      for (let attempt = 0; attempt <= retries; attempt++) {
        await waitForLoad();

        if (os.loadavg()[0] > maxLoad) log(`load ${os.loadavg()[0].toFixed(1)} > ${maxLoad} after 15 min wait; running anyway`);

        try { rec = await runJob({ task, model, outDir, capMs, log, dryRun: process.argv.includes("--dry-run"), dist: arm ? arms[arm].dist : undefined }); }
        catch (e) { rec = { status: "error", errors: [`runner: ${e.message}`] }; }

        const crashed = rec.status === "setup_error" || rec.environment?.kind === "model_empty" || (rec.errors ?? []).some((e) => /CDP pipe closed|chrome\/pipe died/.test(e));

        if (!crashed || isQuota(rec)) break;
        log(`retry ${attempt + 1}/${retries} ${spec} ${task.id} (${rec.status}: ${(rec.errors ?? [])[0]?.split("\n")[0]?.slice(0, 100)})`);
        await new Promise((r) => setTimeout(r, 30000));
      }

      activeSites.delete(site);

      if (isQuota(rec)) {
        const qdir = join(runDir, "_quota_errors", slugOf(spec)); mkdirSync(qdir, { recursive: true });

        for (const f of readdirSync(outDir).filter((f) => f.startsWith(`${task.id}.`) || f.startsWith(`${task.id}-`))) renameSync(join(outDir, f), join(qdir, f));

        if (++quotaHits >= 2) { stopped = true; log("QUOTA LIMIT: stopping run (results parked in _quota_errors/)"); }
      }
    }
  })()));

  if (!process.argv.includes("--no-judge") && !process.argv.includes("--dry-run")) {
    log("judging...");
    const specs = arms ? Array.from({ length: repeats }, (_, i) => armNames.flatMap((arm) => models.map((model) => specOf(arm, i + 1, model)))).flat() : models;
    const res = await judgeRun(runDir, tasks, specs, { onlyExisting: true });
    writeSummary(runDir, res);
  }

  log(`done: ${runDir}`);
  process.stdout.write("", () => process.exit(0));
}
