import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { REPO, sleep } from "../acceptance/real-path/harness.mts";
import { type Arm, type Pass, type Verdict, judge, registrationOf, shuffled } from "./climb-rules.mts";
import { poolOf, type Row } from "./replay-row.mts";

const MAX_LOAD = 20;
const ignoreLoad = process.argv.includes('--force');

async function waitForQuietMachine() {
  if (ignoreLoad) return;
  while (loadavg()[0] >= MAX_LOAD) await sleep(20_000);
}

function child(args: string[], env: Record<string, string>, capture: boolean): Promise<{ code: number | null; out: string }> {
  return new Promise(done => {
    const proc = spawn("npx", ["tsx", ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    let out = "";
    proc.stdout?.on("data", chunk => { out += String(chunk); process.stdout.write(chunk); });
    proc.on("close", code => done({ code, out }));
  });
}

const file = process.argv[2] ?? "";
const reg = registrationOf(JSON.parse(readFileSync(file, "utf8")));
const registrationHash = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
const dists: Record<Arm, string> = { base: resolve(REPO, reg.base), cand: resolve(REPO, reg.cand) };
for (const arm of ["base", "cand"] as const) if (!existsSync(join(dists[arm], "manifest.json"))) throw new Error(`${arm} 构建目录里没有 manifest.json：${dists[arm]}`);
const pool = reg.scenarios.length ? poolOf(JSON.parse(readFileSync(reg.pool ?? join(REPO, "out/self-use/pool.json"), "utf8"))) : [];
const sentences = new Map(reg.scenarios.map(n => {
  const task = pool.find(t => t.n === n);
  if (!task) throw new Error(`任务池里没有场景 ${n}`);
  return [n, task.say.length] as const;
}));
const rulerHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const rulerDirty = execFileSync("git", ["status", "--porcelain", "--", "scripts/maintenance", "scripts/acceptance"], { cwd: REPO, encoding: "utf8" }).trim().length > 0;
const outDir = join(REPO, "out/hill-climb", reg.name);
await mkdir(outDir, { recursive: true });
const started = Date.now();
const reasons: string[] = [];
const notes: string[] = [];
if (ignoreLoad) notes.push('本次按用户要求跳过负载等待；耗时不用于速度改善结论。');
let early: Verdict | null = null;

async function runCase(name: string, arm: Arm, args: string[] = []) {
  await waitForQuietMachine();
  const { code } = await child([`scripts/acceptance/real-path/${name}.mts`, "--headless", ...args], { SIDEAGENT_ACCEPTANCE_DIST: dists[arm], SIDEAGENT_BUILD_ROLE: arm, SIDEAGENT_RECORD: "0", BYS_RERUN: "1" }, false);
  return code === 0;
}

for (const name of reg.redLines) {
  if (await runCase(name, "cand")) continue;
  if (await runCase(name, "base")) { early = "否决"; reasons.push(`红线 ${name} 改后失败、改前通过`); }
  else { early ??= "证据不足"; reasons.push(`红线 ${name} 改前改后都失败：先修用例或环境`); }
}

let caseTargetPass: boolean | null = null;
if (!early && "case" in reg.target) {
  const { case: name, runs = 3, args } = reg.target;
  const results: Record<Arm, boolean[]> = { base: [], cand: [] };
  for (const order of shuffled(reg.seed, runs)) for (const arm of order) results[arm].push(await runCase(name, arm, args));
  caseTargetPass = results.base.every(p => !p) && results.cand.every(p => p);
  notes.push(`机制目标 ${name}：改前 ${results.base.filter(Boolean).length}/${runs} 过，改后 ${results.cand.filter(Boolean).length}/${runs} 过`);
  if (!caseTargetPass) reasons.push(results.base.some(Boolean) ? "机制目标：改前也会过，这个用例证明不了改动" : "机制目标：改后没有每次都过");
}

const passes: Pass[] = [];
if (!early && reg.scenarios.length) {
  for (const [pair, order] of shuffled(reg.seed + 1, reg.N).entries()) {
    if (Date.now() - started > reg.budgetMin * 60_000) { notes.push(`预算 ${reg.budgetMin} 分钟用完，只跑了 ${pair}/${reg.N} 对`); break; }
    for (const arm of order) {
      await waitForQuietMachine();
      const args = ["scripts/maintenance/self-use-replay.mts", `--only=${reg.scenarios.join(",")}`, `--label=climb-${reg.name}-${pair + 1}-${arm}`, ...(reg.pool ? [`--pool=${reg.pool}`] : []), ...(reg.model ? [`--model=${reg.model}`] : [])];
      const { out } = await child(args, { SIDEAGENT_ACCEPTANCE_DIST: dists[arm], SIDEAGENT_BUILD_ROLE: arm, SIDEAGENT_RECORD: "0" }, true);
      const report = /报告：(\S+\.md)/.exec(out)?.[1];
      if (!report) { notes.push(`第 ${pair + 1} 对 ${arm} 回放没有出报告`); continue; }
      const json = JSON.parse(readFileSync(report.replace(/\.md$/, ".json"), "utf8")) as { model: { provider: string; modelId: string }; fastModel: string; rows: Row[] };
      passes.push({ arm, pair, report, model: `${json.model.provider}/${json.model.modelId}`, fastModel: json.fastModel, rows: json.rows });
    }
  }
}

const judged = early ? { verdict: early, reasons: [], lines: [] } : reg.scenarios.length ? judge(reg, passes, sentences, caseTargetPass) : { verdict: (caseTargetPass ? "通过" : "证据不足") as Verdict, reasons: [], lines: [] };
const verdict: Verdict = reasons.length && judged.verdict === "通过" ? "证据不足" : judged.verdict;
const allReasons = [...reasons, ...judged.reasons];
const minutes = Math.round((Date.now() - started) / 60_000);
const aa = dists.base === dists.cand;
const report = [
  `# 爬山判定 ${reg.name}：${verdict}`,
  ``,
  `改前 ${dists.base}；改后 ${dists.cand}${aa ? "（同一份构建：A/A 检验，应当判「证据不足」）" : ""}。场景 ${reg.scenarios.join("、") || "无"}，${reg.N} 对，α=${reg.alpha}，用时 ${minutes} 分钟，登记 ${registrationHash}，尺子 ${rulerHead}${rulerDirty ? "（开跑时回放或验收脚本有未提交的改动）" : ""}。`,
  ``,
  ...(allReasons.length ? ["没通过的原因：", ...allReasons.map(r => `- ${r}`), ""] : []),
  ...[...notes, ...judged.lines].map(l => `- ${l}`),
  ``,
  "每遍回放：",
  ...passes.map(p => `- 第 ${p.pair + 1} 对 ${p.arm}：${p.report}`),
].join("\n") + "\n";
await writeFile(join(outDir, "report.md"), report);
await writeFile(join(outDir, "passes.json"), JSON.stringify({ registration: registrationHash, passes }, null, 2), { mode: 0o600 });
await appendFile(join(REPO, "out/hill-climb/ledger.jsonl"), JSON.stringify({ time: new Date().toISOString(), name: reg.name, registration: registrationHash, ruler: rulerHead, rulerDirty, verdict, reasons: allReasons, lines: judged.lines, notes, minutes, aa }) + "\n");
console.log(report);
console.log(`报告：${join(outDir, "report.md")}`);
process.exit(verdict === "通过" ? 0 : verdict === "否决" ? 2 : 3);
