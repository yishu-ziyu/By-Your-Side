#!/usr/bin/env node
/**
 * 浏览器能力对齐 E2E（docs/evals/20260922-browser-capability-parity.md 七案）。
 *
 * 隔离无头实例：单独 profile 启动 Chrome for Testing + 本仓库 extension/dist
 * （--headless=new，不创建窗口、不抢用户前台、不碰用户日常 Chrome，
 *  也不碰 local.yishu.chrome-main——与 demo-record-run 同一条隔离通道）。
 * 驱动只走 __saCall → uplink.handleRaw → executeToolCall → gate.run → handlers，
 * 页面动作全部是 CDP Input 真实事件；运行前后清理授权上传文件与实例。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { extensionIdFromKey } from "./constants.mjs";
import { connectBrowser, evaluateInWorker, fetchJson, findServiceWorker } from "./cdp.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import { installExecuteToolCallHook } from "./sw-hook.mjs";
import { buildParityExpression, CASE7_CODE } from "./capability-parity.mjs";
import { runBrowserProgram } from "../../agent/src/browser-program.js";

const CASES = ["case1", "case2", "case3", "case4", "case5", "case6", "case7"];
const UPLOAD_NAME = "capability-parity-upload.txt";
const DRIVER_TIMEOUT_MS = 120_000;
const PORT = 9417;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(repoRoot, "extension", "dist");

function evidenceRoot() {
  if (process.env.ACCEPT_EVIDENCE_DIR) return process.env.ACCEPT_EVIDENCE_DIR;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(repoRoot, "out", "acceptance", `capability-parity-${stamp}`);
}

async function writeResult(root, payload) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

async function chromeForTestingBinary() {
  const base = join(homedir(), "Library", "Caches", "ms-playwright");
  const entries = (await readdir(base)).filter((name) => name.startsWith("chromium-")).sort();
  const latest = entries.at(-1);
  if (!latest) throw new Error(`找不到 Chrome for Testing（${base}/chromium-*）`);
  return join(base, latest, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
}

async function launchIsolated() {
  const profile = await mkdir(join(tmpdir(), `bys-parity-profile-${Date.now()}`), { recursive: true });
  const binary = await chromeForTestingBinary();
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    "--disable-component-extensions-with-background-pages",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1100,760",
    // 无头运行：不创建任何窗口，绝不抢用户前台。
    "--headless=new",
    "about:blank",
  ];
  const proc = spawn(binary, args, { stdio: "ignore", detached: false });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetchJson(`http://127.0.0.1:${PORT}/json/version`, 1000);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("隔离实例调试端口 20 秒内没起来");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { proc, profile };
}

async function main() {
  const started = Date.now();
  const root = evidenceRoot();
  const say = (line) => console.log(line);

  const uploadDir = join(homedir(), ".sideagent", "uploads");
  const uploadPath = join(uploadDir, UPLOAD_NAME);
  let uploadCreated = false;
  let fixture;
  let cdp;
  let isolated;

  try {
    await mkdir(uploadDir, { recursive: true });
    await writeFile(uploadPath, "capability parity upload fixture 2026-09-22\n");
    uploadCreated = true;

    isolated = await launchIsolated();
    say(`PASS isolated-headless port=${PORT} profile=${isolated.profile}`);

    const browser = await connectBrowser(PORT);
    cdp = browser.cdp;
    say(`PASS cdp ${browser.version.Browser ?? ""}`);

    const manifest = JSON.parse(await readFile(join(repoRoot, "extension", "manifest.json"), "utf8"));
    const extId = extensionIdFromKey(manifest.key);
    const targets = await cdp.send("Target.getTargets");
    let sw = findServiceWorker(targets.targetInfos ?? targets, extId);
    if (!sw) {
      try {
        const listed = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
        sw = findServiceWorker(listed, extId);
      } catch { /* 走下面统一报错 */ }
    }
    if (!sw) {
      say(`FAIL extension service worker (extId=${extId})`);
      await writeResult(root, { ok: false, blocked: true, stage: "extension", extId, evidenceDir: root });
      process.exitCode = 2;
      return;
    }
    const sessionId = await cdp.attachSession(sw.targetId ?? sw.id);
    await cdp.send("Runtime.enable", {}, sessionId);

    fixture = await startFixtureServer();
    const hooked = await installExecuteToolCallHook(cdp, sessionId, extId, `${fixture.origin}/index.html?hook=1`);
    say(`PASS executeToolCall hook already=${Boolean(hooked.already)}`);

    const expression = buildParityExpression({
      url: `${fixture.origin}/parity.html?cap=${Date.now()}`,
      otherUrl: `${fixture.origin}/index.html?other=${Date.now()}`,
      uploadPath,
      uploadName: UPLOAD_NAME,
      sessionId: "acpt-parity",
    });

    let driver;
    try {
      driver = await evaluateInWorker(cdp, sessionId, expression, DRIVER_TIMEOUT_MS);
    } catch (e) {
      driver = { error: e instanceof Error ? e.message : String(e), stage: "sw_evaluate", cases: {}, receipts: {}, durationsMs: {}, snapshots: {}, startedAt: started, elapsedMs: Date.now() - started };
    }

    for (const key of CASES) {
      if (key === "case7") continue;
      const passed = driver.cases && driver.cases[key] && !driver.error;
      say(`${passed ? "PASS" : "FAIL"} ${key}${passed ? "" : ` (stage=${driver.stage}${driver.error ? `; ${driver.error}` : ""})`}`);
      if (!passed && driver.error) break;
    }

    // ── Case 7：生产同一份 runBrowserProgram（QuickJS 沙箱 + browser.* 门面），
    // 每个子调用经 SW 的 __saCall → executeToolCall 走真实 Harness（带 programId 入账）。
    let case7 = null;
    let case7Error = null;
    if (!driver.error && driver.cases && driver.cases.case1 && driver.cases.case2 && driver.cases.case3 && driver.cases.case4 && driver.cases.case5 && driver.cases.case6) {
      const swCall = async (name, params, stepId) => {
        const expr = `globalThis.__saCall(${JSON.stringify(stepId)}, ${JSON.stringify(name)}, ${JSON.stringify(params)}, "acpt-parity", "parity-program")`;
        const msg = await evaluateInWorker(cdp, sessionId, expr, 35_000);
        if (!msg || msg.type !== "tool_result") throw new Error(`${name} 未回 tool_result`);
        if (msg.ok === false) throw new Error(msg.error || `${name} failed`);
        return msg.data;
      };
      try {
        const prog = await runBrowserProgram({ code: CASE7_CODE, call: swCall, id: "parity-c7", timeoutMs: 60_000 });
        const v = prog.value || {};
        const okCase =
          v.tabId === driver.tabId &&
          String(v.after) === String(Number(v.before) + 1) &&
          /^DOUBLE-/.test(String(v.dbl)) &&
          v.name === "组合验证";
        if (!okCase) throw new Error(`组合程序结果不符: ${JSON.stringify(v).slice(0, 300)}`);
        case7 = { value: v, steps: prog.steps };
        say(`PASS case7 (steps=${prog.steps})`);
      } catch (e) {
        case7Error = e instanceof Error ? e.message : String(e);
        say(`FAIL case7 (${case7Error})`);
      }
    } else if (!driver.error) {
      case7Error = "前置用例未全部通过，跳过";
      say(`FAIL case7 (${case7Error})`);
    } else {
      say("FAIL case7 (前置驱动失败)");
    }

    // 关掉本次打开的 fixture 页（Case 7 路径下驱动故意没关）。
    if (driver.tabId != null && !driver.error) {
      try {
        await evaluateInWorker(cdp, sessionId, `globalThis.__saCall("parity-close-final", "close_tab", { tabId: ${Number(driver.tabId)} }, "acpt-parity")`, 15_000);
      } catch { /* 标签可能已关 */ }
    }
    if (case7) driver.cases.case7 = case7;
    if (driver.snapshots && driver.snapshots.before) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "snapshot-before.txt"), driver.snapshots.before);
    }

    const ok = !driver.error && CASES.every((key) => driver.cases && driver.cases[key]);
    await writeResult(root, {
      ok,
      capability: "browser-capability-parity",
      baseline: "citrolabs/ego-lite",
      lane: "isolated-headless-chrome-for-testing",
      cases: driver.cases ?? {},
      receipts: driver.receipts ?? {},
      error: driver.error ?? case7Error ?? null,
      stage: driver.stage ?? null,
      durationsMs: driver.durationsMs ?? {},
      execution: { via: "uplink.handleRaw → onServerMessage → executeToolCall → gate.run → handlers" },
      connection: { port: PORT, extensionId: extId, userDataDir: "isolated-parity-profile" },
      note: "隔离无头实例 + extension/dist；CDP Input 真实事件；合成输入不等于人手感",
      evidenceDir: root,
      startedAt: started,
      elapsedMs: Date.now() - started,
    });
    say(ok ? "PASS capability parity cases" : `FAIL capability parity: ${driver.error ?? "case missing"}`);
    say(`evidence ${root}`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    say(`FAIL ${e instanceof Error ? e.message : e}`);
    await writeResult(root, { ok: false, stage: "run", error: String(e), evidenceDir: root, elapsedMs: Date.now() - started }).catch(() => {});
    console.error(`evidence: ${root}`);
    process.exitCode = 1;
  } finally {
    if (uploadCreated) await rm(uploadPath, { force: true }).catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
    if (cdp) await cdp.close();
    if (isolated) {
      try { isolated.proc.kill("SIGTERM"); } catch { /* 已退出 */ }
      await rm(isolated.profile, { recursive: true, force: true }).catch(() => {});
    }
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
