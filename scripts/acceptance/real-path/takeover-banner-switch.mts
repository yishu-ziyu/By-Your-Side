/**
 * 接管时换会话：只装扩展的隔离无头 Chrome、真侧栏、本机练习页与本机脚本模型。
 * 会话 A 在干活时用户点「接管」，侧栏写「你在操作 · 助手在旁边等」；新开会话 B，B 里不该再挂这一行；
 * 点顶上的「…：标题 ↗」切回 A，A 的页面仍归用户，这一行要回来。
 *   npx tsx scripts/acceptance/real-path/takeover-banner-switch.mts --headless
 * 证据在 out/acceptance/real-path/<时间>-takeover-banner-switch/：三张侧栏截图和 result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-takeover-banner-switch`);
await mkdir(out, { recursive: true });
const PAGE = `<!doctype html><meta charset="utf-8"><title>购物车练习页</title><h1>购物车</h1>${[1, 2, 3].map(i => `<button id="add${i}" onclick="document.querySelector('#n').textContent=++window.added">加入购物车 ${i}</button>`).join(" ")}<p>已加 <span id="n">0</span> 件</p><script>window.added=0</script>`;
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(PAGE));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const GOAL = "慢慢把三样都加进购物车";
const add = (i: number) => ({ tool: { name: "click", args: { target: `#add${i}` } }, delayMs: 2500 });
const model = await startScriptedModel([
  { match: GOAL, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }, add(1), add(2), add(3), { text: "三样都加好了。" }] },
]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await ready();
  await rp.cdp.send("Page.bringToFront", {}, work);
  // SAFETY: 表达式只返回 { shown, text } 这样的普通对象。
  const banner = () => rp.evaluate(panel, '(()=>{const b=document.querySelector("#handoff-banner");return{shown:!!b&&!b.hidden,text:b?.textContent??""}})()') as Promise<{ shown: boolean; text: string }>;
  const settle = async (want: (b: { shown: boolean; text: string }) => boolean, ms: number) => { const end = Date.now() + ms; let b = await banner(); while (!want(b) && Date.now() < end) { await sleep(200); b = await banner(); } return b; };
  const OPERATING = "你在操作 · 助手在旁边等";

  await rp.click(panel, "#input"); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
  await until(async () => Number(await rp.evaluate(work, "window.added")) > 0 || null, 30000, "接管前点了第一下");
  await until(async () => (await rp.evaluate(panel, '!document.querySelector("#takeover-btn")?.hidden')) || null, 10000, "接管键可点");
  await rp.click(panel, "#takeover-btn");
  const inA = await settle(b => b.shown && b.text === OPERATING, 10000);
  check("会话 A 接管后写「你在操作 · 助手在旁边等」", inA.shown && inA.text === OPERATING, inA);
  await rp.screenshot(panel, join(out, "1-a-taken-over.png"));

  await rp.click(panel, "#conversation-new"); await ready();
  // 新会话画好之后再读：给它 3 秒，旧行还在就算没清。
  await sleep(3000);
  const inB = await banner();
  check("新开会话 B：不再挂「你在操作」", !inB.shown, inB);
  await rp.screenshot(panel, join(out, "2-b-new-conversation.png"));

  const back = await until(async () => (await rp.evaluate(panel, '(()=>{const b=document.querySelector("#conversation-background");return b&&!b.hidden?b.textContent:null})()')) || null, 10000, "顶上出现回到会话 A 的入口").catch(() => null);
  check("顶上出现回到会话 A 的入口", !!back, back as Json);
  if (back) await rp.click(panel, "#conversation-background");
  const backInA = await settle(b => b.shown && b.text === OPERATING, 8000);
  check("切回会话 A：页面仍归用户，「你在操作」回来", backInA.shown && backInA.text === OPERATING, backInA);
  await rp.screenshot(panel, join(out, "3-back-to-a.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, dependency: "real isolated extension and side panel, local page; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
