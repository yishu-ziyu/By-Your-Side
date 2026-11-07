import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { REPO } from "./harness.mts";
import { CORE_CASES, PR_CASES, SKIP_FILES as SKIP } from "../nodes.mts";

const HERE = join(REPO, "scripts/acceptance/real-path");

const CORE = process.argv.includes("--pr") ? PR_CASES : CORE_CASES;

const core = process.argv.includes("--core") || process.argv.includes("--pr");

const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));

const only = core ? new Set(CORE) : onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

const cases = (await readdir(HERE))
  .filter((file) => file.endsWith(".mts") && !SKIP.has(file))
  .map((file) => file.replace(/\.mts$/, ""))
  .sort();

const missing = core ? CORE.filter((name) => !cases.includes(name)) : [];

const jobsArg = process.argv.find((arg) => arg.startsWith("--jobs="));
const JOBS = 2;
const jobs = Math.max(1, Number(jobsArg?.slice("--jobs=".length)) || JOBS);

if (missing.length) {
  console.error(`核心用例不存在：${missing.join("、")}`);
  process.exit(1);
}

const outDir = join(REPO, "out/acceptance/real-path");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = new Date().toISOString();
const git = (args: string[]) => { try { return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const commit = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain"]) !== "";

const logDir = join(outDir, `logs-${stamp}`);

await mkdir(logDir, { recursive: true });

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
      env: { SIDEAGENT_RECORD: "0", ...process.env, SIDEAGENT_ACCEPTANCE_DIST: dist },
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
  commit,
  dirty: dirty || git(["status", "--porcelain"]) !== "" || git(["rev-parse", "HEAD"]) !== commit,
  startedAt,
  logDir,
  selectedCases: cases.filter(name => !only || only.has(name)),
  buildSha256: createHash("sha256").update(await readFile(join(dist, "background.js"))).digest("hex"),
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
