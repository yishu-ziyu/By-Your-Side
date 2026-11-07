import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-takeover-during-slow-step`);
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
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
  await until(async () => hung.length > 0 || null, 30000, "慢页面请求已发出");
  await until(async () => (await rp.evaluate(panel, '!document.querySelector("#takeover-btn")?.hidden')) || null, 10000, "接管键可点");
  await sleep(500);
  const t0 = Date.now();
  await rp.click(panel, "#takeover-btn");
  const read = async () => ({ banner: await rp.evaluate(panel, '(()=>{const b=document.querySelector("#handoff-banner");return b&&!b.hidden?b.textContent:""})()') as string, button: await rp.evaluate(panel, 'document.querySelector("#takeover-btn")?.textContent??""') as string, url: (await rp.targets()).filter(t => t.type === "page" && t.url.startsWith(origin)).map(t => t.url).join(",") });
  const OPERATING = "你在操作 · 助手在旁边等";
  const seen: string[] = [];
  let owned: number | null = null;
  while (Date.now() - t0 < 5000 && owned === null) { const now = await read(); const line = `${now.banner}|${now.button}`; if (seen.at(-1) !== line) { seen.push(line); console.log(`+${Date.now() - t0}ms`, line); } if (now.banner === OPERATING) owned = Date.now() - t0; else await sleep(50); }
  check("这一步被停下后才说页面归用户，且不超过 5 秒", owned !== null, { ownedMs: owned, seen });
  await rp.screenshot(panel, join(out, "owned.png"));
  hung.splice(0).forEach(f => f());
  await sleep(2500);
  const after = await read();
  check("页面归用户之后不再被助手这一步带走", !after.url.includes("/slow") && after.banner === OPERATING, after);
  await rp.click(panel, "#takeover-btn");
  const back = await until(async () => { const now = await read(); return now.banner === "" && now.button !== "交还" ? now : null; }, 15000, "交还后助手接着做").catch(() => null);
  check("按交还后助手接着做", back !== null, back as Json);
} catch (error) { check("流程完成", false, String(error)); } finally {
  hung.splice(0).forEach(f => f());
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, dependency: "real isolated extension and side panel, local page; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(r => site.close(() => r()));
}
console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
