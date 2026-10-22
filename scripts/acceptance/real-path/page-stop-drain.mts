/**
 * 网页上点「停」：只装扩展的隔离无头 Chrome、真侧栏、本机备注页与本机脚本模型。
 *
 *   npx tsx scripts/acceptance/real-path/page-stop-drain.mts --headless
 *
 * 助手跑一段约 4 秒的脚本：分 8 次往备注框里写字，最后向本机测试站点发一次保存。写到一半时用真鼠标点页面右边缘胶囊上的停止键。
 * 判据只看用户看得到的：「现在归你」出现以后，备注框不再被改、站点不再收到保存；点「继续」后助手接着做完。
 * 第二段跑一段约 25 秒的脚本再点停：那一步取消不了，停止只等 10 秒左右就交给用户，不卡在「正在停住」，侧栏如实说页面可能还会变。
 * 页面和测试脚本在同一台机器上，所以页面里的 Date.now() 和这里的可以直接比先后。
 * 证据在 out/acceptance/page-stop-drain/result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/page-stop-drain");
await mkdir(out, { recursive: true });

type Rect = { x: number; y: number; width: number; height: number };
type Tab = { shown: boolean; tone: string | null; a: string; b: string; end: string | null; endEnabled: boolean; rect: Rect | null; button: Rect | null };

const PAGE = `<!doctype html><meta charset="utf-8"><title>备注 · 订单 1024</title><style>body{margin:40px;font:15px/1.8 -apple-system,"PingFang SC",sans-serif;max-width:560px}textarea{width:100%;height:120px}</style>
<h1>订单 1024</h1><label>备注<textarea id="note"></textarea></label><script>window.writeLog=[]</script>`;

const saves: number[] = [];

const site = createServer((q, r) => {
  if ((q.url ?? "").startsWith("/save")) saves.push(Date.now());
  r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(PAGE);
});

await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const GOAL = "把备注慢慢写完再保存";
const LONG_GOAL = "把长备注慢慢写完再保存";
const script = (parts: number) => `(async () => {
  const note = document.querySelector("#note");
  for (let i = 1; i <= ${parts}; i++) { note.value += "第" + i + "段；"; window.writeLog.push(Date.now()); await new Promise(r => setTimeout(r, 500)); }
  await fetch("/save");
  return "saved";
})()`;

const model = await startScriptedModel([
  { match: GOAL, steps: [{ tool: { name: "js", args: { code: script(8) } }, delayMs: 300 }, { text: "备注写好并保存了。" }] },
  { match: LONG_GOAL, steps: [{ tool: { name: "js", args: { code: script(50) } }, delayMs: 300 }, { text: "长备注写好了。" }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

// SAFETY: 读数来自 CDP returnByValue，是可序列化的普通对象。
const asJson = (v: unknown) => v as Json;
const timeline: Array<{ at: number; tone: string | null; a: string; end: string | null }> = [];

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  // 胶囊的读数在扩展的隔离环境里，网页自己的环境读不到：按会话记下隔离环境，逐个试。
  const isolated = new Set<number>();

  rp.cdp.onEvent("Runtime.executionContextCreated", (m: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (m.sessionId === work && m.params.context.auxData?.type === "isolated" && m.params.context.origin.startsWith("chrome-extension://")) isolated.add(m.params.context.id);
  });
  rp.cdp.onEvent("Runtime.executionContextDestroyed", (m: { sessionId?: string; params: { executionContextId: number } }) => { if (m.sessionId === work) isolated.delete(m.params.executionContextId); });

  const inExtension = async <T,>(expression: string): Promise<T | null> => {
    for (const contextId of [...isolated]) {
      // SAFETY: CDP Runtime.evaluate 返回 { result: { value } }；读数是可序列化的普通对象。
      const res = await rp.cdp.send("Runtime.evaluate", { expression: `(() => { const ns = globalThis.__sideagent; return ns?.cursor ? (${expression}) : undefined; })()`, contextId, returnByValue: true }, work).catch(() => null) as { result?: { value?: T } } | null;

      if (res?.result && res.result.value !== undefined) return res.result.value;
    }

    return null;
  };

  const tab = () => inExtension<Tab | null>("ns.edgeTab?.() ?? null");

  const mouseClick = async (r: Rect) => {
    const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "none" }, work);

    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 }, work);
  };

  await rp.cdp.send("Runtime.enable", {}, work);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 640, deviceScaleFactor: 1, mobile: false }, work);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => (await inExtension<boolean>("true")) ?? null, 15000, "备注页加载、扩展脚本就位");

  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  /** 脚本写到第二段时点胶囊上的停止键，等到「现在归你」，返回点击和出现的时刻。 */
  const stopMidway = async (label: string, waitMs: number) => {
    const before = Number(await rp.evaluate(work, "window.writeLog.length"));
    await until(async () => Number(await rp.evaluate(work, "window.writeLog.length")) >= before + 2 || null, 30000, `${label}：脚本开始往备注里写`);
    const stopTab = await until(async () => { const t = await tab(); return t?.shown && t.end === "stop" && t.button ? t : null; }, 5000, "胶囊上有停止键").catch(() => null);
    check(`${label}：脚本在写时胶囊上有停止键`, !!stopTab, asJson(stopTab));

    if (!stopTab) throw new Error("没有停止键可点");
    const clickedAt = Date.now();
    await mouseClick(stopTab.button!);
    let handAt: number | null = null;

    while (Date.now() - clickedAt < waitMs) {
      const t = await tab();

      if (t) timeline.push({ at: Date.now() - clickedAt, tone: t.tone, a: t.a, end: t.end });

      if (t?.a === "现在归你") { handAt = Date.now(); break; }
      await sleep(40);
    }

    check(`${label}：点停后出现「现在归你」`, handAt !== null, asJson({ ms: handAt === null ? null : handAt - clickedAt }));

    return { clickedAt, handAt };
  };

  await ask(GOAL);
  const { handAt } = await stopMidway("4 秒的脚本", 15000);

  if (handAt === null) throw new Error("没等到现在归你");
  // 留足时间：没修时脚本还要再写约 3 秒、再发保存。
  await sleep(4500);
  const writes = await rp.evaluate(work, "window.writeLog") as number[];
  const lateWrites = writes.filter(at => at > handAt!).map(at => at - handAt!);
  const lateSaves = saves.filter(at => at > handAt!).map(at => at - handAt!);
  check("「现在归你」出现以后，备注框不再被助手改", lateWrites.length === 0, asJson({ lateWritesMs: lateWrites, writes: writes.length }));
  check("「现在归你」出现以后，站点不再收到保存", lateSaves.length === 0, asJson({ lateSavesMs: lateSaves, saves: saves.length }));
  await rp.screenshot(work, join(out, "handed.png"));

  const hand = await tab();
  check("「现在归你」带可点的「继续」", hand?.a === "现在归你" && hand.end === "继续" && hand.endEnabled && !!hand.button, asJson(hand));

  if (hand?.button) {
    await mouseClick(hand.button);
    const done = await until(async () => (await rp.evaluate(panel, '!!document.querySelector("#messages")?.innerText.includes("备注写好并保存了")')) || null, 30000, "交还后接着做完").catch(() => null);
    check("点「继续」交还后，助手接着做完", !!done, asJson({ done: !!done }));
  }

  // ── 那一步一直不结束：等到上限就交给用户，并如实说页面可能还会变 ──
  timeline.push({ at: -1, tone: null, a: "第二段", end: null });
  await ask(LONG_GOAL);
  const long = await stopMidway("25 秒的脚本", 30000);
  const waited = long.handAt === null ? null : long.handAt - long.clickedAt;
  // 上限 10 秒；负载高时页面上的显示会晚一些，但远早于脚本写完的约 24 秒。
  check("那一步一直不结束时，停止等到上限就交给用户，不卡在「正在停住」", waited !== null && waited >= 8000 && waited <= 18000, asJson({ waitedMs: waited }));
  const said = await until(async () => (await rp.evaluate(panel, '!!document.body.innerText.includes("这一页可能还会被它改动")')) || null, 8000, "侧栏提示").catch(() => null);
  check("侧栏如实说「这一页可能还会被它改动」", !!said, asJson({ said: !!said }));
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, timeline, saves, notCovered: ["真实网站", "真实模型", "两个窗口同时开侧栏", "超时后那一步仍会继续改页面（取消不了，只如实提示）"], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
