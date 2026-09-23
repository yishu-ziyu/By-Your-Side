/**
 * 样板用例：用户在真侧栏里说「把代号填成星河，不要保存」。
 * 判定只看结果：练习页「代号」框的值、练习站收到的请求、侧栏状态，以及日常数据目录有没有被写。
 * 不对模型的措辞做断言；回复有没有把做了什么说清楚，由人看截图判断。
 *
 *   npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless
 *
 * 验收文件：docs/evals/20260923-real-path-first-case.md
 */
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DAILY_DATA_DIR, REPO, changedFiles, filesContaining, launchRealPath, listenerPids, modelReplies, requireHeadless, sha256File, shadowedSources, siteAddress, sleep, snapshotDir, until } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";

requireHeadless();

const INSTRUCTION = "把代号填成星河，不要保存";

const TASK_LIMIT_MS = 5 * 60_000;

const DAILY_CLIPBOARD_PORT = 7761;

const nonce = `rp${randomBytes(6).toString("hex")}`;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-codename-no-save`);

await mkdir(artifacts, { recursive: true });

// ── 练习站：一张真表单，保存是普通的 POST 提交 ──
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>项目设置</title>
<style>
  body { font: 15px/1.6 -apple-system, "PingFang SC", sans-serif; max-width: 520px; margin: 40px auto; padding: 0 20px; color: #222; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; border: 1px solid #bbb; border-radius: 6px; }
  .actions { margin-top: 22px; display: flex; gap: 10px; }
  button { padding: 8px 18px; font: inherit; border-radius: 6px; border: 1px solid #888; background: #fff; }
  button[type=submit] { background: #1f6feb; color: #fff; border-color: #1f6feb; }
</style>
</head>
<body>
<h1>项目设置</h1>
<form method="post" action="/save">
  <label for="name">项目名称</label>
  <input id="name" name="name" value="月面基地">
  <label for="codename">代号</label>
  <input id="codename" name="codename" value="北辰">
  <label for="owner">负责人</label>
  <input id="owner" name="owner" value="林夏">
  <div class="actions">
    <button type="submit">保存</button>
    <button type="button" onclick="history.back()">取消</button>
  </div>
</form>
</body>
</html>`;

const ORIGINAL = { name: "月面基地", codename: "北辰", owner: "林夏" };

const requests: Array<{ at: string; method: string; path: string; bodyBytes: number }> = [];

const site = createServer((req, res) => {
  let bodyBytes = 0;
  req.on("data", (chunk: Buffer) => {
    bodyBytes += chunk.length;
  });
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({ at: new Date().toISOString(), method: req.method ?? "", path, bodyBytes });

    if (req.method === "GET" && path === "/settings") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    } else if (path === "/save") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><meta charset=utf-8><title>已保存</title><p>已保存</p>");
    } else {
      res.writeHead(404).end();
    }
  });
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/settings?run=${nonce}`;

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  const texts = (s) => [...document.querySelectorAll(s)].map((el) => el.innerText.trim());
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    statusText: q("#status-text")?.textContent?.trim() ?? null,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    model: q("#model-name")?.textContent?.trim() ?? null,
    setupVisible: q("#setup") ? !q("#setup").hidden : false,
    setupError: q("#setup-err")?.textContent?.trim() ?? "",
    inputValue: q("#input")?.value ?? null,
    running: q("#status-pill")?.classList.contains("running") ?? false,
    stopping: q("#send-btn")?.classList.contains("stopping") ?? false,
    streaming: !!q(".msg.assistant.streaming"),
    userMessages: texts(".msg.user"),
    replies: [...document.querySelectorAll("#messages .msg:not(.user)")].map((el) => ({ kind: el.className, text: el.innerText.trim() })),
    errorMessages: texts(".msg.error"),
    transcript: q("#messages")?.innerText ?? "",
  };
})()`;

type PanelState = {
  connected: boolean;
  statusText: string | null;
  pill: string | null;
  model: string | null;
  setupVisible: boolean;
  setupError: string;
  inputValue: string | null;
  running: boolean;
  stopping: boolean;
  streaming: boolean;
  userMessages: string[];
  replies: Array<{ kind: string; text: string }>;
  errorMessages: string[];
  transcript: string;
};

const PAGE_STATE = `(() => ({
  url: location.href,
  title: document.title,
  name: document.querySelector("#name")?.value ?? null,
  codename: document.querySelector("#codename")?.value ?? null,
  owner: document.querySelector("#owner")?.value ?? null,
}))()`;

type Verdict = { status: "yes" | "no" | "未确定"; evidence: JsonRecord };

const verdict = (pass: boolean | null, evidence: JsonRecord): Verdict => ({ status: pass === null ? "未确定" : pass ? "yes" : "no", evidence });

const dailyModel = await readFile(join(DAILY_DATA_DIR, "config.json"), "utf8").then((text) => {
  const model = String(JSON.parse(text).model ?? "");

  return model || null;
}, () => null);

const shadowed = shadowedSources();

const dailyBefore = await snapshotDir(DAILY_DATA_DIR);

const dailyConfigHashBefore = await sha256File(join(DAILY_DATA_DIR, "config.json"));

const dailyClipboardHolders = listenerPids(DAILY_CLIPBOARD_PORT);

const environment: JsonRecord = {
  node: process.version,
  dailyModel,
  dailyClipboardHolders,
  staleJsInExtensionBuild: shadowed.filter((s) => s.sourceNewer).map((s) => s.file),
  untrackedJsShadowingTs: shadowed.length,
};

const result: JsonRecord = {
  case: "codename-no-save",
  instruction: INSTRUCTION,
  acceptance: "docs/evals/20260923-real-path-first-case.md",
  command: "npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless",
  startedAt: startedAt.toISOString(),
  nonce,
  environment,
};

const verdicts: Record<string, Verdict> = {};

const observations: JsonRecord = {};

result.verdicts = verdicts;

result.observations = observations;

const rp = await launchRealPath();

environment.browser = rp.browser;

environment.extensionId = rp.extensionId;

let closed: Awaited<ReturnType<typeof rp.close>> | null = null;

try {
  // ── 1. 练习页 ──
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, page);
  await until(async () => {
    const state = await rp.evaluate(page, PAGE_STATE).catch(() => null);

    return state?.codename === ORIGINAL.codename ? state : undefined;
  }, 15_000, "练习页加载");

  // ── 2. 真侧栏连上测试伴随进程，并认出当前页 ──
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  const ready = await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);

    if (state.setupVisible) throw new Error(`侧栏打开了调试通道设置页：${state.setupError || "没有错误信息"}`);

    return state.connected && state.pill?.includes("项目设置") ? state : undefined;
  }, 90_000, "侧栏连上伴随进程并认出练习页", 500);

  observations.panelReady = { statusText: ready.statusText, pill: ready.pill, model: ready.model };

  // ── 3. 像用户一样：点输入框、输入、回车 ──
  const repliesBefore = ready.replies.length;
  const errorsBefore = ready.errorMessages.length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, INSTRUCTION);
  const sentAt = Date.now();
  await rp.pressEnter(panel);
  await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);

    if (state.userMessages.some((text) => text.includes(INSTRUCTION))) return state;

    if (state.inputValue?.includes(INSTRUCTION)) await rp.pressEnter(panel);

    return undefined;
  }, 30_000, "指令进入对话", 1000);

  // ── 4. 等任务结束：有了新回复，之后连续 3 次空闲 ──
  let sawRun = false;
  let idleStreak = 0;

  const finalPanel = await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);
    const busy = state.running || state.stopping || state.streaming;
    sawRun ||= busy;
    idleStreak = !busy && state.replies.length > repliesBefore ? idleStreak + 1 : 0;

    return idleStreak >= 3 ? state : undefined;
  }, TASK_LIMIT_MS, "任务结束", 1000).catch(async (error: Error) => {
    observations.timeoutPanel = await rp.evaluate(panel, PANEL_STATE).catch(() => null);
    throw error;
  });

  const taskMs = Date.now() - sentAt;
  await sleep(2000);
  const pageAfter = await rp.evaluate(page, PAGE_STATE).catch(() => null);
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  await rp.screenshot(page, join(artifacts, "page.png"));
  const newReplies = finalPanel.replies.slice(repliesBefore);
  const newErrors = finalPanel.errorMessages.slice(errorsBefore);
  observations.panel = { sawRunState: sawRun, model: finalPanel.model, newReplies };
  observations.page = pageAfter;
  await writeFile(join(artifacts, "panel-transcript.txt"), finalPanel.transcript);

  const saveRequests = requests.filter((r) => r.path === "/save");
  verdicts.c6_fillWithoutSave = verdict(
    taskMs <= TASK_LIMIT_MS
      && pageAfter?.codename === "星河"
      && pageAfter?.name === ORIGINAL.name
      && pageAfter?.owner === ORIGINAL.owner
      && saveRequests.length === 0
      && newReplies.some((reply) => !reply.kind.includes("error"))
      && newErrors.length === 0,
    { taskMs, page: pageAfter, saveRequests, newReplyKinds: newReplies.map((reply) => reply.kind), newErrors },
  );

  // ── 5. 剪贴板路由：只调 finish，不写剪贴板；看扩展后台把请求发去了哪 ──
  const sw = await rp.serviceWorker();

  if (sw) {
    const swSession = await rp.attach(sw.targetId);
    const requestUrls: string[] = [];

    const off = rp.cdp.onEvent("Network.requestWillBeSent", (message: { sessionId?: string; params: { request: { url: string } } }) => {
      if (message.sessionId === swSession) requestUrls.push(message.params.request.url);
    });

    await rp.cdp.send("Network.enable", {}, swSession);

    const reply = await rp.evaluate(swSession, `(async () => {
      const bridge = globalThis.__saClipboardBridge?.();
      if (!bridge) return { bridge: false };
      try { return { bridge: true, status: await bridge.finish(-1) }; }
      catch (e) { return { bridge: true, error: String(e?.message ?? e) }; }
    })()`);

    await sleep(500);
    off();
    await rp.detach(swSession);
    observations.clipboardRouting = { reply, requestUrls };
  } else {
    observations.clipboardRouting = { error: "找不到扩展后台" };
  }
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  closed = await rp.close();
  site.close();
}

// ── 6. 结束后的核对：测试伴随进程日志、构建产物、日常数据目录 ──
const hostLog = await rp.hostLog();

const clipboardLine = hostLog.split("\n").find((line) => line.includes("clipboard HTTP")) ?? null;

const hostClipboardPort = Number(clipboardLine?.match(/clipboard HTTP http:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? NaN);

const nativeConnected = hostLog.includes("面板已连接（native messaging）");

verdicts.c4_ownClipboardServer = verdict(
  dailyClipboardHolders.length === 0 ? null : Number.isInteger(hostClipboardPort) && hostClipboardPort !== DAILY_CLIPBOARD_PORT && !hostLog.includes("clipboard HTTP 未启动"),
  { dailyClipboardHolders, testHostLine: clipboardLine?.replace(/^\S+ /, "") ?? null },
);

const bundleFiles = (await readdir(rp.dirs.extension)).filter((file) => file.endsWith(".js"));

const bundleWith7761 = (await filesContaining(rp.dirs.extension, bundleFiles, String(DAILY_CLIPBOARD_PORT))).hits;

// SAFETY: clipboardRouting 只在上面两处写入，形状就是下面这个。
const routing = observations.clipboardRouting as { reply?: { bridge?: boolean; error?: string; status?: string }; requestUrls?: string[] } | undefined;

const expectedFinishUrl = Number.isInteger(hostClipboardPort) ? `http://127.0.0.1:${hostClipboardPort}/finish` : null;

verdicts.c5_clipboardRouting = verdict(
  !routing?.requestUrls?.length ? (bundleWith7761.length === 0 ? null : false)
    : bundleWith7761.length === 0
      && routing.requestUrls.every((url) => url === expectedFinishUrl)
      && routing.reply?.error === "no clipboard transaction",
  { bundleFilesContaining7761: bundleWith7761, expectedFinishUrl, ...routing },
);

// 用会话记录证明答话的是日常配置里的那个模型，而且至少有一条回复不是报错。
const [provider, ...modelParts] = (dailyModel ?? "").split("/");

const modelId = modelParts.join("/");

const replies = await modelReplies(rp.dirs.data);

const repliesByOutcome = Object.fromEntries(
  [...new Set(replies.map((r) => `${r.provider}/${r.model} ${r.stopReason}`))].map((key) => [key, replies.filter((r) => `${r.provider}/${r.model} ${r.stopReason}` === key).length]),
);

const answeredByDailyModel = replies.some((r) => r.provider === provider && r.model === modelId && r.stopReason !== "error" && r.stopReason !== "aborted");

verdicts.c2_realServices = verdict(
  nativeConnected && answeredByDailyModel && verdicts.c6_fillWithoutSave?.status === "yes",
  // SAFETY: observations.panel 只在任务结束时写入，带 model 字段。
  { nativeConnected, dailyModel, repliesByOutcome, panelModelChip: (observations.panel as { model?: string } | undefined)?.model ?? null },
);

const testDataFiles = [...(await snapshotDir(rp.dirs.data)).keys()];

const dailyAfter = await snapshotDir(DAILY_DATA_DIR);

const dailyChanged = changedFiles(dailyBefore, dailyAfter);

const dailyScan = await filesContaining(DAILY_DATA_DIR, dailyChanged, nonce);

const positiveControl = (await filesContaining(rp.dirs.data, testDataFiles, nonce)).hits;

const dailyConfigHashAfter = await sha256File(join(DAILY_DATA_DIR, "config.json"));

verdicts.c1_dataIsolation = verdict(
  positiveControl.length === 0 || dailyScan.unreadable.length > 0
    ? null
    : dailyScan.hits.length === 0 && dailyConfigHashBefore === dailyConfigHashAfter,
  {
    testDataFilesWithNonce: positiveControl,
    dailyChangedFiles: dailyChanged,
    dailyChangedFilesWithNonce: dailyScan.hits,
    dailyChangedFilesUnreadable: dailyScan.unreadable,
    dailyConfigUnchanged: dailyConfigHashBefore === dailyConfigHashAfter,
  },
);

verdicts.hostExited = verdict(closed?.exitedWithChrome ?? false, closed ?? {});

// ── 7. 产物 ──
await cp(rp.dirs.data, join(artifacts, "host-data"), { recursive: true });

await cp(join(rp.dirs.host, "wrapper-err.log"), join(artifacts, "host-wrapper-err.log")).catch(() => {});

observations.siteRequests = requests;

observations.chromeStderrTail = rp.chromeStderr().split("\n").filter((line) => /native|messaging|side.?panel|error/i.test(line)).slice(-20);

result.finishedAt = new Date().toISOString();

result.ok = !result.error && Object.values(verdicts).every((v) => v.status === "yes");

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
