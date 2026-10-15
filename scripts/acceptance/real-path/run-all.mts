/**
 * 真实路径用例一次跑完：串行执行本目录下每个用例（harness 与本文件除外），全部无头。
 * 每个用例仍各自留证在 out/acceptance/real-path/<时间>-<用例>/；这里只汇总退出码与耗时。
 *
 *   npm run accept:real-path
 *   npm run accept:real-path -- --only=codename-no-save,data-to-file
 *   npm test                      # 只跑 CORE：一批改动跑一遍（更新日常扩展前），不要凭据
 *   --jobs=N                      # 同时跑几个用例，默认见 JOBS
 *
 * 任一用例失败则整体退出码为 1。被 --only 过滤掉的用例记为未跑，不算通过。
 * 每个用例本来就用自己的临时浏览器配置和随机端口，所以能同时跑；扩展只在开头构建一次，各用例拷一份。
 * 同时跑时各用例的输出写进日志文件，失败的才把日志末尾打出来。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./harness.mts";

const HERE = join(REPO, "scripts/acceptance/real-path");

// background-tab-input 只能在有窗口的 Chrome 里跑（会弹窗），不进整轮。
const SKIP = new Set(["harness.mts", "run-all.mts", "background-tab-input.mts"]);

// 核心用户路径（一批改动跑一遍）：只装扩展、脚本模型、无需凭据。选择依据见 docs/evals/20261008-e2e-only.md。
const CORE = [
  "sidebar-interaction", "composer-expand", "script-friction", "target-gone", "pdf-download", "memory-used-line",
  "session-durability", "error-recovery", "model-failover", "welcome-context", "claim-after-check", "refill-after-check", "readback-privacy", "snapshot-privacy",
  "send-confirm", "pay-stop", "handoff", "answer-straight", "retry-after-unknown", "site-hint", "panel-tidy", "keep-foreground", "navigate-wait",
  "double-click-new-tab", "reading-correction", "http-page-select", "reading-card-after-reinject", "click-blocked-reason", "settle-after-requests", "slot-yields-to-new-task", "history-prefix", "program-receipt", "process-block", "overflow-retry",
];

const core = process.argv.includes("--core");

const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));

const only = core ? new Set(CORE) : onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

const cases = (await readdir(HERE))
  .filter((file) => file.endsWith(".mts") && !SKIP.has(file))
  .map((file) => file.replace(/\.mts$/, ""))
  .sort();

const missing = core ? CORE.filter((name) => !cases.includes(name)) : [];

const jobsArg = process.argv.find((arg) => arg.startsWith("--jobs="));
// 2 路：10-14 实测核心 33 例 891s → 464s，只多出 session-durability 一处超时；4 路在机器忙时扩展启动超时成片。
const JOBS = 2;
const jobs = Math.max(1, Number(jobsArg?.slice("--jobs=".length)) || JOBS);

if (missing.length) {
  console.error(`核心用例不存在：${missing.join("、")}`);
  process.exit(1);
}

const outDir = join(REPO, "out/acceptance/real-path");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const logDir = join(outDir, `logs-${stamp}`);

await mkdir(logDir, { recursive: true });

// 扩展构建一次：几十个用例各构建一遍既慢，又可能各自构建到改了一半的代码（AGENTS.md 测试与等待）。
let dist = process.env.SIDEAGENT_ACCEPTANCE_DIST;

if (!dist) {
  dist = join(await mkdtemp(join(tmpdir(), "sideagent-suite-dist-")), "extension");
  execFileSync(process.execPath, [join(REPO, "extension/build.mjs")], { env: { ...process.env, SIDEAGENT_BUILD_DIST: dist }, stdio: ["ignore", "ignore", "inherit"] });
}

type Row = { name: string; status: "pass" | "fail" | "not-run"; exitCode: number | null; seconds: number };

async function runCase(name: string): Promise<Row> {
  if (only && !only.has(name)) return { name, status: "not-run", exitCode: null, seconds: 0 };

  const started = Date.now();
  const logFile = join(logDir, `${name}.log`);
  const log = await open(logFile, "w");
  const exitCode = await new Promise<number | null>((done) => {
    const child = spawn("npx", ["--no-install", "tsx", join(HERE, `${name}.mts`), "--headless"], {
      cwd: REPO,
      env: { ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dist },
      stdio: ["ignore", log.fd, log.fd],
    });
    child.on("close", (code) => done(code));
    child.on("error", () => done(null));
  });
  await log.close();

  const seconds = Math.round((Date.now() - started) / 1000);
  const status = exitCode === 0 ? ("pass" as const) : ("fail" as const);

  console.log(`${status === "pass" ? "✔" : "✘"} ${name} (${seconds}s)`);

  if (status === "fail") {
    const tail = (await readFile(logFile, "utf8")).trimEnd().split("\n").slice(-15).join("\n");
    console.log(`  ${logFile}\n${tail.replace(/^/gm, "  │ ")}`);
  }

  return { name, status, exitCode, seconds };
}

const queue = [...cases];
const results: Row[] = [];
const suiteStarted = Date.now();

await Promise.all(Array.from({ length: jobs }, async () => {
  for (let name = queue.shift(); name; name = queue.shift()) results.push(await runCase(name));
}));

results.sort((a, b) => a.name.localeCompare(b.name));

const summary = {
  runKind: core ? "core" : only ? "filtered" : "full",
  jobs,
  wallSeconds: Math.round((Date.now() - suiteStarted) / 1000),
  ok: (core || !only) && results.every((row) => row.status !== "fail") && results.some((row) => row.status === "pass"),
  results,
};

await mkdir(outDir, { recursive: true });

await writeFile(join(outDir, `summary-${stamp}.json`), JSON.stringify(summary, null, 2));

console.table(results);
console.log(`同时跑 ${jobs} 个，整轮 ${summary.wallSeconds}s。日志：${logDir}`);

process.exit(results.some((row) => row.status === "fail") ? 1 : 0);
