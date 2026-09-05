#!/usr/bin/env node
/**
 * 真实浏览器验收：只连接 local.yishu.chrome-main 的 ChromeMain CDP，
 * 在已加载 SideAgent service worker 内用 chrome.debugger / content script
 * 完成 snapshot → click → fill → 再 snapshot。
 * 不启动 Chrome，不 attach 普通页面，不用 Playwright 点选。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COUNTER_AFTER,
  DEFAULT_RUNS,
  FILL_AFTER,
  FILL_VALUE,
  INC_BUTTON_ID,
  INPUT_ID,
  PHASE_CHANGED,
  STEP_TIMEOUT_MS,
  UNIQUE_TEXT,
  recoveryChromeMain,
  recoveryExtension,
  sideagentExtensionId,
} from "./constants.mjs";
import { connectBrowser, evaluateInWorker, fetchJson, findServiceWorker } from "./cdp.mjs";
import { discoverChromeMain } from "./discover.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import { redactEvidence } from "./redact.mjs";
import { buildResultJson, evaluateRun, formatRun } from "./result.mjs";
import { buildDriverExpression } from "./sw-driver.mjs";
import { installExecuteToolCallHook } from "./sw-hook.mjs";

function parseRuns(argv) {
  const flag = argv.find((a) => a.startsWith("--runs="));
  if (flag) {
    const n = Number(flag.slice("--runs=".length));
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("--runs 必须是 1..20 的整数");
    return n;
  }
  const env = Number(process.env.ACCEPT_RUNS ?? DEFAULT_RUNS);
  if (!Number.isInteger(env) || env < 1) return DEFAULT_RUNS;
  return env;
}

function evidenceRoot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(tmpdir(), `sideagent-acceptance-${stamp}`);
}

async function writePng(dir, name, b64) {
  if (!b64) return null;
  const file = join(dir, name);
  await writeFile(file, Buffer.from(b64, "base64"));
  return name;
}

async function writeRunEvidence(dir, evaluated, driver, connection, extra) {
  await mkdir(dir, { recursive: true });
  const shots = [];
  for (const key of ["before", "afterClick", "afterFill"]) {
    const name = await writePng(dir, `${key}.png`, driver.screenshots?.[key]);
    if (name) shots.push(name);
  }
  const json = buildResultJson({
    ok: evaluated.ok,
    startedAt: evaluated.startedAt,
    elapsedMs: evaluated.elapsedMs,
    runs: [
      {
        steps: evaluated.steps,
        failureCategory: evaluated.failureCategory,
        failureStage: evaluated.failureStage,
      },
    ],
    connection,
    execution: extra.execution,
    failureCategory: evaluated.failureCategory,
    failureStage: evaluated.failureStage,
    evidenceDir: dir,
    screenshots: shots,
  });
  await writeFile(join(dir, "result.json"), `${JSON.stringify(json, null, 2)}\n`);
  return { json, shots };
}

async function main() {
  const runs = parseRuns(process.argv.slice(2));
  const root = process.env.ACCEPT_EVIDENCE_DIR || evidenceRoot();
  await mkdir(root, { recursive: true });

  const lines = [];
  const say = (line) => {
    lines.push(line);
    console.log(line);
  };

  let connection;
  try {
    connection = discoverChromeMain();
    say(
      `PASS connect ${connection.wrapperBundleId} pid=${connection.pid} port=${connection.port} userDataDir=ChromeMain`,
    );
    if (connection.refusedDefaultChromePids.length) {
      say(`  note refused com.google.Chrome default pids=${connection.refusedDefaultChromePids.join(",")}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    say(`FAIL connect chrome-main`);
    say(msg);
    const payload = buildResultJson({
      ok: false,
      startedAt: Date.now(),
      elapsedMs: 0,
      runs: [],
      connection: null,
      execution: { via: "none" },
      failureCategory: e?.failureCategory ?? "chrome_main_not_found",
      failureStage: "connect",
      evidenceDir: root,
      screenshots: [],
    });
    await writeFile(join(root, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
    console.error(`evidence: ${root}`);
    process.exitCode = 1;
    return;
  }

  let extId;
  try {
    extId = sideagentExtensionId();
  } catch (e) {
    say(`FAIL extension id: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  let cdp;
  try {
    const browser = await connectBrowser(connection.port);
    cdp = browser.cdp;
    say(`PASS cdp ${browser.version.Browser ?? ""}`);
  } catch (e) {
    say(`FAIL cdp ${e instanceof Error ? e.message : e}`);
    say(recoveryChromeMain());
    await writeFile(
      join(root, "result.json"),
      `${JSON.stringify(
        buildResultJson({
          ok: false,
          startedAt: Date.now(),
          elapsedMs: 0,
          runs: [],
          connection: { pid: connection.pid, port: connection.port, wrapperBundleId: connection.wrapperBundleId },
          execution: { via: "none" },
          failureCategory: "cdp_connect_failed",
          failureStage: "cdp",
          evidenceDir: root,
          screenshots: [],
        }),
        null,
        2,
      )}\n`,
    );
    console.error(`evidence: ${root}`);
    process.exitCode = 1;
    return;
  }

  const execution = {
    via: "uplink.handleRaw → onServerMessage → executeToolCall → gate.run → handlers",
    snapshot: "handlers.snapshot",
    click: "handlers.click",
    fill: "handlers.fill",
    screenshot: "handlers.screenshot",
  };

  let fixture;
  const runRecords = [];
  let overallOk = true;
  let failureCategory = null;
  let failureStage = null;

  try {
    const targets = await cdp.send("Target.getTargets");
    let sw = findServiceWorker(targets.targetInfos ?? targets, extId);
    if (!sw) {
      try {
        const listed = await fetchJson(`http://127.0.0.1:${connection.port}/json/list`);
        sw = findServiceWorker(listed, extId);
      } catch {
        sw = undefined;
      }
    }
    if (!sw) {
      say(`FAIL extension service worker`);
      say(recoveryExtension(extId));
      overallOk = false;
      failureCategory = "extension_not_found";
      failureStage = "extension";
      throw new Error("extension_not_found");
    }
    const swId = sw.targetId ?? sw.id;
    say(`PASS extension ${extId} service_worker`);
    const sessionId = await cdp.attachSession(swId);
    await cdp.send("Runtime.enable", {}, sessionId);
    fixture = await startFixtureServer();
    try {
      const hooked = await installExecuteToolCallHook(
        cdp,
        sessionId,
        extId,
        `${fixture.origin}/index.html?hook=1`,
      );
      say(`PASS executeToolCall hook already=${Boolean(hooked.already)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      say(`FAIL executeToolCall hook`);
      say(msg);
      overallOk = false;
      failureCategory = "extension_not_found";
      failureStage = "executeToolCall";
      throw e;
    }
    const startedAll = Date.now();

    for (let i = 1; i <= runs; i++) {
      const url = `${fixture.origin}/index.html?run=${i}&t=${Date.now()}`;
      const expression = buildDriverExpression({
        url,
        incSelector: `#${INC_BUTTON_ID}`,
        inputSelector: `#${INPUT_ID}`,
        fillValue: FILL_VALUE,
        sessionId: "acpt",
        timeoutMs: STEP_TIMEOUT_MS,
      });
      let driver;
      try {
        driver = await evaluateInWorker(cdp, sessionId, expression, STEP_TIMEOUT_MS + 10_000);
      } catch (e) {
        driver = {
          error: e instanceof Error ? e.message : String(e),
          stage: "sw_evaluate",
          snapshots: {},
          screenshots: {},
          durationsMs: {},
          startedAt: Date.now(),
          elapsedMs: 0,
        };
      }
      const evaluated = evaluateRun(driver);
      const runDir = join(root, `run-${i}`);
      const evidence = await writeRunEvidence(runDir, evaluated, driver ?? {}, connection, { execution });
      runRecords.push({
        index: i,
        ok: evaluated.ok,
        failureCategory: evaluated.failureCategory,
        failureStage: evaluated.failureStage,
        steps: evaluated.steps,
        evidenceDir: runDir,
        screenshots: evidence.shots,
        tabId: driver?.tabId ?? null,
      });
      say(formatRun(i, evaluated));
      if (!evaluated.ok) {
        overallOk = false;
        failureCategory = evaluated.failureCategory;
        failureStage = evaluated.failureStage;
      }
    }

    const summary = buildResultJson({
      ok: overallOk,
      startedAt: startedAll,
      elapsedMs: Date.now() - startedAll,
      runs: runRecords.map((r) =>
        redactEvidence({
          index: r.index,
          ok: r.ok,
          failureCategory: r.failureCategory,
          failureStage: r.failureStage,
          steps: r.steps,
          evidenceDir: r.evidenceDir,
          screenshots: r.screenshots,
        }),
      ),
      connection: {
        wrapperBundleId: connection.wrapperBundleId,
        pid: connection.pid,
        port: connection.port,
        userDataDir: "ChromeMain",
        extensionId: extId,
        refusedDefaultChromePids: connection.refusedDefaultChromePids,
      },
      execution,
      failureCategory,
      failureStage,
      evidenceDir: root,
      screenshots: runRecords.flatMap((r) => r.screenshots.map((s) => `run-${r.index}/${s}`)),
    });
    await writeFile(join(root, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
    say(overallOk ? `PASS ${runs} consecutive runs` : `FAIL consecutive runs`);
    say(`evidence ${root}`);
    if (overallOk) {
      say(`  unique=${UNIQUE_TEXT}`);
      say(`  click ${COUNTER_AFTER} fill ${FILL_AFTER} phase ${PHASE_CHANGED}`);
    }
    process.exitCode = overallOk ? 0 : 1;
  } catch (e) {
    if (failureCategory !== "extension_not_found") {
      say(`FAIL ${e instanceof Error ? e.message : e}`);
      overallOk = false;
      failureCategory = failureCategory ?? "unexpected";
      failureStage = failureStage ?? "run";
    }
    const payload = buildResultJson({
      ok: false,
      startedAt: Date.now(),
      elapsedMs: 0,
      runs: runRecords,
      connection: {
        wrapperBundleId: connection.wrapperBundleId,
        pid: connection.pid,
        port: connection.port,
        userDataDir: "ChromeMain",
        extensionId: extId,
      },
      execution,
      failureCategory,
      failureStage,
      evidenceDir: root,
      screenshots: [],
    });
    await writeFile(join(root, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
    say(`evidence ${root}`);
    process.exitCode = 1;
  } finally {
    if (fixture) {
      try {
        await fixture.close();
      } catch {
        /* 忽略 */
      }
    }
    if (cdp) await cdp.close();
  }

  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
