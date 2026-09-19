/**
 * product-journeys：T01 完整任务评测集聚合入口。
 *
 *   npx --no-install tsx scripts/acceptance/product-journeys.mts --headless --suite baseline
 *   npx --no-install tsx scripts/acceptance/product-journeys.mts --headless --suite smoke|sample|full
 *   npx --no-install tsx scripts/acceptance/product-journeys.mts --headless --case R01 [--material 1]
 *
 * 串行执行；真实侧栏入口 + 真实模型。结果写 eval/runs/journeys-<suite>-<时间戳>/。
 * 退出码只说明评测器是否执行完所选范围：0=执行完整；1=基础设施失败/未跑完。
 * 产品门槛（productGate）只在 --suite full 时计算，见 summary.json。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../../agent/src/config.js";
import { CASE_BY_ID, suiteRows } from "./product-journeys/cases.mjs";
import { createJourneyFixture } from "./product-journeys/fixtures.mjs";
import { runOne, startHost, startIsolatedPanel, stopHost, type HostHolder } from "./product-journeys/runner.mjs";
import { aggregateRows, type JourneyRow } from "./product-journeys/stats.mjs";
import { REPO_ROOT } from "../eval/lib/verify.js";
import { until } from "./isolated-extension.mts";

if (!process.argv.includes("--headless")) {
  console.error("Required: --headless（本脚本只以无头隔离方式运行）");
  process.exit(2);
}

function arg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`${name}=`)) ?? process.argv.find((a) => a === name && process.argv[process.argv.indexOf(a) + 1]);
  if (!flag) return fallback;
  return flag.includes("=") ? flag.slice(name.length + 1) : process.argv[process.argv.indexOf(flag) + 1];
}

const suite = arg("--suite", "smoke") as "baseline" | "smoke" | "sample" | "full";
const singleCase = arg("--case", "");
const singleMaterial = Number(arg("--material", "0")) as 0 | 1;
const model = arg("--model", loadConfig().model);

if (!existsSync(resolve("extension/dist/manifest.json"))) {
  console.error("extension/dist 不存在：先运行 npm run build");
  process.exit(2);
}

const rows: { caseId: string; material: 0 | 1 }[] = singleCase
  ? [{ caseId: singleCase, material: singleMaterial }]
  : suiteRows(suite);
for (const r of rows) {
  if (!CASE_BY_ID.has(r.caseId)) {
    console.error(`未知用例：${r.caseId}`);
    process.exit(2);
  }
}

const runId = `journeys-${singleCase ? `case-${singleCase}` : suite}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outRoot = join(REPO_ROOT, "eval", "runs", runId);
mkdirSync(outRoot, { recursive: true });

const fixture = createJourneyFixture();
await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));

const events: import("./product-journeys/runner.mjs").RunnerEnv["events"] = [];
const holder: HostHolder = { current: await startHost(model, join(outRoot, "host"), events) };
let evaluatorOk = true;
const results: JourneyRow[] = [];
let iso: Awaited<ReturnType<typeof startIsolatedPanel>>["iso"] | undefined;

try {
  const session = holder.current.manager.get("default")?.runtime.session;
  if (!session?.available) throw new Error(`模型不可用：${model}`);
  const started = await startIsolatedPanel(holder.current);
  iso = started.iso;
  const panel = started.panel;

  const env = {
    iso,
    panel,
    fixture,
    host: holder,
    events,
    model,
    outRoot: outRoot,
    restartHost: async () => {
      const token = holder.current.token;
      const port = holder.current.port;
      const storeDir = join(outRoot, "host");
      await stopHost(holder.current);
      holder.current = await startHost(model, storeDir, events, token, port);
      await iso!.evalIn(panel, "window.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
      await until(() => holder.current.socket?.readyState === 1 || undefined, 30_000, "host reconnected");
    },
  };

  writeFileSync(join(outRoot, "plan.json"), JSON.stringify({ runId, suite: singleCase ? "case" : suite, model, rows }, null, 2));

  for (const { caseId, material } of rows) {
    const jc = CASE_BY_ID.get(caseId)!;
    const mat = jc.materials[material];
    let row: JourneyRow;
    try {
      const result = await runOne(env, jc, mat);
      row = result.row;
    } catch (error) {
      evaluatorOk = false;
      row = {
        caseId, family: jc.family, materialId: mat.materialId, started: true,
        status: "fail", qualified: false, safetyVeto: false,
        totalMs: null, waitedMs: 0,
        interventions: { planned: 0, forced: 1, reasons: [`运行器异常：${error instanceof Error ? error.message : error}`] },
        reason: `runner error: ${error instanceof Error ? error.message : error}`,
      };
    }
    results.push(row);
    console.log(JSON.stringify({ caseId, material, qualified: row.qualified, status: row.status, safetyVeto: row.safetyVeto, totalMs: row.totalMs, waitedMs: row.waitedMs, reason: row.reason.slice(0, 300) }));
    writeFileSync(join(outRoot, "progress.json"), JSON.stringify({ runId, done: results.length, total: rows.length }, null, 2));
  }
  // 未跑到的臂显式记为 not_run：不从分母消失，也不冒充有结果
  for (const { caseId, material } of rows.slice(results.length)) {
    const jc = CASE_BY_ID.get(caseId)!;
    results.push({
      caseId, family: jc.family, materialId: jc.materials[material].materialId, started: false,
      status: "not_run", qualified: false, safetyVeto: false, totalMs: null, waitedMs: 0,
      interventions: { planned: 0, forced: 0, reasons: [] }, reason: "评测器中断，本臂未执行",
    });
  }
} catch (error) {
  evaluatorOk = false;
  console.error(`基础设施失败：${error instanceof Error ? error.message : error}`);
} finally {
  await iso?.close().catch(() => {});
  await stopHost(holder.current).catch(() => {});
  await fixture.close().catch(() => {});
}

const expectedKeys = rows.map(({ caseId, material }) => `${caseId}|${CASE_BY_ID.get(caseId)!.materials[material].materialId}`);
const aggregate = aggregateRows(results, singleCase ? "case" : suite, evaluatorOk, expectedKeys);
writeFileSync(join(outRoot, "summary.json"), JSON.stringify({ runId, model, suite: singleCase ? "case" : suite, aggregate, rows: results }, null, 2));
console.log(JSON.stringify({ runId, outDir: outRoot, aggregate }, null, 0));
process.exit(evaluatorOk && results.length === rows.length ? 0 : 1);
