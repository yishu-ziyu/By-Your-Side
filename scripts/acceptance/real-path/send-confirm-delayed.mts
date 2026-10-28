/** 隔离扩展：只读 JS 拒绝延迟写入及重定向请求，不得到达接收端。 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, sleep, until, REPO } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const redirect = process.argv.includes("--redirect");
const domBoundary = process.argv.includes("--dom-boundary");
const out = join(REPO, "out/acceptance/real-path", `send-confirm-delayed-${randomUUID()}`);
await mkdir(out, { recursive: true });
let writes = 0;
const site = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/search") { req.resume(); res.writeHead(307, { location: "/send" }); res.end(); return; }
  if (req.method === "POST" && req.url === "/send") { writes++; req.resume(); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Delayed send fixture</title><p id="draft">Ready</p><button id="relay">继续</button><script>window.fixturePageOnly=42;document.querySelector('#relay').onclick=()=>fetch('/send',{method:'POST',body:'fixture-dom-relay'});</script>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: "延迟发送检查", steps: [{ tool: { name: "js", args: { code: domBoundary ? "document.querySelector('#draft').textContent='DOM已改'; document.body.dataset.mainGlobal=typeof window.fixturePageOnly; document.querySelector('#relay').click(); 'clicked'" : redirect ? "fetch('/search', {method:'POST', body:'fixture'})" : "setTimeout(() => fetch('/send', {method:'POST', body:'fixture'}), 1500); 'scheduled'", purpose: "发送测试" } } }, { text: "操作结束。" }] },
]);
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  await until(() => rp!.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await until(() => rp!.evaluate(work, 'document.title === "Delayed send fixture"'), 10_000, "练习页就绪");
  await rp.click(panel, "#input"); await rp.typeText(panel, "延迟发送检查"); await rp.pressEnter(panel);
  await until(() => rp!.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].some(m=>m.textContent.includes("操作结束"))'), 30_000, "只读拒绝结束");
  await sleep(2000);
  const card = await rp.evaluate(panel, '!!document.querySelector(".send-confirm[data-state=open]")');
  const notice = await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText.includes("JS 只允许读取页面")');
  const dom = domBoundary ? await rp.evaluate(work, "({text:document.querySelector('#draft').textContent,pageGlobal:window.fixturePageOnly})") : undefined;
  await rp.screenshot(panel, join(out, "panel.png"));
  await rp.screenshot(work, join(out, "page.png"));
  result = { ...(dom ? { dom } : {}), scenario: domBoundary ? "dom-main-world-relay" : redirect ? "redirect-307" : "delayed", card, notice, writes, pass: !card && notice && writes === 0 && (!domBoundary || dom?.text === "Ready") };
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
} catch (error) { result = { error: String(error), pass: false }; console.error(error); process.exitCode = 1; }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close(); await new Promise<void>(resolve => site.close(() => resolve()));
  console.log(`证据：${out}`);
}
