#!/usr/bin/env node
/**
 * Complexity ladder (docs/evals/20261006-complexity-ladder.md): runs every level of eval/tasks/ladder.json
 * N times with run.mjs, then writes one table per level: pass rate, median tool calls, median seconds.
 *   node eval/harness/ladder.mjs --tag before --models openai-codex/gpt-6-luna [--repeats 3] [--levels L1,L6] [--concurrency 3]
 *   node eval/harness/ladder.mjs --tag before --report        (table only, from existing results)
 * Output: <runs>/ladder-<tag>/r<n>-<level>/ (normal run dirs, judged) and <runs>/ladder-<tag>/ladder.{md,json}
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVAL_DIR, RUNS_DIR } from "./paths.mjs";
import { slugOf } from "./job.mjs";

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`);

 return i > 0 ? process.argv[i + 1] : d; };

const tag = arg("tag");

if (!tag) throw new Error("--tag is required");

const ladder = JSON.parse(readFileSync(join(EVAL_DIR, "tasks/ladder.json"), "utf8")).levels;

const levels = (arg("levels") ?? Object.keys(ladder).join(",")).split(",");

const models = arg("models", "openai-codex/gpt-6-luna");

const repeats = Number(arg("repeats", "3"));

const root = join(RUNS_DIR, `ladder-${tag}`);

if (!process.argv.includes("--report")) {
  const run = join(dirname(fileURLToPath(import.meta.url)), "run.mjs");

  for (let r = 1; r <= repeats; r++) for (const level of levels) {
    const { tasks, cap_sec = 300 } = ladder[level];
    const runId = `ladder-${tag}/r${r}-${level}`;
    const resume = existsSync(join(RUNS_DIR, runId, "run.json")) ? ["--resume"] : [];
    execFileSync("node", [run, ...resume, "--run-id", runId, "--models", models, "--tasks", tasks.join(","), "--cap-sec", String(cap_sec), "--concurrency", arg("concurrency", "3")], { stdio: "inherit" });
  }
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b);

 return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const rows = [];

for (const level of levels) {
  const results = [];

  for (const dir of existsSync(root) ? readdirSync(root).filter((d) => d.endsWith(`-${level}`)) : []) {
    for (const model of models.split(",")) for (const id of ladder[level].tasks) {
      const res = join(root, dir, slugOf(model), `${id}.json`);

      if (!existsSync(res)) continue;
      const tr = JSON.parse(readFileSync(res, "utf8"));
      const jp = join(root, dir, "judge", slugOf(model), `${id}.json`);
      const verdict = existsSync(jp) ? JSON.parse(readFileSync(jp, "utf8")).verdict : "unjudged";
      results.push({ run: dir, model, id, verdict, status: tr.status, tools: tr.n_tool_calls ?? null, seconds: tr.seconds_total, environment: tr.status === "environment" || verdict === "environment" });
    }
  }

  const counted = results.filter((x) => !x.environment && ["pass", "fail"].includes(x.verdict));
  rows.push({ level, name: ladder[level].name, runs: results.length, pass: counted.filter((x) => x.verdict === "pass").length, judged: counted.length,
    environment: results.filter((x) => x.environment).length, median_tools: median(counted.map((x) => x.tools)), median_seconds: median(counted.map((x) => x.seconds)),
    per_task: ladder[level].tasks.map((id) => ({ id, verdicts: results.flatMap((x) => x.id === id ? [x.verdict] : []) })), results });
}

const md = [`# 复杂度阶梯 · ${tag} · ${models}`, "", "| 级 | 内容 | 通过 | 中位工具调用 | 中位耗时（秒） | 环境失败 | 每题（各次结果） |", "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.level} | ${r.name} | ${r.pass}/${r.judged} | ${r.median_tools ?? "–"} | ${r.median_seconds ?? "–"} | ${r.environment} | ${r.per_task.map((t) => `${t.id} ${t.verdicts.map((v) => ({ pass: "✓", fail: "✗" })[v] ?? "?").join("")}`).join("<br>")} |`)].join("\n");

writeFileSync(join(root, "ladder.md"), md + "\n");

writeFileSync(join(root, "ladder.json"), JSON.stringify(rows, null, 1));

console.log(md);
