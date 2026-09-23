/**
 * 真实路径用例一次跑完：串行执行本目录下每个用例（harness 与本文件除外），全部无头。
 * 每个用例仍各自留证在 out/acceptance/real-path/<时间>-<用例>/；这里只汇总退出码与耗时。
 *
 *   npm run accept:real-path
 *   npm run accept:real-path -- --only=codename-no-save,point-then-mark
 *
 * 任一用例失败则整体退出码为 1。被 --only 过滤掉的用例记为未跑，不算通过。
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO } from "./harness.mts";

const HERE = join(REPO, "scripts/acceptance/real-path");

const SKIP = new Set(["harness.mts", "run-all.mts"]);

const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));

const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

const cases = (await readdir(HERE))
  .filter((file) => file.endsWith(".mts") && !SKIP.has(file))
  .map((file) => file.replace(/\.mts$/, ""))
  .sort();

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
  runKind: only ? "filtered" : "full",
  ok: !only && results.every((row) => row.status === "pass"),
  results,
};

await mkdir(outDir, { recursive: true });

await writeFile(join(outDir, `summary-${stamp}.json`), JSON.stringify(summary, null, 2));

console.table(results);

process.exit(results.some((row) => row.status === "fail") ? 1 : 0);
