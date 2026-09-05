#!/usr/bin/env node
/**
 * 全队接管验收：只连接 local.yishu.chrome-main，走已加载扩展的
 * background / content-script / CDP 生产链。不复制 ControlGate。
 */
import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RUNS,
  INC_BUTTON_ID,
  INPUT_ID,
  LEAD_MARK,
  STEP_TIMEOUT_MS,
  TEAM_LEAD_SESSION,
  TEAM_WORKER_SESSION,
  USER_LEAD_MARK,
  USER_WORKER_MARK,
  WORKER_MARK,
  recoveryChromeMain,
  recoveryExtension,
  sideagentExtensionId,
} from "./constants.mjs";
import { connectBrowser, evaluateInWorker, fetchJson, findServiceWorker } from "./cdp.mjs";
import { discoverChromeMain } from "./discover.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from "./sw-hook.mjs";
import { buildTeamDriverExpression } from "./team-driver.mjs";
import { buildTeamResultJson, evaluateTeamRun, formatTeamRun } from "./team-result.mjs";

function parseRuns(argv) {
  const flag = argv.find((a) => a.startsWith("--runs="));
  if (flag) {
    const n = Number(flag.slice("--runs=".length));
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("--runs 必须是 1..20 的整数");
    return n;
  }
  const env = Number(process.env.ACCEPT_TEAM_RUNS ?? process.env.ACCEPT_RUNS ?? DEFAULT_RUNS);
  if (!Number.isInteger(env) || env < 1) return DEFAULT_RUNS;
  return env;
}

function evidenceRoot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(tmpdir(), `sideagent-accept-team-${stamp}`);
}

async function main() {
  const runs = parseRuns(process.argv.slice(2));
  const root = process.env.ACCEPT_TEAM_EVIDENCE_DIR || process.env.ACCEPT_EVIDENCE_DIR || evidenceRoot();
  await mkdir(root, { recursive: true });
  const capabilityPath = join(homedir(), ".sideagent", "acceptance-team-capability.json");
  const capabilities = Array.from({ length: runs }, () => randomBytes(32).toString("hex"));
  const say = (line) => console.log(line);

  let connection;
  try {
    connection = discoverChromeMain();
    say(`PASS connect ${connection.wrapperBundleId} pid=${connection.pid} port=${connection.port}`);
  } catch (e) {
    say(`FAIL connect chrome-main`);
    say(e instanceof Error ? e.message : String(e));
    await writeFile(
      join(root, "result.json"),
      `${JSON.stringify(buildTeamResultJson({ ok: false, failureCategory: "chrome_main_not_found", evidenceDir: root }), null, 2)}\n`,
    );
    process.exit(1);
  }

  let extId;
  try {
    extId = sideagentExtensionId();
  } catch (e) {
    say(`FAIL extension id: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  let cdp;
  try {
    const browser = await connectBrowser(connection.port);
    cdp = browser.cdp;
    say(`PASS cdp ${browser.version.Browser ?? ""}`);
  } catch (e) {
    say(`FAIL cdp ${e instanceof Error ? e.message : e}`);
    say(recoveryChromeMain());
    process.exit(1);
  }

  const execution = {
    via: "handleTakeover / handleHandback / uplink.handleRaw → executeToolCall → gate.run",
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
    await normalizeServiceWorkerInspector(cdp, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    fixture = await startFixtureServer();
    const hooked = await installExecuteToolCallHook(cdp, sessionId, extId, `${fixture.origin}/index.html?hook=1`);
    say(`PASS executeToolCall hook already=${Boolean(hooked.already)} team=${Boolean(hooked.team)}`);
    await mkdir(join(homedir(), ".sideagent"), { recursive: true });
    await writeFile(
      capabilityPath,
      `${JSON.stringify({ expiresAt: Date.now() + 5 * 60_000, tokens: capabilities })}\n`,
      { mode: 0o600 },
    );
    const startedAll = Date.now();
    let identity = null;

    for (let i = 1; i <= runs; i++) {
      const leadUrl = `${fixture.origin}/index.html?mark=${LEAD_MARK}&run=${i}&t=${Date.now()}`;
      const workerUrl = `${fixture.origin}/index.html?mark=${WORKER_MARK}&run=${i}&t=${Date.now()}`;
      const expression = buildTeamDriverExpression({
        leadUrl,
        workerUrl,
        leadId: TEAM_LEAD_SESSION,
        workerId: TEAM_WORKER_SESSION,
        leadMark: LEAD_MARK,
        workerMark: WORKER_MARK,
        userLeadMark: USER_LEAD_MARK,
        userWorkerMark: USER_WORKER_MARK,
        incSelector: `#${INC_BUTTON_ID}`,
        inputSelector: `#${INPUT_ID}`,
        leadFill: "team-lead-fill",
        workerFill: "team-worker-fill",
        capability: capabilities[i - 1],
      });
      let driver;
      try {
        driver = await evaluateInWorker(cdp, sessionId, expression, STEP_TIMEOUT_MS + 20_000);
      } catch (e) {
        driver = {
          error: e instanceof Error ? e.message : String(e),
          stage: "sw_evaluate",
          snapshots: {},
          startedAt: Date.now(),
          elapsedMs: 0,
        };
      }
      if (driver?.extension) identity = driver.extension;
      const evaluated = evaluateTeamRun(driver);
      const runDir = join(root, `run-${i}`);
      await mkdir(runDir, { recursive: true });
      const payload = buildTeamResultJson({
        ok: evaluated.ok,
        startedAt: evaluated.startedAt,
        elapsedMs: evaluated.elapsedMs,
        steps: evaluated.steps,
        failureCategory: evaluated.failureCategory,
        failureStage: evaluated.failureStage,
        error: evaluated.error,
        takeover: driver?.takeover,
        agentAssembly: driver?.agentAssembly ?? null,
        originalTask: driver?.originalTask ?? null,
        partial: driver?.partial ?? null,
        abortState: driver?.abortState ?? null,
        handback: {
          requestId: driver?.handback?.requestId,
          sentAt: driver?.handback?.sentAt,
          members: (driver?.handback?.members ?? []).map((m) => ({
            sessionId: m.sessionId,
            closed: m.closed ?? false,
            tabId: m.context?.tabId ?? null,
            title: m.context?.title ?? "",
            url: m.context?.url ?? "",
            capturedAt: m.capturedAt ?? null,
            snapshotChars: typeof m.snapshot === "string" ? m.snapshot.length : 0,
          })),
        },
        lastWriteEndedAt: driver?.lastWriteEndedAt ?? null,
        inflightStartedAt: driver?.inflightStartedAt ?? null,
        gateAfterTakeover: driver?.gateAfterTakeover ?? null,
        extension: driver?.extension ?? null,
        openTabAfterHandback: driver?.openTabAfterHandback ?? null,
      });
      await writeFile(join(runDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
      runRecords.push({ index: i, ok: evaluated.ok, failureCategory: evaluated.failureCategory, failureStage: evaluated.failureStage, evidenceDir: runDir });
      say(formatTeamRun(i, evaluated));
      if (!evaluated.ok) {
        overallOk = false;
        failureCategory = evaluated.failureCategory;
        failureStage = evaluated.failureStage;
      }
    }

    const summary = buildTeamResultJson({
      ok: overallOk,
      startedAt: startedAll,
      elapsedMs: Date.now() - startedAll,
      runs: runRecords,
      connection: {
        wrapperBundleId: connection.wrapperBundleId,
        pid: connection.pid,
        port: connection.port,
        userDataDir: "ChromeMain",
        extensionId: extId,
      },
      execution,
      extension: identity,
      failureCategory,
      failureStage,
      evidenceDir: root,
    });
    await writeFile(join(root, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
    say(overallOk ? `PASS ${runs} consecutive team runs` : `FAIL consecutive team runs`);
    if (identity) say(`identity extensionId=${identity.id} version=${identity.version}`);
    say(`evidence ${root}`);
    process.exitCode = overallOk ? 0 : 1;
  } catch (e) {
    say(`FAIL ${e instanceof Error ? e.message : e}`);
    await writeFile(
      join(root, "result.json"),
      `${JSON.stringify(
        buildTeamResultJson({
          ok: false,
          runs: runRecords,
          failureCategory: failureCategory ?? "unexpected",
          failureStage: failureStage ?? "run",
          evidenceDir: root,
        }),
        null,
        2,
      )}\n`,
    );
    say(`evidence ${root}`);
    process.exitCode = 1;
  } finally {
    try {
      await unlink(capabilityPath);
    } catch {
      /* 最后一个令牌已由 Agent 消费，或文件本就不存在 */
    }
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
