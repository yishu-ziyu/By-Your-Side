/**
 * 提示音（docs/evals/20261015-attention-cues.md）：用户没在看任何开着侧栏的窗口时，任务做完响一声「做完」；在看时不响；设置关掉不响。
 * 只装扩展、隔离构建、本机脚本模型；目标核对请求经本机转发服务改写成脚本结论。
 *   npx tsx scripts/acceptance/real-path/attention-cues.mts
 * 「没在看」要真实的窗口焦点：无头 Chrome 总有一个窗口在前台，所以 A、D、C 用有窗口的 Chrome，在后台启动、不抢用户焦点，
 * 它的窗口本来就不在前台，正是用户在别的应用里的情形。运行时不要点那个窗口，点了这次不算数。所以不进 run-all 整轮。
 *   A) 有窗口、窗口不在前台：做完一个任务 → 听到一次「做完」三音（523/659/784 Hz），且有声音输出。
 *   D) 同上，目标核对先判「接着做」、续做后判「做完」→ 整个任务只听到一次「做完」。
 *   C) 同一个浏览器，在设置页把「提示音」关掉 → 再做完一个任务 → 没有声音。
 *   B) 无头、开着侧栏的窗口在前台：做完一个任务 → 没有声音。
 *   E) 无头、几个窗口：前台窗口没开侧栏 → 侧栏响一次；前台窗口也开着侧栏 → 两个侧栏都不响；
 *      前台换到第三个没开侧栏的窗口 → 两个侧栏加起来只响一次。
 * 听到什么：侧栏页面加载前注入观察脚本（Page.addScriptToEvaluateOnNewDocument），记下每个振荡器开始时的频率，
 * 并在输出端前挂一个分析器读峰值。不读产品模块的内部状态。
 * 失败方式：去掉「等核对结论再响」，D 听到两次「做完」（结果写在 PR 描述里）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-attention-cues`);

await mkdir(artifacts, { recursive: true });

const ASKS = { a: "提示音甲：说一句好。", c: "提示音丙：说一句好。", b: "提示音乙：说一句好。", e1: "提示音戊一：说一句好。", e2: "提示音戊二：说一句好。", e3: "提示音戊三：说一句好。" };

const TASK_D = "提示音丁：看看开着哪些标签页";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

// 规则按数组顺序匹配：续做的提示里也带着任务原话，所以 [GOAL CHECK] 放在最前。
const model = await startScriptedModel([
  { match: "[GOAL CHECK]", steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: "补上了。【d完成】" }] },
  { match: TASK_D, steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: "开着一个标签页。" }] },
  ...Object.entries(ASKS).map(([key, ask]) => ({ match: ask, steps: [{ text: `好的。【${key}完成】` }] })),
  { match: "GOAL-CHECK-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", remaining: "再列一次标签页" }) }] },
  { match: "GOAL-CHECK-DONE", steps: [{ text: JSON.stringify({ status: "done" }) }] },
]);

/** 接下来几次目标核对依次怎么判；用完后一律判做完。 */
let verdicts: Array<"continue" | "done"> = [];

let checks = 0;

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    checks += 1;
    const verdict = verdicts.shift() ?? "done";
    // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
    const payload = JSON.parse(body) as Record<string, unknown>;
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: verdict === "continue" ? "GOAL-CHECK-CONTINUE" : "GOAL-CHECK-DONE" }] });
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>练习页</title><h1>练习页</h1>");
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

/** 只观察，不改变声音：振荡器开始时记频率；连到输出端的节点先经过一个分析器，再到输出端。 */
const LISTEN = `(() => {
  const heard = window.__heard = { starts: [], peak: 0 };
  const taps = new WeakMap();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest !== this.context.destination) return connect.call(this, dest, ...rest);
    let tap = taps.get(this.context);
    if (!tap) {
      tap = this.context.createAnalyser();
      connect.call(tap, this.context.destination);
      taps.set(this.context, tap);
      const buf = new Float32Array(tap.fftSize);
      setInterval(() => { tap.getFloatTimeDomainData(buf); for (const v of buf) heard.peak = Math.max(heard.peak, Math.abs(v)); }, 20);
    }
    connect.call(this, tap, ...rest);
    return dest;
  };
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...args) {
    heard.starts.push({ hz: this.frequency.value, state: this.context.state });
    return start.apply(this, args);
  };
})();`;

type Heard = { starts: Array<{ hz: number; state: string }>; peak: number };

type Browser = Awaited<ReturnType<typeof launchRealPath>>;

const configItems = {
  inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
  "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
};

/** 给一个已开的侧栏注入观察脚本，重载后等它就绪。 */
async function listenTo(rp: Browser, targetId: string): Promise<string> {
  const panel = await rp.attach(targetId);
  await rp.cdp.send("Page.enable", {}, panel);
  await rp.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LISTEN }, panel);
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, '!!window.__heard && document.querySelector("#send-btn")?.disabled === false').catch(() => false) || undefined, 60_000, "侧栏就绪");

  return panel;
}

/** 开一个隔离浏览器，工作标签页打开练习页，打开侧栏并接好脚本模型。 */
async function openBrowser(headed: boolean) {
  const rp = await launchRealPath({ headed });
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panelTarget = await rp.openSidePanel();
  await rp.evaluate(await rp.attach(panelTarget), `chrome.storage.local.set(${JSON.stringify(configItems)}).then(() => true)`);
  const panel = await listenTo(rp, panelTarget);

  return { rp, panel };
}

const FOCUS_JS = "Promise.all([chrome.windows.getLastFocused(), chrome.windows.getCurrent()]).then(([last, mine]) => ({ front: last.focused ? last.id : null, mine: mine.id }))";

/** 从 sender 发一句、等 done 文字出现、任务空闲后再等 2.5 秒（提示音不到 1 秒），返回每个侧栏这段时间听到的。 */
async function finishTask(rp: Browser, sender: string, listeners: string[], ask: string, done: string, settle: () => Promise<boolean> = async () => true) {
  for (const panel of listeners) await rp.evaluate(panel, "window.__heard.starts = []; window.__heard.peak = 0; true");
  await rp.click(sender, "#input");
  await rp.typeText(sender, ask);
  await rp.pressEnter(sender);
  await until(async () => (await rp.evaluate(sender, `document.querySelector("#messages")?.innerText.includes(${JSON.stringify(done)})`)) || undefined, 60_000, `${ask}: 回答出现`, 100);
  await until(async () => await rp.evaluate(sender, '!document.querySelector("#status-pill")?.classList.contains("running")') && await settle() || undefined, 60_000, `${ask}: 任务结束`, 100);
  await sleep(2_500);
  await rp.screenshot(sender, join(artifacts, `${done.replace(/[【】]/g, "")}.png`));
  const heard: Array<Heard & { front: number | null; mine: number }> = [];

  for (const panel of listeners) heard.push(await rp.evaluate(panel, `${FOCUS_JS}.then(f => ({ ...window.__heard, ...f }))`));

  return heard;
}

const hz = (h: Heard) => h.starts.map(s => Math.round(s.hz * 100) / 100);

const DONE_HZ = [523.25, 659.25, 783.99];

const evidence: Record<string, unknown> = {};

let error: string | null = null;

try {
  // A、D、C：有窗口，窗口不在前台。
  const headed = await openBrowser(true);

  try {
    const { rp, panel } = headed;
    const [a] = await finishTask(rp, panel, [panel], ASKS.a, "【a完成】");
    evidence.a = a;
    assert.equal(a.front, null, `a: precondition — no browser window is in front: ${JSON.stringify(a)}`);
    assert.deepEqual(hz(a), DONE_HZ, `a: one done cue (three tones) plays: ${JSON.stringify(a)}`);
    assert.ok(a.starts.every(s => s.state === "running") && a.peak > 0.05, `a: the cue reaches the output: ${JSON.stringify(a)}`);

    // D：核对先判接着做，续做后判做完。
    verdicts = ["continue", "done"];
    const before = checks;
    const [d] = await finishTask(rp, panel, [panel], TASK_D, "【d完成】", async () => checks >= before + 2);
    evidence.d = { ...d, checks: checks - before, continuations: model.requests.filter(r => r.rule === "[GOAL CHECK]" && r.step === 0).length };
    assert.equal(checks - before, 2, `d: precondition — two goal checks ran: ${JSON.stringify(evidence.d)}`);
    assert.deepEqual(hz(d), DONE_HZ, `d: exactly one done cue for the whole task: ${JSON.stringify(evidence.d)}`);

    // C：在设置页关掉「提示音」。
    const settingsTab = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html`, background: true })).targetId;
    const settings = await rp.attach(settingsTab);
    await until(async () => await rp.evaluate(settings, 'document.querySelector("#attention-cues")?.checked === true').catch(() => false) || undefined, 15_000, "c: 设置页的提示音默认开");
    await rp.evaluate(settings, 'document.querySelector("#attention-cues").scrollIntoView({ block: "center" }); true');
    await rp.click(settings, "#attention-cues");
    await until(async () => await rp.evaluate(settings, 'chrome.storage.local.get("sideagent_attention_cues").then(s => s.sideagent_attention_cues === false)') || undefined, 5_000, "c: 关掉已保存");
    await rp.screenshot(settings, join(artifacts, "c-settings.png"));
    await rp.cdp.send("Target.closeTarget", { targetId: settingsTab });
    const [c] = await finishTask(rp, panel, [panel], ASKS.c, "【c完成】");
    evidence.c = c;
    assert.equal(c.front, null, `c: precondition — no browser window is in front: ${JSON.stringify(c)}`);
    assert.deepEqual(c.starts, [], `c: no cue after the setting is off: ${JSON.stringify(c)}`);
  } finally {
    await headed.rp.close();
    await headed.rp.remove();
  }

  // B、E：无头。
  const front = await openBrowser(false);

  try {
    const { rp, panel: p1 } = front;
    const [b] = await finishTask(rp, p1, [p1], ASKS.b, "【b完成】");
    evidence.b = b;
    assert.equal(b.front, b.mine, `b: precondition — the panel's window is in front: ${JSON.stringify(b)}`);
    assert.deepEqual(b.starts, [], `b: no cue while the user looks at the panel's window: ${JSON.stringify(b)}`);

    // E1：前台换到一个没开侧栏的窗口。
    const w2 = Number(await rp.evaluate(p1, `chrome.windows.create({ url: "about:blank", focused: true }).then(w => w.id)`));
    const [e1] = await finishTask(rp, p1, [p1], ASKS.e1, "【e1完成】");
    evidence.e1 = e1;
    assert.equal(e1.front, w2, `e1: precondition — the new window without a panel is in front: ${JSON.stringify(e1)}`);
    assert.deepEqual(hz(e1), DONE_HZ, `e1: the panel plays once when the front window has no panel: ${JSON.stringify(e1)}`);

    // E2：前台窗口也开着侧栏。
    const known = new Set((await rp.targets()).map(t => t.targetId));
    const opened = await rp.evaluate(p1, `chrome.sidePanel.open({ windowId: ${w2} }).then(() => "opened", e => "error: " + e.message)`, { userGesture: true });
    assert.equal(opened, "opened", "e2: the second side panel opens");
    const second = await until(async () => (await rp.targets()).find(t => !known.has(t.targetId) && t.url.includes("/sidepanel.html")), 15_000, "e2: 第二个侧栏出现");
    const p2 = await listenTo(rp, second.targetId);
    const e2 = await finishTask(rp, p2, [p1, p2], ASKS.e2, "【e2完成】");
    evidence.e2 = e2;
    assert.equal(e2[1].front, e2[1].mine, `e2: precondition — the front window has a panel: ${JSON.stringify(e2)}`);
    assert.deepEqual(e2.map(h => h.starts.length), [0, 0], `e2: neither panel plays while the user looks at one: ${JSON.stringify(e2)}`);

    // E3：前台换到第三个没开侧栏的窗口。
    const w3 = Number(await rp.evaluate(p1, `chrome.windows.create({ url: "about:blank", focused: true }).then(w => w.id)`));
    const e3 = await finishTask(rp, p2, [p1, p2], ASKS.e3, "【e3完成】");
    evidence.e3 = e3;
    assert.equal(e3[0].front, w3, `e3: precondition — the third window is in front: ${JSON.stringify(e3)}`);
    assert.deepEqual(e3.flatMap(hz), DONE_HZ, `e3: the two panels together play one done cue: ${JSON.stringify(e3)}`);
  } finally {
    await front.rp.close();
    await front.rp.remove();
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model and goal-check verdicts; A, D and C in a background headed Chrome", evidence, error }, null, 2));
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
