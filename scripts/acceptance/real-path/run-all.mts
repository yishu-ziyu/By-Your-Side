/**
 * 真实路径用例一次跑完：串行执行本目录下每个用例（harness 与本文件除外），全部无头。
 * 每个用例仍各自留证在 out/acceptance/real-path/<时间>-<用例>/；这里只汇总退出码与耗时。
 *
 *   npm run accept:real-path
 *   npm run accept:real-path -- --only=codename-no-save,data-to-file
 *   npm test                      # 只跑 CORE：合并前必跑，不要凭据
 *
 * 任一用例失败则整体退出码为 1。被 --only 过滤掉的用例记为未跑，不算通过。
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO } from "./harness.mts";

const HERE = join(REPO, "scripts/acceptance/real-path");

const SKIP = new Set(["harness.mts", "run-all.mts"]);

// 合并前必跑的核心用户路径：只装扩展、脚本模型、无需凭据。选择依据见 docs/evals/20261008-e2e-only.md。
const CORE = [
  "sidebar-interaction", "script-friction", "target-gone", "run-check", "pdf-download", "memory-used-line",
  "session-durability", "error-recovery", "model-failover", "welcome-context", "claim-after-check", "refill-after-check", "readback-privacy", "snapshot-privacy",
  "send-confirm", "pay-stop", "submit-check",
];

const core = process.argv.includes("--core");

const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));

const only = core ? new Set(CORE) : onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

const cases = (await readdir(HERE))
  .filter((file) => file.endsWith(".mts") && !SKIP.has(file))
  .map((file) => file.replace(/\.mts$/, ""))
  .sort();

const missing = core ? CORE.filter((name) => !cases.includes(name)) : [];

if (missing.length) {
  console.error(`核心用例不存在：${missing.join("、")}`);
  process.exit(1);
}

const results = cases.map((name) => {
  if (only && !only.has(name)) return { name, status: "not-run" as const, exitCode: null, seconds: 0 };

  const started = Date.now();
  console.log(`▶ ${name}`);

  const run = spawnSync("npx", ["--no-install", "tsx", join(HERE, `${name}.mts`), "--headless"], {
    cwd: REPO,
    stdio: "inherit",
  });

  const seconds = Math.round((Date.now() - started) / 1000);
  const status = run.status === 0 ? ("pass" as const) : ("fail" as const);

  console.log(`${status === "pass" ? "✔" : "✘"} ${name} (${seconds}s)`);

  return { name, status, exitCode: run.status, seconds };
});

const outDir = join(REPO, "out/acceptance/real-path");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const summary = {
  runKind: core ? "core" : only ? "filtered" : "full",
  ok: (core || !only) && results.every((row) => row.status !== "fail") && results.some((row) => row.status === "pass"),
  results,
};

await mkdir(outDir, { recursive: true });

await writeFile(join(outDir, `summary-${stamp}.json`), JSON.stringify(summary, null, 2));

console.table(results);

process.exit(results.some((row) => row.status === "fail") ? 1 : 0);
