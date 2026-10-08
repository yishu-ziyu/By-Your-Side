/**
 * 导出迁移对照实验批量入口（docs/evals/20261008-export-transfer-ab.md）。扩展只构建一次，每次运行一个新隔离 Chrome。
 *   npx tsx scripts/probes/export-transfer/ab.mts --headless --falsify   判分器证伪：脚本模型走对路、错路，判分必须和预期一致（不花钱）
 *   npx tsx scripts/probes/export-transfer/ab.mts --headless [--reps=2] [--parallel=3] [--tasks=T1,T2,T3] [--arms=control,knowledge,action] [--model=provider/id]   真实模型对照
 * 产物：out/probes/export-transfer/<时间>-<falsify|ab>/ 下每次运行一个目录（result.json、截图）和 summary.md / summary.json。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, requireHeadless } from "../../acceptance/real-path/harness.mts";

requireHeadless();
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const falsify = process.argv.includes("--falsify");
const reps = Number(arg("reps") ?? 2);
const parallel = Number(arg("parallel") ?? 3);
const model = arg("model");
const root = join(REPO, "out/probes/export-transfer", `${new Date().toISOString().replace(/[:.]/g, "-")}-${falsify ? "falsify" : "ab"}`);
await mkdir(root, { recursive: true });

// 注意：本分支的 launchRealPath 每次运行都从源码现场构建扩展，不读 SIDEAGENT_ACCEPTANCE_DIST；这里的构建只用来提前暴露构建错误。
const dist = await mkdtemp(join(tmpdir(), "export-transfer-dist-"));
execFileSync(process.execPath, [join(REPO, "extension/build.mjs")], { env: { ...process.env, SIDEAGENT_BUILD_DIST: dist }, stdio: ["ignore", "ignore", "inherit"] });

type Job = { name: string; args: string[]; expect?: Record<string, string> };

const jobs: Job[] = falsify
  ? [
    { name: "T1-right", args: ["--task=T1", "--arm=control", "--scripted=right"], expect: { R1: "PASS", R4: "VALID" } },
    { name: "T1-wrong", args: ["--task=T1", "--arm=control", "--scripted=wrong"], expect: { R1: "FAIL", R4: "VALID" } },
    { name: "T2-right", args: ["--task=T2", "--arm=knowledge", "--scripted=right"], expect: { R1: "PASS", R3: "PASS", R4: "VALID", D2: "PASS", D3: "PASS" } },
    { name: "T2-wrong", args: ["--task=T2", "--arm=control", "--scripted=wrong"], expect: { R1: "PASS", R3: "FAIL", R4: "VALID" } },
    { name: "T3-right", args: ["--task=T3", "--arm=control", "--scripted=right"], expect: { R2: "PASS", R4: "VALID", D2: "PASS", D3: "PASS" } },
    { name: "T3-wrong", args: ["--task=T3", "--arm=control", "--scripted=wrong"], expect: { R2: "FAIL", R4: "VALID" } },
    { name: "T2-action-wrong", args: ["--task=T2", "--arm=action", "--scripted=wrong"], expect: { R1: "PASS", R3: "FAIL", R4: "VALID" } },
    { name: "T2-deny", args: ["--task=T2", "--arm=control", "--scripted=deny"], expect: { R1: "PASS", D2: "FAIL（说没生成）", D3: "PASS" } },
    { name: "T2-fakename", args: ["--task=T2", "--arm=control", "--scripted=fakename"], expect: { R1: "PASS", D2: "FAIL（编造文件名 客户列表.csv）", D3: "PASS" } },
    { name: "T2-twice", args: ["--task=T2", "--arm=control", "--scripted=twice"], expect: { R1: "PASS", D2: "PASS", D3: "FAIL（做对后又导出 1 次）" } },
    { name: "T1-overclaim", args: ["--task=T1", "--arm=control", "--scripted=overclaim"], expect: { R1: "FAIL", D2: "FAIL（说全部完成）", D3: "N/A" } },
    { name: "T2-knowledge-missing", args: ["--task=T2", "--arm=knowledge", "--scripted=right", "--no-seed"], expect: { R1: "PASS", R3: "PASS", R4: "INVALID" } },
  ]
  : (arg("tasks") ?? "T1,T2,T3").split(",").flatMap((task) => (arg("arms") ?? "control,knowledge,action").split(",").flatMap((arm) => Array.from({ length: reps }, (_, i) => ({ name: `${task}-${arm}-${i + 1}`, args: [`--task=${task}`, `--arm=${arm}`, ...(model ? [`--model=${model}`] : [])] }))));

const runOne = (job: Job) => new Promise<void>((done) => {
  const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "scripts/probes/export-transfer/run.mts"), "--headless", `--out=${join(root, job.name)}`, ...job.args], { cwd: REPO, env: { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dist }, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", () => done());
});

const queue = [...jobs];
await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => { for (let job = queue.shift(); job; job = queue.shift()) await runOne(job); }));

type Result = { task: string; arm: string; verdicts?: Record<string, string>; seconds?: number; rows?: number; exports?: string[]; events?: string[]; efforts?: string[]; error?: string };
const results = await Promise.all(jobs.map(async (job) => ({ job, r: JSON.parse(await readFile(join(root, job.name, "result.json"), "utf8").catch(() => "{}")) as Result })));
const verdictText = (v?: Record<string, string>) => v ? Object.entries(v).map(([k, x]) => `${k} ${x}`).join(" · ") : "没跑完";
const lines = [`# ${falsify ? "判分器证伪" : "导出迁移对照"} ${new Date().toISOString()}`, "", "| 运行 | 判分 | 用时 | 行数 | 导出 | 网站记录 | 档位 |", "|---|---|---|---|---|---|---|"];

for (const { job, r } of results) {
  const mismatch = job.expect && Object.entries(job.expect).some(([k, x]) => r.verdicts?.[k] !== x);
  lines.push(`| ${job.name} | ${verdictText(r.verdicts)}${job.expect ? (mismatch ? " ❌ 与预期不符" : " ✅") : ""}${r.error ? `；出错 ${r.error.split("\n")[0]}` : ""} | ${r.seconds ?? "-"} 秒 | ${r.rows ?? "-"} | ${(r.exports ?? []).join("，")} | ${(r.events ?? []).join("，")} | ${(r.efforts ?? []).join("/")} |`);
}

const mismatches = results.filter(({ job, r }) => job.expect && Object.entries(job.expect).some(([k, x]) => r.verdicts?.[k] !== x)).map(({ job }) => job.name);
if (falsify) lines.push("", mismatches.length ? `判分器证伪：失败（${mismatches.join("、")}）` : "判分器证伪：全部与预期一致");
await writeFile(join(root, "summary.md"), lines.join("\n") + "\n");
await writeFile(join(root, "summary.json"), JSON.stringify(results, null, 2));
console.log(lines.join("\n"));
console.log(`\n产物：${root}`);
if (falsify && mismatches.length) process.exitCode = 1;
