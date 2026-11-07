import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceReport } from "./acceptance-report.mjs";

const control = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(process.argv[2] ?? ".");
const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const out = join(repo, "out/dev-pipeline-ci");
const startedAt = new Date().toISOString();
await mkdir(out, { recursive: true });
const receipt = { status: "fail", commit: git(["rev-parse", "HEAD"]), controllerCommit: git(["rev-parse", "HEAD"], control), runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), cases: [], checks: [], buildSha256: null, reportStatus: null, startedAt };

function run(name, bin, args, env = {}) {
  const file = openSync(join(out, `${name}.log`), "w", 0o600);
  const started = Date.now();
  try {
    const environment = { PATH: process.env.PATH, HOME: "/home/bys-worker", GIT_OPTIONAL_LOCKS: "0", CI: "true", EGO_ACCEPTANCE_CHROME: process.env.EGO_ACCEPTANCE_CHROME, ...env };
    const result = spawnSync("sudo", ["-u", "bys-worker", "--", "env", ...Object.entries(environment).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`), bin, ...args], { cwd: repo, stdio: ["ignore", file, file], timeout: 600_000 });
    const check = { name, exitCode: result.status, signal: result.signal, seconds: Math.round((Date.now() - started) / 1000), passed: result.status === 0 && !result.error };
    receipt.checks.push(check);
    console.log(`${name}: ${check.passed ? "PASS" : "FAIL"}`);
    return check.passed;
  } finally { closeSync(file); }
}

try {
  if (process.env.GITHUB_ACTIONS !== "true" || repo === control) throw new Error("验收只在临时 CI 机器执行，控制器与待验收代码分开检出");
  if (spawnSync("sudo", ["-u", "bys-worker", "--", "test", "!", "-w", fileURLToPath(import.meta.url)]).status !== 0) throw new Error("候选执行用户能修改控制器，拒绝验收");
  if (spawnSync("sudo", ["-u", "bys-worker", "--", "sudo", "-n", "true"], { stdio: "ignore" }).status === 0) throw new Error("候选执行用户可以提权，拒绝验收");
  if (process.env.BYS_PIPELINE_EXPECTED_COMMIT !== receipt.commit) throw new Error("CI 检出的不是指定提交");
  const task = JSON.parse(await readFile(join(repo, ".dev-pipeline-task.json"), "utf8"));
  if (task.controllerCommit !== receipt.controllerCommit || typeof task.title !== "string" || !Array.isArray(task.cases) || task.cases.length > 12 || new Set(task.cases).size !== task.cases.length || task.cases.some(name => typeof name !== "string" || !/^[a-z0-9-]+$/.test(name))) throw new Error("任务单或控制器版本不符");
  receipt.cases = task.cases;
  if (git(["status", "--porcelain"])) throw new Error("初始代码不是干净版本");
  const candidatePackage = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  const controlPackage = JSON.parse(await readFile(join(control, "package.json"), "utf8"));
  for (const name of ["check:code", "check:hardcoded-matching", "check:comments", "typecheck", "build"]) if (candidatePackage.scripts[name] !== controlPackage.scripts[name]) throw new Error(`不能在执行任务中修改验收命令：${name}`);
  if (run("code", "npm", ["run", "check:code"])) {
    const built = join(repo, "extension/dist/background.js");
    receipt.buildSha256 = sha256(await readFile(built));
    const changed = git(["diff", "--name-only", task.controllerCommit, receipt.commit]).split("\n");
    if (changed.some(file => /^extension\/src\/(sidepanel|content)/.test(file))) {
      run("ui", "npm", ["run", "check:ui"]);
      run("copy", "npm", ["run", "check:copy"]);
    }
    if (changed.some(file => /^(shared|agent\/src)\//.test(file))) run("architecture", "npm", ["run", "check:architecture"]);
    if (receipt.checks.every(check => check.passed) && task.cases.length) {
      const suite = join(repo, "out/acceptance/real-path");
      const before = new Set(await readdir(suite).catch(error => { if (error.code === "ENOENT") return []; throw error; }));
      run("acceptance", "npx", ["--no-install", "tsx", "scripts/acceptance/real-path/run-all.mts", `--only=${task.cases.join(",")}`, "--jobs=1"], { SIDEAGENT_ACCEPTANCE_DIST: join(repo, "extension/dist"), SIDEAGENT_RECORD: "1" });
      const summaries = (await readdir(suite)).filter(file => /^summary-.*\.json$/.test(file) && !before.has(file));
      if (summaries.length !== 1) throw new Error("本轮没有交回唯一的验收摘要");
      if (sha256(await readFile(built)) !== receipt.buildSha256) throw new Error("验收期间构建内容发生变化");
      const report = await createAcceptanceReport({ repo, summary: join(suite, summaries[0]), output: join(out, "report"), title: task.title, expectedCommit: receipt.commit, expectedCases: task.cases, expectedBuildSha256: receipt.buildSha256 });
      receipt.reportStatus = report.status;
      receipt.reportManifestSha256 = sha256(await readFile(report.manifest));
    } else if (!task.cases.length) receipt.reportStatus = "code-only";
    if (git(["status", "--porcelain"]) || git(["rev-parse", "HEAD"]) !== receipt.commit || git(["status", "--porcelain"], control)) throw new Error("验收期间源代码或控制器发生变化");
    if (receipt.checks.every(check => check.passed) && ["pass", "code-only"].includes(receipt.reportStatus)) receipt.status = "pass";
  }
} catch (error) {
  receipt.error = error.message;
  console.error(error.message);
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(out, "verification.json"), JSON.stringify(receipt, null, 2));
  const summary = `## 自动开发验收\n\n${receipt.status === "pass" ? "通过" : "未通过"}；提交 \`${receipt.commit}\`。\n\n${receipt.checks.map(check => `- ${check.name}：${check.passed ? "通过" : "未通过"}`).join("\n")}\n\n${receipt.error ?? (receipt.reportStatus === "code-only" ? "只做代码检查，没有浏览器截图或录屏验收。" : `下载 dev-pipeline-report-${receipt.runAttempt} 后打开 report/index.html 查看截图与录屏。`)}\n`;
  await writeFile(join(out, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
}
if (receipt.status !== "pass") process.exitCode = 1;
