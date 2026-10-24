#!/usr/bin/env node
/**
 * Paired comparison of code versions in one `run.mjs --arms` run (after finalize.sh judged it):
 *   node eval/harness/paired.mjs <runDir> [--base base] [--cand cand]
 * Pairs = same task and repeat on both arms. A pair is dropped when either side is an environment failure,
 * an unjudged result or a judge error, and dropped pairs are counted, never hidden.
 * Writes <runDir>/paired.json and paired.md.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg("base", "base"), CAND = arg("cand", "cand");
const BROWSER_TOOLS = new Set(["click", "double_click", "hover", "fill", "type_text", "press_key", "select_option", "scroll", "navigate", "snapshot", "read_element", "read_elements", "screenshot", "tabs", "browser_run", "js", "fetch", "network", "download_url", "upload_file", "accept_dialog", "dismiss_dialog", "wait_event", "arm_event"]);
// 回答承认没做完的说法；扩展自动加的脚注（「有一步已经做了，但还没确认结果」）也算承认。
const ADMITS = /没(有)?(完成|做成|做完|做到|成功|找到|能|办法)|未(能|完成|做完|成功|找到|确认)|还没(确认|做|完成)|无法|做不到|找不到|请你|需要你|失败|不能确定|not (been )?(completed|done|able)|could ?n[o']t|unable|failed/i;

const readJson = (p) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
const traceOf = (p) => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

function metrics(dir, task) {
  const rec = readJson(join(runDir, dir, `${task}.json`));

  if (!rec) return null;
  const judge = readJson(join(runDir, "judge", dir, `${task}.json`));
  const trace = traceOf(join(runDir, dir, `${task}.trace.jsonl`));
  const of = (type) => trace.filter((e) => e.type === type);
  const usage = of("turn_end").map((e) => e.data?.usage ?? {});
  const sum = (k) => usage.reduce((a, u) => a + (u[k] ?? 0), 0);
  const tools = of("tool_execution_end").map((e) => e.data ?? {});
  const browser = tools.filter((t) => BROWSER_TOOLS.has(t.toolName));
  const checks = of("goal_check").map((e) => e.data ?? {});
  // judge.mjs already turns a fail caused by proved site unavailability into "environment"; a pass stays a pass
  const verdict = judge?.verdict ?? (rec.status === "environment" ? "environment" : judge?.judge_error ? "judge_error" : "unjudged");
  const answer = rec.final_answer_verbatim ?? "";
  const claimed = !!answer && !ADMITS.test(answer);

  return {
    verdict, pass: verdict === "pass", status: rec.status, seconds: rec.seconds_total,
    model_requests: of("model_request").length, side_calls: of("side_call").length,
    input: sum("input"), output: sum("output"), cache_read: sum("cacheRead"),
    tool_calls: tools.length, browser_calls: browser.length, browser_errors: browser.filter((t) => t.isError).length,
    snapshots: browser.filter((t) => t.toolName === "snapshot").length,
    goal_continues: checks.filter((data) => data.status === "continue" && typeof data.attempt === "number").length, last_check: checks.at(-1)?.status ?? null,
    claimed, false_complete: verdict === "fail" && claimed,
  };
}

const meta = readJson(join(runDir, "run.json"));
const dirs = readdirSync(runDir).filter((d) => /--r\d+--/.test(d));
const series = dirs.map((d) => { const [arm, rep, ...m] = d.split("--"); return { d, arm, rep: Number(rep.slice(1)), model: m.join("--") }; });
const tasks = meta.tasks;
const pairs = [], dropped = [];

for (const s of series.filter((x) => x.arm === BASE || x.arm === CAND)) {
  const other = series.find((x) => x.arm === (s.arm === BASE ? CAND : BASE) && x.rep === s.rep && x.model === s.model);

  if (!other) { for (const task of tasks) if (metrics(s.d, task)) dropped.push({ task, rep: s.rep, why: `no ${s.arm === BASE ? CAND : BASE} series` }); continue; }

  if (s.arm !== BASE) continue;
  const c = other;

  for (const task of tasks) {
    const a = metrics(s.d, task), b = metrics(c.d, task);

    if (!a || !b) { if (a || b) dropped.push({ task, rep: s.rep, why: "missing on one side" }); continue; }

    const bad = [a, b].find((m) => !["pass", "fail", "undeterminable"].includes(m.verdict));

    if (bad) { dropped.push({ task, rep: s.rep, why: bad.verdict }); continue; }
    pairs.push({ task, rep: s.rep, base: a, cand: b });
  }
}

const median = (xs) => { const v = xs.filter((x) => x != null && !Number.isNaN(x)).sort((p, q) => p - q); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// exact two-sided McNemar on discordant pairs
function mcnemar(b, c) {
  const n = b + c;

  if (!n) return 1;
  // binomial(n, 1/2) tail in log space: 2 ** n overflows past n = 1023
  const logChoose = (n, k) => { let r = 0; for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i); return r; };
  let p = 0;

  for (let k = 0; k <= Math.min(b, c); k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);

  return Math.min(1, 2 * p);
}

// task-clustered bootstrap of a paired statistic, fixed seed so the report is reproducible
function bootstrap(stat, iters = 4000) {
  const byTask = Object.values(Object.groupBy(pairs, (p) => p.task));
  let seed = 20261020;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const vals = [];

  for (let i = 0; i < iters; i++) {
    const sample = Array.from({ length: byTask.length }, () => byTask[Math.floor(rnd() * byTask.length)]).flat();
    const v = stat(sample);

    if (v != null) vals.push(v);
  }

  vals.sort((a, b) => a - b);

  return vals.length ? [vals[Math.floor(vals.length * 0.025)], vals[Math.floor(vals.length * 0.975)]] : null;
}

const rate = (ps, arm, k) => ps.length ? ps.filter((p) => p[arm][k]).length / ps.length : null;
const passDiff = (ps) => ps.length ? rate(ps, "cand", "pass") - rate(ps, "base", "pass") : null;
const bothPass = (ps) => ps.filter((p) => p.base.pass && p.cand.pass);
const medDiff = (k) => (ps) => median(bothPass(ps).map((p) => p.cand[k] - p.base[k]));
const b = pairs.filter((p) => p.base.pass && !p.cand.pass).length, c = pairs.filter((p) => !p.base.pass && p.cand.pass).length;
const EFF = ["seconds", "model_requests", "browser_calls", "input", "output", "snapshots", "goal_continues"];

const summary = {
  run: runDir, arms: meta.arms, code: meta.code, pairs: pairs.length, dropped: dropped.length, dropped_detail: dropped,
  pass: { base: rate(pairs, "base", "pass"), cand: rate(pairs, "cand", "pass"), diff: passDiff(pairs), ci95: bootstrap(passDiff), base_only: b, cand_only: c, mcnemar_p: mcnemar(b, c) },
  false_complete: { base: rate(pairs, "base", "false_complete"), cand: rate(pairs, "cand", "false_complete") },
  efficiency_both_pass: Object.fromEntries(EFF.map((k) => [k, {
    base_median: median(bothPass(pairs).map((p) => p.base[k])), cand_median: median(bothPass(pairs).map((p) => p.cand[k])),
    paired_median_diff: medDiff(k)(pairs), ci95: bootstrap(medDiff(k)),
  }])),
  all_pairs_seconds: { base_median: median(pairs.map((p) => p.base.seconds)), cand_median: median(pairs.map((p) => p.cand.seconds)), base_timeouts: pairs.filter((p) => p.base.status === "timeout").length, cand_timeouts: pairs.filter((p) => p.cand.status === "timeout").length },
  tokens_lower_bound_note: "input/output = main-model turn_end usage only; fast-model side calls are counted, not tokenized",
  per_task: Object.fromEntries(Object.entries(Object.groupBy(pairs, (p) => p.task)).map(([t, ps]) => [t, {
    n: ps.length, base_pass: ps.filter((p) => p.base.pass).length, cand_pass: ps.filter((p) => p.cand.pass).length,
    base_false_complete: ps.filter((p) => p.base.false_complete).length, cand_false_complete: ps.filter((p) => p.cand.false_complete).length,
    base_med_s: median(ps.map((p) => p.base.seconds)), cand_med_s: median(ps.map((p) => p.cand.seconds)),
    base_med_req: median(ps.map((p) => p.base.model_requests)), cand_med_req: median(ps.map((p) => p.cand.model_requests)),
    base_med_in: median(ps.map((p) => p.base.input)), cand_med_in: median(ps.map((p) => p.cand.input)),
  }])),
};

const pct = (x) => x == null ? "—" : `${(x * 100).toFixed(1)}%`;
const fmt = (x) => x == null ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(1);
const ci = (r, f = fmt) => r ? `[${f(r[0])}, ${f(r[1])}]` : "—";
const md = [
  `# 配对对比：${CAND} 对 ${BASE}`, "",
  `配对 ${summary.pairs} 组，剔除 ${summary.dropped} 组（环境失败、未判分或缺一边）。`, "",
  `| 指标 | ${BASE} | ${CAND} | 差（${CAND}−${BASE}） | 95% 区间 |`, "|---|---|---|---|---|",
  `| 通过率 | ${pct(summary.pass.base)} | ${pct(summary.pass.cand)} | ${pct(summary.pass.diff)} | ${ci(summary.pass.ci95, pct)} |`,
  `| 假完成率 | ${pct(summary.false_complete.base)} | ${pct(summary.false_complete.cand)} | | |`,
  ...EFF.map((k) => { const e = summary.efficiency_both_pass[k]; return `| ${k}（两边都通过，中位） | ${fmt(e.base_median)} | ${fmt(e.cand_median)} | ${fmt(e.paired_median_diff)} | ${ci(e.ci95)} |`; }),
  "", `只在一边通过：${BASE} ${b} 组，${CAND} ${c} 组；精确 McNemar p=${summary.pass.mcnemar_p.toFixed(3)}。超时：${BASE} ${summary.all_pairs_seconds.base_timeouts}，${CAND} ${summary.all_pairs_seconds.cand_timeouts}。`,
  "", "| 题 | n | 通过 base/cand | 假完成 base/cand | 中位秒 base/cand | 中位模型请求 base/cand | 中位输入 token base/cand |", "|---|---|---|---|---|---|---|",
  ...Object.entries(summary.per_task).map(([t, r]) => `| ${t} | ${r.n} | ${r.base_pass}/${r.cand_pass} | ${r.base_false_complete}/${r.cand_false_complete} | ${fmt(r.base_med_s)}/${fmt(r.cand_med_s)} | ${fmt(r.base_med_req)}/${fmt(r.cand_med_req)} | ${fmt(r.base_med_in)}/${fmt(r.cand_med_in)} |`),
  "", "token 只含主模型；快速模型旁路只计次数，是下界。",
];

writeFileSync(join(runDir, "paired.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(runDir, "paired.md"), md.join("\n"));
console.log(md.slice(0, 16).join("\n"));
