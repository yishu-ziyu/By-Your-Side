/**
 * 样板用例：用户在真侧栏里说「把代号填成星河，不要保存」。
 * 判定只看结果：练习页「代号」框的值、练习站收到的请求、侧栏状态，以及日常数据目录有没有被写。
 * 不对模型的措辞做断言；回复有没有把做了什么说清楚，由人看截图判断。
 *
 * 只装扩展：不注册伴随进程，agent 跑在扩展的 offscreen 文档里；模型配置写进扩展存储（与设置页写入格式相同），
 * 凭据取自 ~/.sideagent/providers.local.json。原先靠伴随进程数据目录（会话 JSONL、agent.log）的判据，
 * 改用设置页导出的诊断记录、offscreen 发出的网络请求和扩展后台的剪贴板桥读数，逐条注明在判据旁。
 *
 *   npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless [--model=provider/id]
 *
 * 验收文件：docs/evals/20260923-real-path-first-case.md
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DAILY_DATA_DIR, REPO, changedFiles, exportDiagnosticsViaSettings, filesContaining, launchRealPath, listenerPids, requireHeadless, sha256File, shadowedSources, siteAddress, sleep, snapshotDir, until, watchInproc } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const INSTRUCTION = "把代号填成星河，不要保存";

const TASK_LIMIT_MS = 5 * 60_000;

const DAILY_CLIPBOARD_PORT = 7761;

const nonce = `rp${randomBytes(6).toString("hex")}`;

// 模型来自 ~/.sideagent/providers.local.json；--model=provider/id 指定，默认 DEFAULT_TEST_MODEL。
const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

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
    streaming: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing]"),
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

/** n/a：只装扩展时没有对应对象（如伴随进程自己的剪贴板服务），照实记下原因，不算通过也不算失败。 */
type Verdict = { status: "yes" | "no" | "未确定" | "n/a"; evidence: JsonRecord };

const verdict = (pass: boolean | null, evidence: JsonRecord): Verdict => ({ status: pass === null ? "未确定" : pass ? "yes" : "no", evidence });

// 日常配置里的模型只作环境记录；只装扩展时答话的是 --model 指定、写进扩展存储的那个。
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
  mode: "extension only (no native host)",
  model: modelArg,
  dailyModel,
  dailyClipboardHolders,
  staleJsInExtensionBuild: shadowed.filter((s) => s.sourceNewer).map((s) => s.file),
  untrackedJsShadowingTs: shadowed.length,
};

const result: JsonRecord = {
  case: "codename-no-save",
  instruction: INSTRUCTION,
  acceptance: "docs/evals/20260923-real-path-first-case.md",
  command: `npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless --model=${modelArg}`,
  startedAt: startedAt.toISOString(),
  nonce,
  environment,
};

const verdicts: Record<string, Verdict> = {};

const observations: JsonRecord = {};

result.verdicts = verdicts;

result.observations = observations;

const rp = await launchRealPath({ withoutNativeHost: true });

environment.browser = rp.browser;

environment.extensionId = rp.extensionId;

let closed: Awaited<ReturnType<typeof rp.close>> | null = null;

let inproc: Awaited<ReturnType<typeof watchInproc>> | null = null;

/** 设置页「诊断记录 → 导出」下载的任务记录（jsonl）；代替伴随进程数据目录里的会话记录。 */
let exportedTraces = "";

let storedModel: JsonRecord | null = null;

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

  // ── 2. 真侧栏连上扩展内 agent，并认出当前页 ──
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // 与设置页保存写入的格式相同：相当于用户已在设置里选好服务商、填好 key。
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  // SAFETY: inproc_model_config 由上一行写入，形状是 { provider, modelId }。
  storedModel = await rp.evaluate(panel, `chrome.storage.local.get("inproc_model_config").then((s) => s.inproc_model_config ?? null)`) as JsonRecord | null;
  inproc = await watchInproc(rp, rp.extensionId);

  const ready = await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);

    if (state.setupVisible) throw new Error(`侧栏打开了调试通道设置页：${state.setupError || "没有错误信息"}`);

    return state.connected && state.pill?.includes("项目设置") ? state : undefined;
  }, 90_000, "侧栏连上扩展内 agent 并认出练习页", 500);

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

  // ── 5b. 像用户一样从设置页导出诊断记录：代替伴随进程的会话 JSONL 作为「谁答的话」和含 nonce 的正对照 ──
  const exported = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "diagnostics"));
  exportedTraces = exported.traces;
  observations.diagnosticsExport = exported.exportStatus;
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  if (inproc) {
    await writeFile(join(artifacts, "inproc-console.log"), inproc.logs()).catch(() => {});
    await writeFile(join(artifacts, "inproc-requests.json"), JSON.stringify(inproc.requestsBetween(0), null, 2)).catch(() => {});
  }

  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  closed = await rp.close();
  site.close();
}

// ── 6. 结束后的核对：构建产物、扩展侧读数、日常数据目录 ──
// c4 原判据读测试伴随进程的 agent.log，确认它的剪贴板服务没占日常的 7761。只装扩展时根本不起伴随进程，
// 也就没有自己的剪贴板服务可查；「不拉起本机进程」由 noLocalHost 判定，这条照实记 n/a。
verdicts.c4_ownClipboardServer = {
  status: "n/a",
  evidence: { reason: "只装扩展，没有伴随进程，也就没有它自己的剪贴板 HTTP 服务；是否拉起本机进程见 noLocalHost", dailyClipboardHolders },
};

const bundleFiles = (await readdir(rp.dirs.extension)).filter((file) => file.endsWith(".js"));

const bundleWith7761 = (await filesContaining(rp.dirs.extension, bundleFiles, String(DAILY_CLIPBOARD_PORT))).hits;

// SAFETY: clipboardRouting 只在上面两处写入，形状就是下面这个。
const routing = observations.clipboardRouting as { reply?: { bridge?: boolean; error?: string; status?: string }; requestUrls?: string[] } | undefined;

// c5 原判据：请求只发往测试伴随进程报的剪贴板端口。只装扩展时没有伴随进程端口可发，
// 改判：构建产物不含 7761，剪贴板桥调用不发出任何请求（尤其不回退到日常的 7761），并明确报错。
verdicts.c5_clipboardRouting = verdict(
  !routing?.reply?.bridge ? (bundleWith7761.length === 0 ? null : false)
    : bundleWith7761.length === 0
      && (routing.requestUrls ?? []).length === 0
      && (routing.reply.error ?? "").length > 0,
  { bundleFilesContaining7761: bundleWith7761, expectedRequests: 0, ...routing },
);

// 原判据读伴随进程的 Pi 会话 JSONL；只装扩展时改读设置页导出的诊断记录：
// message_end 行带整条助手消息（provider、model、stopReason），run_start 行带当时的模型名。
type TraceRow = { type?: string; data?: { model?: string; message?: { role?: string; provider?: string; model?: string; stopReason?: string } } };

const traceRows = exportedTraces.split("\n").filter(Boolean).flatMap((line): TraceRow[] => {
  try {
    // SAFETY: 导出文件每行是 run-trace-core 写的 { type, data } 对象；解析失败的行丢弃。
    return [JSON.parse(line) as TraceRow];
  } catch {
    return [];
  }
});

const replies = traceRows.flatMap((row) => {
  const message = row.type === "message_end" ? row.data?.message : undefined;

  return message?.role === "assistant" ? [{ provider: String(message.provider), model: String(message.model), stopReason: String(message.stopReason) }] : [];
});

const runStartModels = [...new Set(traceRows.filter((row) => row.type === "run_start").map((row) => String(row.data?.model ?? "")))];

const { providerId: provider, modelId } = plan;

const repliesByOutcome = Object.fromEntries(
  [...new Set(replies.map((r) => `${r.provider}/${r.model} ${r.stopReason}`))].map((key) => [key, replies.filter((r) => `${r.provider}/${r.model} ${r.stopReason}` === key).length]),
);

const answeredByChosenModel = replies.some((r) => r.provider === provider && r.model === modelId && r.stopReason !== "error" && r.stopReason !== "aborted");

// 原判据里的「面板经 native messaging 连上伴随进程」换成：扩展存储里的模型就是所选的那个，
// 且 offscreen 里的 agent 确实向外发出了成功的模型请求（非扩展自身、非练习站）。
const storedMatches = storedModel?.provider === provider && storedModel?.modelId === modelId;

const siteOrigin = new URL(pageUrl).origin;

const outboundCalls = (inproc?.requestsBetween(0) ?? []).filter((r) => r.method === "POST" && /^https?:/.test(r.url) && !r.url.startsWith(siteOrigin))
  .map((r) => ({ host: new URL(r.url).host, status: r.status, failed: r.failed }));

const okModelCalls = outboundCalls.filter((c) => c.status !== null && c.status >= 200 && c.status < 300).length;

verdicts.c2_realServices = verdict(
  storedMatches && okModelCalls > 0 && answeredByChosenModel && verdicts.c6_fillWithoutSave?.status === "yes",
  // SAFETY: observations.panel 只在任务结束时写入，带 model 字段。
  { model: modelArg, storedModel, runStartModels, repliesByOutcome, outboundHosts: [...new Set(outboundCalls.map((c) => c.host))], okModelCalls, failedModelCalls: outboundCalls.length - okModelCalls, panelModelChip: (observations.panel as { model?: string } | undefined)?.model ?? null },
);

const dailyAfter = await snapshotDir(DAILY_DATA_DIR);

const dailyChanged = changedFiles(dailyBefore, dailyAfter);

const dailyScan = await filesContaining(DAILY_DATA_DIR, dailyChanged, nonce);

// 正对照原先是「测试伴随进程数据目录里能找到 nonce」；只装扩展时测试侧的记录就是导出的诊断记录（run_start 带当前页网址）。
const positiveControl = exportedTraces.includes(nonce) ? ["diagnostics/by-your-side-traces-*.jsonl"] : [];

const dailyConfigHashAfter = await sha256File(join(DAILY_DATA_DIR, "config.json"));

verdicts.c1_dataIsolation = verdict(
  positiveControl.length === 0 || dailyScan.unreadable.length > 0
    ? null
    : dailyScan.hits.length === 0 && dailyConfigHashBefore === dailyConfigHashAfter,
  {
    testRecordsWithNonce: positiveControl,
    dailyChangedFiles: dailyChanged,
    dailyChangedFilesWithNonce: dailyScan.hits,
    dailyChangedFilesUnreadable: dailyScan.unreadable,
    dailyConfigUnchanged: dailyConfigHashBefore === dailyConfigHashAfter,
  },
);

// 原判据 hostExited：伴随进程随 Chrome 退出。只装扩展时改判：整个运行没有拉起任何本机伴随进程。
verdicts.noLocalHost = verdict(closed !== null && closed.hostPids.length === 0, closed ?? {});

// ── 7. 产物（诊断记录已在 diagnostics/，offscreen 日志与请求在 inproc-*.{log,json}）──
observations.siteRequests = requests;

observations.chromeStderrTail = rp.chromeStderr().split("\n").filter((line) => /native|messaging|side.?panel|error/i.test(line)).slice(-20);

result.finishedAt = new Date().toISOString();

result.ok = !result.error && Object.values(verdicts).every((v) => v.status === "yes" || v.status === "n/a");

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
