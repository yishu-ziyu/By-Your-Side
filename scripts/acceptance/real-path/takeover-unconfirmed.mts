import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-takeover-unconfirmed`);
await mkdir(out, { recursive: true });
const hung: Array<() => void> = [];
const site = createServer((q, r) => {
  if (q.url?.startsWith("/slow")) { hung.push(() => r.writeHead(200, { "content-type": "text/html" }).end("<title>慢页</title>slow")); return; }
  r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<!doctype html><title>起始页</title><h1>起始页</h1>");
});
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const GOAL = "打开那个很慢的页面";
const model = await startScriptedModel([{ match: GOAL, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "navigate", args: { url: `${origin}slow`, timeout: 60 } } }, { text: "打开了。" }] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  // WHY: 只让助手文档丢掉接管请求，这是“10 秒没确认”的真实条件，不用往产品里加测试开关；暂停文档不行，它和侧栏共用一个进程。
  const agent = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30000, "助手文档"))!.targetId);
  await rp.cdp.send("Page.enable", {}, agent);
  await rp.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `{ const add = chrome.runtime.onConnect.addListener.bind(chrome.runtime.onConnect); chrome.runtime.onConnect.addListener = (listener) => add((port) => { const on = port.onMessage.addListener.bind(port.onMessage); port.onMessage.addListener = (fn) => on((message, from) => { if (message?.type !== "takeover") fn(message, from); }); listener(port); }); }` }, agent);
  await rp.cdp.send("Page.reload", {}, agent);
  await sleep(1500);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
  await until(async () => hung.length > 0 || null, 30000, "慢页面请求已发出");
  await until(async () => (await rp.evaluate(panel, '!document.querySelector("#takeover-btn")?.hidden')) || null, 10000, "接管键可点");
  await sleep(500);
  const read = async () => await rp.evaluate(panel, `(()=>{const banner=document.querySelector("#handoff-banner"),button=document.querySelector("#takeover-btn");return {banner:banner&&!banner.hidden?banner.textContent:"",button:button?.textContent??"",disabled:!!button?.disabled,hidden:!!button?.hidden,text:document.querySelector("#messages")?.innerText.slice(-200)??""}})()`) as { banner: string; button: string; disabled: boolean; hidden: boolean; text: string };
  const free = (now: Awaited<ReturnType<typeof read>>) => now.banner === "" && !now.disabled;
  await rp.click(panel, "#takeover-btn");
  await until(async () => (await read()).banner.includes("暂停") || null, 5000, "显示正在暂停助手");
  const released = await until(async () => { const now = await read(); return free(now) ? now : null; }, 20000, "接管没确认后侧栏不再卡住").catch(() => null);
  const stuck = await read();
  await rp.screenshot(panel, join(out, "after-unconfirmed.png"));
  check("助手 10 秒没确认后，侧栏不再停在接管中", released !== null, stuck as unknown as Json);
  check("用户看到接管没有成功", stuck.text.includes("助手没有确认接管"), stuck.text);
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false') || null, 30000, "侧栏重开");
  await sleep(1500);
  const reopened = await read();
  await rp.screenshot(panel, join(out, "reopened.png"));
  check("重开侧栏后也不回到接管中", free(reopened), reopened as unknown as Json);
} catch (error) { check("流程完成", false, String(error)); } finally {
  hung.splice(0).forEach(f => f());
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, dependency: "real isolated extension and side panel, local page; scripted model; agent document paused via CDP" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(r => site.close(() => r()));
}
console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
