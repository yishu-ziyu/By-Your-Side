import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { REPO, sleep } from "../acceptance/real-path/harness.mts";
import { type Arm, type Pass, type Verdict, judge, registrationOf, replayModelArgs, shuffled } from "./climb-rules.mts";
import { firstAnswerMsOf, poolOf, readingsOf, readingsTable, recordsOf, type Row } from "./replay-row.mts";

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
const pairsArg = process.argv.find(a => a.startsWith("--pairs="))?.slice(8);
const onlyPairs = pairsArg ? new Set(pairsArg.split(",").map(Number)) : null;
const mergeDirs = process.argv.find(a => a.startsWith("--merge="))?.slice(8).split(",").filter(Boolean) ?? null;
const skipRedLines = process.argv.includes("--skip-red-lines") || !!mergeDirs;
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
const outDir = join(REPO, "out/hill-climb", onlyPairs ? `${reg.name}-pairs-${[...onlyPairs].join("-")}` : reg.name);
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

for (const name of skipRedLines ? [] : reg.redLines) {
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
if (mergeDirs) {
  for (const dir of mergeDirs) {
    const shard = JSON.parse(readFileSync(join(resolve(REPO, dir), "passes.json"), "utf8")) as { registration: string; passes: Pass[] };
    if (shard.registration !== registrationHash) throw new Error(`${dir} 的登记 ${shard.registration} 与本次登记 ${registrationHash} 不同，不能合并`);
    for (const pass of shard.passes) {
      if (passes.some(p => p.pair === pass.pair && p.arm === pass.arm)) throw new Error(`第 ${pass.pair + 1} 对 ${pass.arm} 在多个分片里都有，不能合并`);
      passes.push(pass);
    }
  }
  notes.push(`合并 ${mergeDirs.length} 个分片：${mergeDirs.join("、")}；红线由各分片之外单独运行`);
} else if (!early && reg.scenarios.length) {
  for (const [pair, order] of shuffled(reg.seed + 1, reg.N).entries()) {
    if (onlyPairs && !onlyPairs.has(pair)) continue;
    if (Date.now() - started > reg.budgetMin * 60_000) { notes.push(`预算 ${reg.budgetMin} 分钟用完，只跑了 ${pair}/${reg.N} 对`); break; }
    for (const arm of order) {
      await waitForQuietMachine();
      const args = ["scripts/maintenance/self-use-replay.mts", `--only=${reg.scenarios.join(",")}`, `--label=climb-${reg.name}-${pair + 1}-${arm}`, ...(reg.pool ? [`--pool=${reg.pool}`] : []), ...replayModelArgs(reg)];
      const { code, out } = await child(args, { SIDEAGENT_ACCEPTANCE_DIST: dists[arm], SIDEAGENT_BUILD_ROLE: arm, SIDEAGENT_RECORD: "0" }, true);
      if (code !== 0) { notes.push(`第 ${pair + 1} 对 ${arm} 回放退出码 ${code ?? "未返回"}`); continue; }
      const report = /报告：(\S+\.md)/.exec(out)?.[1];
      if (!report) { notes.push(`第 ${pair + 1} 对 ${arm} 回放没有出报告`); continue; }
      const json = JSON.parse(readFileSync(report.replace(/\.md$/, ".json"), "utf8")) as { model: { provider: string; modelId: string }; fastModel: string; effort?: string; rows: Row[] };
      passes.push({ arm, pair, report, model: `${json.model.provider}/${json.model.modelId}`, fastModel: json.fastModel, effort: json.effort, rows: json.rows });
    }
  }
}

const judged = early ? { verdict: early, reasons: [], lines: [] } : reg.scenarios.length ? judge(reg, passes, sentences, caseTargetPass) : { verdict: (caseTargetPass ? "通过" : "证据不足") as Verdict, reasons: [], lines: [] };
const verdict: Verdict = reasons.length && judged.verdict === "通过" ? "证据不足" : judged.verdict;
const allReasons = [...reasons, ...judged.reasons];
const minutes = Math.round((Date.now() - started) / 60_000);
const rowsWithFirstAnswer = (pass: Pass): Row[] => pass.rows.map(row => {
  const trace = join(pass.report.replace(/\.md$/, ""), `${row.n}-${row.k}.trace.jsonl`);
  if (!row.timing || row.timing.firstAnswerMs !== undefined || !existsSync(trace)) return row;
  return { ...row, timing: { ...row.timing, firstAnswerMs: firstAnswerMsOf(recordsOf(readFileSync(trace, "utf8").split("\n")), new Set(row.runIds ?? []), row.timing.finalAnswerMs !== null) } };
});
const plannedSentences = (onlyPairs && !mergeDirs ? onlyPairs.size : reg.N) * reg.scenarios.reduce((total, n) => total + (sentences.get(n) ?? 0), 0);
const readingLines = passes.length ? ["", ...readingsTable((["base", "cand"] as const).map(arm => [arm === "base" ? "改前" : "改后", readingsOf(passes.filter(p => p.arm === arm).flatMap(rowsWithFirstAnswer), plannedSentences)]))] : [];
const aa = dists.base === dists.cand;
const report = [
  `# 爬山判定 ${reg.name}：${verdict}`,
  ``,
  `改前 ${dists.base}；改后 ${dists.cand}${aa ? "（同一份构建：A/A 检验，应当判「证据不足」）" : ""}。场景 ${reg.scenarios.join("、") || "无"}，${reg.N} 对，α=${reg.alpha}，用时 ${minutes} 分钟，登记 ${registrationHash}，尺子 ${rulerHead}${rulerDirty ? "（开跑时回放或验收脚本有未提交的改动）" : ""}。`,
  ``,
  ...(reg.scenarios.length ? [`回放配置 ${replayModelArgs(reg).join(" ") || "沿用现有回放默认值"}。`, ""] : []),
  ...(allReasons.length ? ["没通过的原因：", ...allReasons.map(r => `- ${r}`), ""] : []),
  ...[...notes, ...judged.lines].map(l => `- ${l}`),
  ...readingLines,
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
