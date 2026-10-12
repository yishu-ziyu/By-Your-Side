/**
 * 真实路径用例的运行流水，harness.mts 导入时生效（2026-10-12 复盘，docs/evals/20261012-test-runs-ledger.md）。
 *
 * - 每次运行在 out/acceptance/real-path/runs.jsonl 记一行：用例、参数、代码状态、通过与否、耗时。`npm run runs` 汇总。
 * - 同一用例、同样参数、同样代码已经失败 2 次，就拒绝第 3 次：再跑只是在测模型的随机性。确实要跑时加 BYS_RERUN=1。
 *   Ctrl-C 或被杀掉的运行不进流水，所以也不计入失败。
 * - 清理 7 天前、没被 docs/scripts/eval 引用的运行目录。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CASES = join(REPO, "scripts/acceptance/real-path");
const OUT = join(REPO, "out/acceptance/real-path");
// 流水记在主目录，所以各个工作树的运行算在同一本账上。
const MAIN = mainCheckout();
const MAIN_OUT = join(MAIN, "out/acceptance/real-path");
const LEDGER = join(MAIN_OUT, "runs.jsonl");
const KEEP_DAYS = 7;
const MAX_SAME_FAILURES = 2;

const script = process.argv[1] ? resolve(process.argv[1]) : "";
const name = basename(script).replace(/\.mts$/, "");

if (dirname(script) === CASES && !["harness", "run-all"].includes(name)) start();

function mainCheckout() {
  try {
    return dirname(resolve(REPO, git(["rev-parse", "--git-common-dir"]).trim()));
  } catch {
    return REPO;
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

// 代码状态 = HEAD + 未提交改动。只要改过代码，指纹就变，失败计数从零开始。
function codeState() {
  try {
    const dirty = git(["diff", "HEAD"]) + git(["status", "--porcelain"]);
    return `${git(["rev-parse", "--short", "HEAD"]).trim()}${dirty ? `+${createHash("sha256").update(dirty).digest("hex").slice(0, 8)}` : ""}`;
  } catch {
    return "unknown";
  }
}

function readLedger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// 引用同时查工作树和主目录，包括还没提交的文件：主目录里新写的文档也可能引用旧运行。
function citations() {
  const found = [];
  for (const cwd of new Set([REPO, MAIN])) {
    try {
      found.push(execFileSync("git", ["grep", "--untracked", "-ohE", "out/acceptance/real-path/[^ )`'\"]+", "--", "docs", "scripts", "eval"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
    } catch (error) {
      if (error.status !== 1) return null; // 查引用出错时不删任何东西；1 只表示没有匹配
    }
  }
  return found.join("\n");
}

function prune(out, cited) {
  const keep = cited.split("\n").filter(Boolean).map((ref) => ref.slice("out/acceptance/real-path/".length).split("/")[0])
    // 只认带日期的具体运行；`*`、`<时间>-<用例>` 这类写法是在说明用法，不是引用证据。
    .filter((part) => /^\d{4}-\d\d-\d\d/.test(part))
    .map((part) => new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  let removed = 0;

  if (!existsSync(out)) return;
  for (const dir of readdirSync(out, { withFileTypes: true })) {
    const day = dir.name.slice(0, 10);
    if (!dir.isDirectory() || !/^\d{4}-\d\d-\d\d$/.test(day) || day >= cutoff) continue;
    if (keep.some((pattern) => pattern.test(dir.name))) continue;
    rmSync(join(out, dir.name), { recursive: true, force: true });
    removed += 1;
  }

  if (removed) console.log(`[runs] 清理了 ${out} 里 ${removed} 个 ${KEEP_DAYS} 天前、没被文档引用的运行目录`);
}

function start() {
  mkdirSync(MAIN_OUT, { recursive: true });
  const args = process.argv.slice(2).filter((arg) => arg !== "--headless");
  const state = codeState();
  const same = (row) => row.case === name && row.args.join(" ") === args.join(" ") && row.code === state;
  const failures = readLedger().filter((row) => same(row) && row.ok === false).length;

  if (failures >= MAX_SAME_FAILURES && process.env.BYS_RERUN !== "1") {
    console.error(
      `[runs] ${name} 在同样的代码上已经失败 ${failures} 次，这次不跑：再跑只是在测模型的随机性。\n` +
        `       先看上两次的失败原因（npm run runs，或 out/acceptance/real-path/ 里最新的 *-${name}*）。确实要再跑：BYS_RERUN=1。`,
    );
    appendFileSync(LEDGER, `${JSON.stringify({ case: name, args, code: state, at: new Date().toISOString(), ok: null, blocked: true, seconds: 0 })}\n`);
    process.exit(2);
  }

  try {
    const cited = citations();
    if (cited !== null) for (const out of new Set([OUT, MAIN_OUT])) prune(out, cited);
  } catch (error) {
    console.error(`[runs] 清理旧目录失败：${error.message}`);
  }

  const startedAt = Date.now();
  process.on("exit", (code) => {
    const exit = code ?? process.exitCode ?? 0;
    // 退出码 2 是用法错误或前提不满足（没加 --headless、缺凭据），用例没真正跑，不算失败。
    const ok = exit === 0 ? true : exit === 2 ? null : false;
    appendFileSync(LEDGER, `${JSON.stringify({ case: name, args, code: state, at: new Date(startedAt).toISOString(), ok, seconds: Math.round((Date.now() - startedAt) / 1000) })}\n`);
  });
}
