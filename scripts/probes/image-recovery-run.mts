/**
 * 三图恢复的诊断入口。默认不调用模型。
 *
 *   npx tsx scripts/probes/image-recovery-run.mts --self-check --images <原图目录> --prior-trace <trace-relevant.json>
 *   npx tsx scripts/probes/image-recovery-run.mts --print-budget
 *   SIDEAGENT_ACCEPTANCE_DIST=<固定扩展> npx tsx scripts/probes/image-recovery-run.mts --live --arm web --images <原图目录> --out out/single-image-diagnosis/three-image-recovery
 *   同上，把 --arm web 换成 --arm attachment：只附上第 3、6 张原件，页面不提供原图。
 *
 * --live 先发一次与图集无关的预检，主请求的 thinking 与 --effort 一致后才发送图集任务。
 * 预检不符、扩展目录未固定、或本机没有该模型登录时退出，不开始正式任务。
 * 下载目录由 harness 指到临时目录，不写用户的「下载」。
 */
import { createServer } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROPOSED_BUDGET, RecoveryLedger, attemptKind, beginFormalTask, classifyStop, coverPositions,
  expectedThinking, imageFact, imagesInPayload, leakedAnswers, overBudget, selfCheck, sha256,
  sniffImage, taskPrompt, type HttpAttempt, type ThinkingWire,
} from "./image-recovery-ledger.mts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${name} 需要一个值`);
  return value;
};

if (flag("--print-budget")) {
  console.log(JSON.stringify({
    budget: PROPOSED_BUDGET,
    appliesTo: "每个条件相同。预检单独计数，不占用正式任务的 8 次主请求。",
    countsSeparately: ["preflight", "main", "auxiliary", "retry", "hedge"],
    auxiliaries: "不关闭标题、记忆、核对，两边都走日常路径。它们计入总 HTTP 上限，不计入 8 次主请求。",
    stop: "墙钟、主请求或总 HTTP 先到者记 experiment_budget。控制器拦截之后的连接失败也记这一项，不记成产品断线。",
  }, null, 2));
  process.exit(0);
}

if (flag("--self-check")) {
  const images = option("--images");
  const priorTrace = option("--prior-trace");
  if (!images || !priorTrace) {
    console.error("用法：--self-check --images <原图目录> --prior-trace <trace-relevant.json>");
    process.exit(1);
  }
  const failures = await selfCheck({ images, priorTrace });
  if (failures.length) {
    console.error(`自检失败 ${failures.length} 项：${failures.join("、")}`);
    process.exit(1);
  }
  console.log("自检通过。未调用模型，未开始正式任务。");
  process.exit(0);
}

if (!flag("--live")) {
  console.error("没有 --self-check、--print-budget 或 --live。为避免误调用模型，这里不会开始任务。");
  process.exit(1);
}

const arm = option("--arm");
const images = option("--images");
const out = option("--out");
const modelRef = option("--model") ?? "minimax-cn/MiniMax-M3";
const effort = option("--effort") ?? "low";
const dist = option("--dist") ?? process.env.SIDEAGENT_ACCEPTANCE_DIST;
if ((arm !== "web" && arm !== "attachment") || !images || !out) {
  console.error("用法：--live --arm web|attachment --images <原图目录> --out <目录> [--model minimax-cn/MiniMax-M3] [--effort low]");
  process.exit(1);
}

await mkdir(out, { recursive: true });
const ledger = new RecoveryLedger();
let browser: LiveBrowser | undefined;
let panel = "";
let server: { close: () => void } | undefined;
const reads: Array<{ atMs: number; path: string; page: number }> = [];

try {
  if (!dist) {
    ledger.stopReason = "dist_unpinned";
    throw new Error("需要 --dist 或 SIDEAGENT_ACCEPTANCE_DIST 指向预先构建的扩展，本脚本不在实验现场现编");
  }
  const leaks = leakedAnswers(taskPrompt(arm));
  if (leaks.length) throw new Error(`prompt_leaks:${leaks.join(",")}`);
  const expected = await expectedThinking(modelRef, effort);
  const originals = new Map<string, number>();
  const files = new Map<number, Uint8Array>();
  for (const page of [1, 3, 6]) {
    const bytes = new Uint8Array(await readFile(join(images, `cover_${page}.jpg`)));
    files.set(page, bytes);
    const fact = imageFact(bytes, null, originals);
    originals.set(fact.sha256, page);
    ledger.originals.push({ page, ...imageFact(bytes, null, originals), matchesOriginalPage: page });
  }
  ledger.notes.push(`expectedThinking=${JSON.stringify(expected)}`);
  ledger.notes.push(`dist=${JSON.stringify(await distFingerprint(dist))}`);
  ledger.notes.push("辅助调用保持开启，与日常路径相同；只在账本里与主请求分开。");
  await writeFile(join(out, "positions.json"), `${JSON.stringify(coverPositions(), null, 2)}\n`);
  await writeFile(join(out, "prompt.txt"), taskPrompt(arm));

  const { loadModelPlan, modelStorageItems } = await import("../acceptance/real-path/inproc-config.mts");
  const { launchRealPath, until, sleep } = await import("../acceptance/real-path/harness.mts");
  const { send, traceLines, BUSY } = await import("./ext-session.mts");
  let plan;
  try {
    plan = await loadModelPlan(modelRef);
  } catch (error) {
    ledger.stopReason = "precondition_failed";
    ledger.error = String(error);
    throw error;
  }

  if (arm === "web") server = await startGallery(files, reads);
  browser = await launchRealPath({ headed: false, dist });
  const beforeDownloads = await readdir(browser.dirs.downloads);
  const helper = await browser.cdp.send("Target.createTarget", { url: `chrome-extension://${browser.extensionId}/voice-permission.html` }) as { targetId: string };
  const helperSession = await browser.attach(helper.targetId);
  await until(() => browser!.evaluate(helperSession, "!!globalThis.chrome?.storage?.local"), 20_000, "helper");
  const stored = { ...modelStorageItems(plan), inproc_fast_model_config: { provider: plan.providerId, modelId: plan.modelId, ...(plan.baseUrl ? { baseUrl: plan.baseUrl } : {}) } };
  await browser.evaluate(helperSession, `chrome.storage.local.set(${JSON.stringify(stored)}).then(() => true)`);
  panel = await browser.attach(await browser.openSidePanel());
  await browser.evaluate(panel, `localStorage.setItem("sideagent.thinkingLevels", ${JSON.stringify(JSON.stringify({ [modelRef]: effort }))}); true`);
  await browser.cdp.send("Page.reload", {}, panel);
  await until(() => browser!.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`), 45_000, "panel ready");
  const host = await until(async () => (await browser!.targets()).find(target => target.url.endsWith("/inproc.html")), 30_000, "host");
  const hostSession = await browser.attach(host.targetId);
  const tap = createTap(browser, hostSession, originals, expected);
  ledger.attempts = tap.attempts;
  await tap.enable();

  await send(browser, panel, "只回复一个字：好。不要调用工具。");
  const preflight = await tap.waitForMain(PROPOSED_BUDGET.preflightWallClockMs);
  ledger.preflight = preflight;
  if (!preflight?.thinking) {
    ledger.stopReason = "preflight_incomplete";
    await stopIfRunning(browser, panel);
    throw new Error("preflight_incomplete");
  }
  const gate = await beginFormalTask({
    wireThinking: preflight.thinking,
    chipText: String(await browser.evaluate(panel, `document.querySelector("#think-chip")?.innerText ?? ""`)),
    expected,
    start: async () => { ledger.taskStarted = true; },
  });
  if (gate !== "started") {
    ledger.stopReason = "tier_mismatch";
    await stopIfRunning(browser, panel);
    throw new Error("tier_mismatch");
  }
  await stopIfRunning(browser, panel);
  await sleep(500);
  await browser.click(panel, "#conversation-new");
  await until(() => browser!.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running")`), 20_000, "new conversation");
  tap.resetPhase("task");

  if (arm === "attachment") {
    await browser.cdp.send("DOM.enable", {}, panel);
    const root = await browser.cdp.send("DOM.getDocument", { depth: 0 }, panel) as { root: { nodeId: number } };
    const node = await browser.cdp.send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "#file-input" }, panel) as { nodeId: number };
    await browser.cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [3, 6].map(page => join(images, `cover_${page}.jpg`)) }, panel);
    const ready = await until(async () => {
      const tiles = await browser!.evaluate(panel, `[...document.querySelectorAll("#attachments-strip .tile-file")].map(t => ({ name: t.querySelector(".file-chip-name")?.textContent, done: t.classList.contains("complete") }))`) as Array<{ done: boolean }>;
      return tiles.length >= 2 && tiles.every(tile => tile.done) ? tiles : null;
    }, 60_000, "附件读完").catch(() => null);
    if (!ready) {
      ledger.stopReason = "attachment_not_ready";
      throw new Error("attachment_not_ready");
    }
  } else if (server) {
    const { siteAddress } = await import("../acceptance/real-path/harness.mts");
    await browser.evaluate(panel, `chrome.tabs.create(${JSON.stringify({ url: `http://127.0.0.1:${siteAddress(server).port}/`, active: true })}).then(() => true)`);
  }

  const taskStartedAt = Date.now();
  await send(browser, panel, taskPrompt(arm));
  let quiet = 0;
  while (!ledger.stopReason) {
    await sleep(500);
    const reason = overBudget({ elapsedMs: Date.now() - taskStartedAt, mainRequests: tap.mainCount(), httpAttempts: tap.taskHttpCount() });
    if (reason) {
      ledger.stopReason = "experiment_budget";
      ledger.notes.push(`budget:${reason}`);
      tap.blockFurther();
      await browser.click(panel, "#send-btn").catch(() => {});
      break;
    }
    const busy = await browser.evaluate(panel, BUSY).catch(() => true);
    quiet = busy ? 0 : quiet || Date.now();
    if (tap.taskHttpCount() > 0 && quiet && Date.now() - quiet > 4500) {
      ledger.stopReason = "idle";
      break;
    }
  }
  ledger.downloads = (await readdir(browser.dirs.downloads)).filter(name => !beforeDownloads.includes(name));
  try {
    await writeFile(join(out, "trace.jsonl"), await traceLines(browser, panel));
  } catch (error) {
    ledger.notes.push(`trace_save_failed:${String(error)}`);
  }
} catch (error) {
  if (!ledger.stopReason) ledger.stopReason = "harness_error";
  if (!ledger.error) ledger.error = String(error);
} finally {
  ledger.reads = reads;
  if (browser && panel) {
    try {
      const raw = await browser.evaluate(panel, `JSON.stringify([...document.querySelectorAll("#messages .msg.assistant")].map(node => node.innerText))`);
      const parsed: unknown = JSON.parse(String(raw));
      ledger.partialAnswer = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch (error) {
      ledger.uiError = String(error);
    }
    await browser.screenshot(panel, join(out, "final-panel.png")).catch(() => {});
  }
  try {
    await ledger.save(out);
  } catch (error) {
    await writeFile(join(out, "result.json"), `${JSON.stringify({ stopReason: "save_failed", error: String(error) }, null, 2)}\n`).catch(() => {});
  }
  server?.close();
  if (browser) {
    await browser.close().catch(() => {});
    await browser.remove().catch(() => {});
  }
  console.log(JSON.stringify({ stopReason: ledger.stopReason, taskStarted: ledger.taskStarted, attempts: ledger.attempts.length, out }));
  if (ledger.stopReason !== "idle") process.exitCode = 1;
}

interface LiveBrowser {
  extensionId: string;
  dirs: { downloads: string };
  close: () => Promise<void>;
  remove: () => Promise<void>;
  attach: (targetId: string) => Promise<string>;
  openSidePanel: () => Promise<string>;
  evaluate: (session: string, expression: string) => Promise<unknown>;
  click: (session: string, selector: string) => Promise<void>;
  screenshot: (session: string, file: string) => Promise<void>;
  targets: () => Promise<Array<{ url: string; targetId: string }>>;
  cdp: {
    onEvent: (name: string, listener: (event: { sessionId?: string; params?: Record<string, unknown> }) => void) => void;
    send: (method: string, params?: unknown, sessionId?: string) => Promise<unknown>;
  };
}

/** 预检已经结束时发送键不再是停止；只在仍在跑的时候点，避免空点变成再发一条。 */
async function stopIfRunning(browser: LiveBrowser, panel: string): Promise<void> {
  await browser.evaluate(panel, `(() => { const button = document.querySelector("#send-btn"); if (button?.classList.contains("stopping")) button.click(); return true; })()`).catch(() => {});
}

async function distFingerprint(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of ["manifest.json", "background.js", "sidepanel.js"]) out[file] = sha256(new Uint8Array(await readFile(join(dir, file))));
  return out;
}

async function startGallery(files: Map<number, Uint8Array>, hits: Array<{ atMs: number; path: string; page: number }>): Promise<ReturnType<typeof createServer>> {
  const started = Date.now();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const match = /^\/(?:image|cover)\/(1|3|6)$/.exec(path);
    if (!match) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><title>原图集三图恢复</title><h1>原图集图片入口</h1>${[1, 3, 6].map(page => `<p><a href="/cover/${page}">原图集第 ${page} 张</a></p>`).join("")}`);
      return;
    }
    const page = Number(match[1]);
    hits.push({ atMs: Date.now() - started, path, page });
    const bytes = files.get(page);
    if (!bytes) { res.writeHead(404).end(); return; }
    if (path.startsWith("/image/")) {
      res.setHeader("content-type", sniffImage(bytes).mime);
      res.end(bytes);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>原图集第 ${page} 张</title><header>原图集第 ${page} 张</header><img src="/image/${page}" alt="原图集第 ${page} 张">`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function createTap(browser: LiveBrowser, hostSession: string, originals: Map<string, number>, expected: ThinkingWire) {
  const attempts: HttpAttempt[] = [];
  let phase: "preflight" | "task" = "preflight";
  let blocking = false;
  let previousFailed = false;
  const pending = new Map<string, number>();
  const inflightBody = new Map<string, string>();
  const waiters: Array<(attempt: HttpAttempt | null) => void> = [];

  const finishWait = (attempt: HttpAttempt | null) => {
    const waiter = waiters.shift();
    waiter?.(attempt);
  };

  browser.cdp.onEvent("Fetch.requestPaused", event => {
    if (event.sessionId !== hostSession) return;
    const params = event.params ?? {};
    const requestId = String(params.requestId ?? "");
    const request = params.request as { method?: string; postData?: string } | undefined;
    void (async () => {
      if (typeof params.responseStatusCode === "number" && pending.has(requestId)) {
        const attempt = attempts[pending.get(requestId)!];
        if (attempt) {
          attempt.responseStatus = params.responseStatusCode;
          attempt.stopClass = classifyStop({ blockedByController: attempt.blockedByController, controllerActive: blocking, status: params.responseStatusCode });
          if (attempt.stopClass === "provider_unavailable") previousFailed = true;
        }
        inflightBody.delete(requestId);
        await browser.cdp.send("Fetch.continueRequest", { requestId }, hostSession);
        return;
      }
      if (request?.method !== "POST") {
        await browser.cdp.send("Fetch.continueRequest", { requestId }, hostSession);
        return;
      }
      const taskHttp = attempts.filter(item => item.phase === "task" && !item.blockedByController).length;
      const taskMain = attempts.filter(item => item.phase === "task" && item.kind === "main" && !item.blockedByController).length;
      const preflightHttp = attempts.filter(item => item.phase === "preflight").length;
      const blocked = blocking
        || (phase === "preflight" && preflightHttp >= PROPOSED_BUDGET.preflightHttpAttempts)
        || (phase === "task" && overBudget({ elapsedMs: 0, mainRequests: taskMain, httpAttempts: taskHttp }) !== null);
      let parsed: { model?: string; max_tokens?: number; thinking?: { type?: string; budget_tokens?: number; display?: string } } = {};
      if (request.postData) {
        try { parsed = JSON.parse(request.postData) as typeof parsed; } catch { parsed = {}; }
      }
      const images = request.postData ? imagesInPayload(safeParse(request.postData), originals) : [];
      const bodyHash = request.postData ? sha256(new TextEncoder().encode(request.postData)) : "";
      const hedge = bodyHash !== "" && [...inflightBody.values()].includes(bodyHash);
      const retry = previousFailed;
      previousFailed = false;
      const kind = attemptKind({
        purpose: null,
        maxTokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : null,
        imageCount: images.length,
        hedge,
        retry,
        phase,
      });
      const thinking = parsed.thinking?.type ? {
        type: parsed.thinking.type,
        budget_tokens: typeof parsed.thinking.budget_tokens === "number" ? parsed.thinking.budget_tokens : null,
        display: typeof parsed.thinking.display === "string" ? parsed.thinking.display : null,
      } : null;
      const attempt: HttpAttempt = {
        n: attempts.length + 1,
        atMs: Date.now(),
        phase,
        kind,
        purpose: null,
        model: typeof parsed.model === "string" ? parsed.model : null,
        maxTokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : null,
        thinking,
        tierMatches: thinking && (kind === "main" || kind === "preflight") ? thinking.type === expected.type && thinking.budget_tokens === expected.budget_tokens && thinking.display === expected.display : null,
        images,
        responseStatus: null,
        stopClass: blocked ? "experiment_budget" : null,
        blockedByController: blocked,
        note: request.postData ? null : "no_post_data",
      };
      attempts.push(attempt);
      pending.set(requestId, attempts.length - 1);
      if (!blocked && bodyHash) inflightBody.set(requestId, bodyHash);
      if (blocked) {
        blocking = true;
        await browser.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, hostSession);
      } else {
        await browser.cdp.send("Fetch.continueRequest", { requestId }, hostSession);
      }
      if (kind === "preflight" && thinking) finishWait(attempt);
    })().catch(error => {
      attempts.push({
        n: attempts.length + 1, atMs: Date.now(), phase, kind: "main", purpose: null, model: null, maxTokens: null,
        thinking: null, tierMatches: null, images: [], responseStatus: null,
        stopClass: classifyStop({ blockedByController: false, controllerActive: blocking, status: null, errorText: String(error) }),
        blockedByController: false, note: "observer_error",
      });
      finishWait(null);
    });
  });

  return {
    attempts,
    enable: () => browser.cdp.send("Fetch.enable", { patterns: ["*minimaxi.com*", "*minimax.io*"].flatMap(urlPattern => [{ urlPattern, requestStage: "Request" }, { urlPattern, requestStage: "Response" }]) }, hostSession),
    waitForMain: (wallMs: number) => new Promise<HttpAttempt | null>(resolve => {
      const existing = attempts.find(item => item.kind === "preflight" && item.thinking && !item.blockedByController);
      if (existing) { resolve(existing); return; }
      const timer = setTimeout(() => resolve(null), wallMs);
      waiters.push(attempt => { clearTimeout(timer); resolve(attempt); });
    }),
    resetPhase: (next: "task") => { phase = next; blocking = false; },
    blockFurther: () => { blocking = true; },
    mainCount: () => attempts.filter(item => item.phase === "task" && item.kind === "main" && !item.blockedByController).length,
    taskHttpCount: () => attempts.filter(item => item.phase === "task" && !item.blockedByController).length,
  };
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
