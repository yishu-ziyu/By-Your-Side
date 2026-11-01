import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-stop-during-click`);
await mkdir(out, { recursive: true });
const calls: Array<{ path: string; at: number }> = [];
const site = createServer((req, res) => {
  if (["/started", "/resumed", "/clicked"].includes(req.url ?? "")) { calls.push({ path: req.url!, at: Date.now() }); req.resume(); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>按钮练习</title><h1>按钮练习</h1><p>这是用于检查按钮操作和停止的本机练习页面。</p><button id="go">继续</button><script>
    window.slow = true;
    document.querySelector('#go').addEventListener('mousemove', e => { if (e.isTrusted && window.slow) { window.slow = false; navigator.sendBeacon('/started'); const end = Date.now() + 5000; while (Date.now() < end) {} navigator.sendBeacon('/resumed'); } });
    document.querySelector('#go').addEventListener('click', e => { if (e.isTrusted) fetch('/clicked', {method:'POST'}); });
  </script>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const first = "练习一：点继续按钮。";
const second = "练习二：点继续按钮。";
const model = await startScriptedModel([
  { match: first, steps: [{ tool: { name: "click", args: { target: "#go", label: "继续" } } }, { text: "第一轮结束。" }] },
  { match: second, steps: [{ tool: { name: "click", args: { target: "#go", label: "继续" } } }, { text: "第二轮结束。" }] },
]);
const rp = await launchRealPath();
const result: Record<string, unknown> = {};
let panel: string | undefined;
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#send-btn")?.classList.contains("stopping")';
  await until(async () => await rp.evaluate(panel!, ready), 60_000, "侧栏就绪");
  await rp.evaluate(panel, `(() => { window.testStopClickedAt = null; document.querySelector("#send-btn").addEventListener("click", () => { window.testStopClickedAt = Date.now(); }, {capture:true}); return true; })()`);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, first); await rp.pressEnter(panel);
  await until(async () => calls.some(c => c.path === "/started"), 20_000, "点击鼠标移动已到达练习页");
  result.buttonBeforeStop = await rp.evaluate(panel, '({stopping:document.querySelector("#send-btn")?.classList.contains("stopping"),disabled:document.querySelector("#send-btn")?.disabled})');
  await rp.click(panel, "#send-btn");
  result.stopClickedAt = await rp.evaluate(panel, "window.testStopClickedAt");
  await until(async () => calls.some(c => c.path === "/resumed"), 10_000, "练习页恢复");
  await sleep(1500);
  result.clicksAfterStop = calls.filter(c => c.path === "/clicked").length;
  await until(async () => await rp.evaluate(panel!, ready), 30_000, "停止后就绪");
  const beforeControl = calls.filter(c => c.path === "/clicked").length;
  await rp.click(panel, "#input"); await rp.typeText(panel, second); await rp.pressEnter(panel);
  await until(async () => calls.filter(c => c.path === "/clicked").length > beforeControl, 20_000, "正常对照收到点击");
  result.clicksAfterControl = calls.filter(c => c.path === "/clicked").length;
} catch (error) {
  result.error = String(error);
  result.modelRequests = model.requests.map(r => ({ rule: r.rule, hasTools: !!r.tools }));
  if (panel) result.panelText = await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText?.slice(-2000) ?? document.body.innerText.slice(-2000)').catch(() => null);
}
finally {
  result.calls = calls;
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => site.close(() => resolve()));
}
const button = result.buttonBeforeStop as { stopping?: boolean; disabled?: boolean } | undefined;
const startedAt = calls.find(c => c.path === "/started")?.at;
const resumedAt = calls.find(c => c.path === "/resumed")?.at;
const pass = button?.stopping === true && button.disabled === false && typeof result.stopClickedAt === "number" && startedAt !== undefined && resumedAt !== undefined && result.stopClickedAt >= startedAt && result.stopClickedAt < resumedAt && result.clicksAfterStop === 0 && result.clicksAfterControl === 1 && !result.error;
console.log(pass ? "PASS" : "FAIL", JSON.stringify(result), out);
if (!pass) process.exitCode = 1;
