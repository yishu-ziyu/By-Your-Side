/**
 * 改前改后对照：同一组自用回放任务，用两份预先构建的扩展交错各跑几次，汇总顺利完成、用时、核对后、模型往返和核对结论。
 *   npx tsx scripts/maintenance/replay-ab.mts --base=<改前 dist> --cand=<改后 dist> [--only=13] [--pool=任务池] [--runs=3] [--label=名字]
 *   npx tsx scripts/maintenance/replay-ab.mts --base=… --cand=… --case=<真实路径用例名> [--runs=3] [--label=名字] [-- 用例参数…]   （对照一个验收用例，按退出码判过没过）
 * 两边轮流先跑（候选、改前、改前、候选……），抵消时段差别；每次开跑前等 1 分钟负载降到 20 以下。
 * 每次都带上 SIDEAGENT_BUILD_ROLE=base|cand，验收流水和回放报告据此分得出是哪份构建。
 * 每次的报告和诊断记录照常在 out/self-use/<日期>-<名字>-<cand|base>-<序号>；汇总写 out/self-use/<名字>-ab.md。
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { REPO, sleep } from "../acceptance/real-path/harness.mts";

type Row = { n: number; say: string; secs: number; checkSecs?: number; calls: number; finished: boolean; error: string | null; cardSaysFailed: boolean; changedGoal?: boolean; answer: string };
type Run = { arm: "cand" | "base"; index: number; report: string; rows: Row[]; goals: string[] };

const own = process.argv.includes("--") ? process.argv.slice(0, process.argv.indexOf("--")) : process.argv;
const arg = (name: string) => own.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dists = { base: arg("base"), cand: arg("cand") };

if (!dists.base || !dists.cand) {
  console.error("要给 --base=<改前 dist> 和 --cand=<改后 dist>。");
  process.exit(1);
}

const runs = Math.max(1, Number(arg("runs") ?? 3));
const label = arg("label") ?? `ab-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
const passed = (["only", "pool"] as const).flatMap(key => (arg(key) ? [`--${key}=${arg(key)}`] : []));
const order = Array.from({ length: runs }, (_, pair) => (pair % 2 === 0 ? ["cand", "base"] as const : ["base", "cand"] as const)).flat();
const done: Run[] = [];
const ok = (row: Row) => row.finished && !row.error && !row.cardSaysFailed && !row.changedGoal && !!row.answer.trim() && !/没给出最后的回答/.test(row.answer);
const kase = arg("case");
const caseArgs = process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : [];

/** 一次回放：子进程跑 self-use-replay，从它打印的「报告：…」拿到这次的报告。 */
function replay(arm: "cand" | "base", index: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/maintenance/self-use-replay.mts", ...passed, `--label=${label}-${arm}-${index}`], {
      cwd: REPO, env: { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dists[arm], SIDEAGENT_BUILD_ROLE: arm, SIDEAGENT_RECORD: "0" }, stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", chunk => { out += String(chunk); process.stdout.write(chunk); });
    child.on("close", code => {
      const report = /报告：(\S+\.md)/.exec(out)?.[1];
      report ? resolve(report) : reject(new Error(`${arm} 第 ${index} 次回放没有出报告（退出码 ${code}）`));
    });
  });
}

/** 这次各句诊断记录里的核对结论，按出现顺序。 */
function goalStatuses(report: string): string[] {
  const dir = report.replace(/\.md$/, "");

  if (!existsSync(dir)) return [];

  return readdirSync(dir).filter(name => name.endsWith(".trace.jsonl")).flatMap(name => readFileSync(join(dir, name), "utf8").split("\n")
    .filter(line => line.includes('"type":"goal_check"'))
    .flatMap(line => { try { const status: unknown = JSON.parse(line).data?.status; return typeof status === "string" ? [status] : []; } catch { return []; } }));
}

/** 一次验收用例：退出码 0 算过。对照本来就要把同一份代码跑好几次，所以不受「同样代码失败两次就拦」限制。 */
function runCase(arm: "cand" | "base"): Promise<{ ok: boolean; seconds: number }> {
  const started = Date.now();

  return new Promise(resolve => {
    const child = spawn("npx", ["tsx", `scripts/acceptance/real-path/${kase}.mts`, "--headless", ...caseArgs], {
      cwd: REPO, env: { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dists[arm], SIDEAGENT_BUILD_ROLE: arm, SIDEAGENT_RECORD: "0", BYS_RERUN: "1" }, stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", code => resolve({ ok: code === 0, seconds: Math.round((Date.now() - started) / 1000) }));
  });
}

if (kase) {
  const results: Array<{ arm: "cand" | "base"; ok: boolean; seconds: number }> = [];

  for (const arm of order) {
    while (loadavg()[0] >= 20) await sleep(20_000);
    const load = Math.round(loadavg()[0] * 10) / 10;
    results.push({ arm, ...await runCase(arm) });
    console.log(`[ab] ${arm}: ${results.at(-1)!.ok ? "过" : "没过"}，${results.at(-1)!.seconds} 秒，开跑时负载 ${load}`);
  }

  const table = [`# 用例对照 ${kase} ${caseArgs.join(" ")} ${label}`, ``, `改后 ${dists.cand}；改前 ${dists.base}；各 ${runs} 次交错。`, ``, `| 版本 | 过 | 用时（秒） |`, `|---|---|---|`,
    ...(["cand", "base"] as const).map(arm => { const own = results.filter(r => r.arm === arm); return `| ${arm === "cand" ? "改后" : "改前"} | ${own.filter(r => r.ok).length}/${own.length} | ${own.map(r => r.seconds).join(" / ")} |`; })].join("\n") + "\n";
  const file = join(REPO, "out/acceptance/real-path", `${label}-${kase}-ab.md`);
  await writeFile(file, table);
  console.log(table);
  console.log(`汇总：${file}`);
  process.exit(0);
}

const counter: Record<"cand" | "base", number> = { cand: 0, base: 0 };

for (const arm of order) {
  const index = ++counter[arm];

  while (loadavg()[0] >= 20) await sleep(20_000);
  const report = await replay(arm, index);
  // SAFETY: self-use-replay 写的 json 是 { rows: Row[] }。
  const rows = (JSON.parse(readFileSync(report.replace(/\.md$/, ".json"), "utf8")) as { rows: Row[] }).rows;
  done.push({ arm, index, report, rows, goals: goalStatuses(report) });
  console.log(`[ab] ${arm}-${index}: ${rows.filter(ok).length}/${rows.length} 顺利，用时 ${rows.map(r => r.secs).join("/")} 秒，核对 ${done.at(-1)!.goals.join(",") || "无"}`);
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0; };
const mean = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : 0);
const summary = (["cand", "base"] as const).map(arm => {
  const all = done.filter(run => run.arm === arm);
  const rows = all.flatMap(run => run.rows);
  const goals = all.flatMap(run => run.goals);
  const tally = Object.entries(goals.reduce<Record<string, number>>((count, status) => ({ ...count, [status]: (count[status] ?? 0) + 1 }), {})).map(([status, count]) => `${status} ${count}`).join("、") || "无";

  return `| ${arm === "cand" ? "改后" : "改前"} | ${all.length} | ${rows.filter(ok).length}/${rows.length} | ${median(rows.map(r => r.secs))} / ${mean(rows.map(r => r.secs))} | ${mean(rows.map(r => r.checkSecs ?? 0))} | ${mean(rows.map(r => r.calls))} | ${tally} |`;
});
const table = [
  `# 回放对照 ${label}`,
  ``,
  `改后 ${dists.cand}；改前 ${dists.base}；${passed.join(" ") || "全部任务"}，各 ${runs} 次交错。`,
  ``,
  `| 版本 | 次数 | 顺利完成 | 用时 中位 / 平均（秒） | 核对后平均（秒） | 往返平均 | 核对结论 |`,
  `|---|---|---|---|---|---|---|`,
  ...summary,
  ``,
  ...done.map(run => `- ${run.arm}-${run.index}：${run.report}`),
].join("\n") + "\n";
const file = join(REPO, "out/self-use", `${label}-ab.md`);
await writeFile(file, table);
console.log(table);
console.log(`汇总：${file}`);
