/**
 * 发一句话时，材料区不再闪一下「正在发送，助手还没确认收到」就消失（用户 10-14 报的闪烁）。只装扩展、隔离构建、本机脚本模型、本机文章页。
 *   npx tsx scripts/acceptance/real-path/send-tray-quiet.mts --headless
 * 侧栏里用 MutationObserver 记下材料区出现过的每一段文字和时刻。
 *   a) 回执很快的普通发送：用户的话 0.5 秒内出现在对话里（本地反馈还在），材料区从头到尾没出现「正在发送」「还没确认收到」。
 *   b) 回执慢的发送（把扩展后台暂停 1.2 秒，消息转不到任务宿主；不能暂停宿主页本身，它和侧栏在同一个渲染进程里，会把侧栏一起冻住）：发出约 0.8 秒后材料区写「正在发送，助手还没确认收到」，宿主恢复、回执到了就消失。
 * 失败方式：把 SENDING_QUIET_MS 改成 0，a 失败（又会闪）；去掉到点重画（scheduleQuietEnd），b 失败（宿主卡住时材料区一直不出现）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-send-tray-quiet`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>三段的文章</title><body style="font:16px sans-serif;margin:40px">
<h1>三段的文章</h1><p>第一段。</p><p>第二段。</p><p>第三段。</p></body></html>`;

const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const FAST = "案例：这页标题是什么？";
const SLOW = "案例：这页有几段？";
const FAST_ANSWER = "标题是「三段的文章」。";
const SLOW_ANSWER = "这页有三段。";
const PENDING = /正在发送|还没确认收到/;
/** 暂停后台多久：比 0.8 秒的安静期长，材料区该亮就看得到；又比侧栏 1.5 秒的连接探活短，回执走原来的连接回来，不绕换连接那条路。 */
const HOST_PAUSE_MS = 1_200;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: FAST, steps: [{ text: FAST_ANSWER, delayMs: 1_200 }] },
  { match: SLOW, steps: [{ text: SLOW_ANSWER, delayMs: 1_200 }] },
]);

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

/** 材料区出现过的文字（相对发出时刻的毫秒数），由侧栏里的 MutationObserver 记下。 */
const WATCH_JS = `(() => {
  window.__tray = []; const t0 = performance.now();
  const read = () => { const el = document.querySelector(".task-bar"); const text = el && el.getClientRects().length ? el.textContent.trim() : ""; const last = window.__tray.at(-1); if (!last || last.text !== text) window.__tray.push({ ms: Math.round(performance.now() - t0), text }); };
  window.__trayObs?.disconnect(); window.__trayObs = new MutationObserver(read); window.__trayObs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); read(); return true; })()`;

const userShown = (text: string) => `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes(${JSON.stringify(text)}))`;
const answerShown = (text: string) => `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].some(m => m.getClientRects().length > 0 && m.textContent.includes(${JSON.stringify(text)}))`;

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  // a) 回执快的普通发送。
  await rp.click(panel, "#input");
  await rp.typeText(panel, FAST);
  await rp.evaluate(panel, WATCH_JS);
  const sentAt = Date.now();
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, userShown(FAST))) || undefined, 5_000, "用户的话出现", 25);
  const userMs = Date.now() - sentAt;
  await until(async () => (await rp.evaluate(panel, answerShown(FAST_ANSWER))) || undefined, 30_000, "快的回答出现", 100);
  await sleep(1_000);
  const fastTray = await rp.evaluate(panel, "window.__tray") as Array<{ ms: number; text: string }>;
  const flashed = fastTray.filter(s => PENDING.test(s.text));
  check("a 回执快时，用户的话 0.5 秒内出现，材料区从没出现「正在发送」", userMs <= 500 && flashed.length === 0, { userMs, flashed, tray: fastTray });

  // b) 回执慢的发送：暂停扩展后台，侧栏发出的话转不到任务宿主，回执就回不来。
  const host = (await rp.targets()).find(t => t.type === "service_worker" && t.url.endsWith("/background.js"));

  if (!host) throw new Error("找不到扩展后台 background.js");
  const hostSession = await rp.attach(host.targetId);
  await rp.cdp.send("Debugger.enable", {}, hostSession);
  await rp.click(panel, "#input");
  await rp.typeText(panel, SLOW);
  await rp.evaluate(panel, WATCH_JS);
  await rp.cdp.send("Debugger.pause", {}, hostSession);
  await rp.pressEnter(panel);
  await sleep(HOST_PAUSE_MS);
  await rp.screenshot(panel, join(out, "b-host-paused.png"));
  await rp.cdp.send("Debugger.resume", {}, hostSession);
  await until(async () => (await rp.evaluate(panel, answerShown(SLOW_ANSWER))) || undefined, 30_000, "慢的回答出现", 100);
  await sleep(1_000);
  const slowTray = await rp.evaluate(panel, "window.__tray") as Array<{ ms: number; text: string }>;
  const firstPending = slowTray.find(s => PENDING.test(s.text));
  const last = slowTray.at(-1);
  check("b 回执慢时，约 0.8 秒后材料区写「正在发送」，回执到了就消失", !!firstPending && firstPending.ms >= 700 && firstPending.ms < HOST_PAUSE_MS && !!last && !PENDING.test(last.text), { firstPending: firstPending ?? null, last: last ?? null, tray: slowTray });
  await rp.screenshot(panel, join(out, "c-panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
