/**
 * 提示音（docs/evals/20261015-attention-cues.md）：用户没在看侧栏所在的窗口时，任务做完响一声「做完」；在看时不响；设置关掉不响。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/attention-cues.mts
 * 「没在看」要真实的窗口焦点：无头 Chrome 的窗口总在前台，所以 A、C 用有窗口的 Chrome，在后台启动、不抢用户焦点，
 * 它的窗口本来就不在前台，正是用户在别的应用里的情形。运行时不要点那个窗口，点了这次不算数。
 *   A) 有窗口、窗口不在前台：做完一个任务 → 听到一次「做完」三音（523/659/784 Hz），且有声音输出。
 *   C) 同一个浏览器，在设置页把「提示音」关掉 → 再做完一个任务 → 没有声音。
 *   B) 无头、窗口在前台：做完一个任务 → 没有声音。
 * 听到什么：侧栏页面加载前注入观察脚本（Page.addScriptToEvaluateOnNewDocument），记下每个振荡器开始时的频率，
 * 并在输出端前挂一个分析器读峰值。不读产品模块的内部状态。
 * 失败方式：把「用户不在」改成看 document.hasFocus()，A 失败（侧栏里点过输入框，hasFocus 为真）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-attention-cues`);

await mkdir(artifacts, { recursive: true });

const ASKS = { a: "提示音甲：说一句好。", c: "提示音丙：说一句好。", b: "提示音乙：说一句好。" };

const model = await startScriptedModel(Object.entries(ASKS).map(([key, ask]) => ({ match: ask, steps: [{ text: `好的。【${key}完成】` }] })));

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

const configItems = {
  inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
  "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
};

/** 开一个隔离浏览器、打开侧栏、接好脚本模型、注入观察脚本后重载侧栏。 */
async function openPanel(headed: boolean) {
  const rp = await launchRealPath({ headed });
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(configItems)}).then(() => true)`);
  await rp.cdp.send("Page.enable", {}, panel);
  await rp.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LISTEN }, panel);
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, '!!window.__heard && document.querySelector("#send-btn")?.disabled === false').catch(() => false) || undefined, 60_000, "侧栏就绪");

  return { rp, panel };
}

/** 发一句、等回答出现，再等 2.5 秒（提示音不到 1 秒），返回这段时间听到的。 */
async function finishTask(rp: Awaited<ReturnType<typeof launchRealPath>>, panel: string, key: keyof typeof ASKS): Promise<Heard & { focused: boolean }> {
  await rp.evaluate(panel, "window.__heard.starts = []; window.__heard.peak = 0; true");
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASKS[key]);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.includes("【${key}完成】")`)) || undefined, 60_000, `${key}: 回答出现`, 100);
  await until(async () => await rp.evaluate(panel, '!document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 30_000, `${key}: 任务结束`, 100);
  await sleep(2_500);
  await rp.screenshot(panel, join(artifacts, `${key}.png`));

  return await rp.evaluate(panel, "chrome.windows.getCurrent().then(w => ({ ...window.__heard, focused: w.focused }))") as Heard & { focused: boolean };
}

const DONE_HZ = [523.25, 659.25, 783.99];
const evidence: Record<string, unknown> = {};
let error: string | null = null;

try {
  // A、C：有窗口，窗口不在前台。
  const headed = await openPanel(true);

  try {
    const a = await finishTask(headed.rp, headed.panel, "a");
    evidence.a = a;
    assert.equal(a.focused, false, `a: precondition — the panel's window is not in front: ${JSON.stringify(a)}`);
    assert.deepEqual(a.starts.map(s => Math.round(s.hz * 100) / 100), DONE_HZ, `a: one done cue (three tones) plays: ${JSON.stringify(a)}`);
    assert.ok(a.starts.every(s => s.state === "running") && a.peak > 0.05, `a: the cue reaches the output: ${JSON.stringify(a)}`);

    // C：在设置页关掉「提示音」。
    const { rp } = headed;
    const settingsTab = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html`, background: true })).targetId;
    const settings = await rp.attach(settingsTab);
    await until(async () => await rp.evaluate(settings, 'document.querySelector("#attention-cues")?.checked === true').catch(() => false) || undefined, 15_000, "c: 设置页的提示音默认开");
    await rp.evaluate(settings, 'document.querySelector("#attention-cues").scrollIntoView({ block: "center" }); true');
    await rp.click(settings, "#attention-cues");
    await until(async () => await rp.evaluate(settings, 'chrome.storage.local.get("sideagent_attention_cues").then(s => s.sideagent_attention_cues === false)') || undefined, 5_000, "c: 关掉已保存");
    await rp.screenshot(settings, join(artifacts, "c-settings.png"));
    await rp.cdp.send("Target.closeTarget", { targetId: settingsTab });
    const c = await finishTask(rp, headed.panel, "c");
    evidence.c = c;
    assert.equal(c.focused, false, `c: precondition — the panel's window is not in front: ${JSON.stringify(c)}`);
    assert.deepEqual(c.starts, [], `c: no cue after the setting is off: ${JSON.stringify(c)}`);
  } finally {
    await headed.rp.close();
    await headed.rp.remove();
  }

  // B：无头，窗口在前台。
  const front = await openPanel(false);

  try {
    const b = await finishTask(front.rp, front.panel, "b");
    evidence.b = b;
    assert.equal(b.focused, true, `b: precondition — the panel's window is in front: ${JSON.stringify(b)}`);
    assert.deepEqual(b.starts, [], `b: no cue while the user looks at the panel's window: ${JSON.stringify(b)}`);
  } finally {
    await front.rp.close();
    await front.rp.remove();
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; A and C in a background headed Chrome", evidence, error }, null, 2));
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
