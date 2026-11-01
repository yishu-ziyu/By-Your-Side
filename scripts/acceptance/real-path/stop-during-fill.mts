import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-stop-during-fill`);
await mkdir(out, { recursive: true });
const calls: Array<{ path: string; at: number; body?: string }> = [];
const site = createServer(async (req, res) => {
  if (req.url === "/started" || req.url === "/resumed" || req.url === "/submit") {
    const at = Date.now();
    const body = await new Promise<string>(resolve => { const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(Buffer.from(chunk))); req.on("end", () => resolve(Buffer.concat(chunks).toString())); });
    calls.push({ path: req.url, at, ...(req.url === "/submit" ? { body } : {}) }); res.end("ok"); return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>搜索练习</title><label>搜索 <input type="search" id="q"></label><script>
    window.slow = true;
    document.querySelector('#q').addEventListener('input', e => { if (e.isTrusted && window.slow) { window.slow = false; navigator.sendBeacon('/started'); const end = Date.now() + 5000; while (Date.now() < end) {} navigator.sendBeacon('/resumed'); } });
    document.querySelector('#q').addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Enter') fetch('/submit', {method:'POST',body:document.querySelector('#q').value}); });
  </script>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const first = "练习一：在搜索框中填写文字并回车。";
const second = "练习二：在搜索框中填写另一句话并回车。";
const model = await startScriptedModel([
  { match: first, steps: [{ tool: { name: "fill", args: { target: "#q", value: "第一条", submit: true } } }, { text: "第一轮结束。" }] },
  { match: second, steps: [{ tool: { name: "fill", args: { target: "#q", value: "第二条", submit: true } } }, { text: "第二轮结束。" }] },
]);
const rp = await launchRealPath();
const result: Record<string, unknown> = {};
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#send-btn")?.classList.contains("stopping")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.evaluate(panel, `(() => { window.testStopClickedAt = null; document.querySelector("#send-btn").addEventListener("click", () => { window.testStopClickedAt = Date.now(); }, {capture:true}); return true; })()`);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, first); await rp.pressEnter(panel);
  await until(async () => calls.some(c => c.path === "/started"), 20_000, "填写已到达练习页");
  result.buttonBeforeStop = await rp.evaluate(panel, '({stopping:document.querySelector("#send-btn")?.classList.contains("stopping"),disabled:document.querySelector("#send-btn")?.disabled})');
  await rp.click(panel, "#send-btn");
  result.stopClickedAt = await rp.evaluate(panel, "window.testStopClickedAt");
  await until(async () => calls.some(c => c.path === "/resumed"), 10_000, "练习页恢复");
  await sleep(1500);
  result.submitsAfterStop = calls.filter(c => c.path === "/submit").length;
  result.firstValue = await rp.evaluate(work, 'document.querySelector("#q").value');
  await until(async () => await rp.evaluate(panel, ready), 30_000, "停止后就绪");
  const beforeControl = calls.filter(c => c.path === "/submit").length;
  await rp.click(panel, "#input"); await rp.typeText(panel, second); await rp.pressEnter(panel);
  await until(async () => calls.filter(c => c.path === "/submit").length > beforeControl, 20_000, "正常对照收到提交");
  result.submitsAfterControl = calls.filter(c => c.path === "/submit").length;
  result.controlValue = await rp.evaluate(work, 'document.querySelector("#q").value');
} catch (error) { result.error = String(error); }
finally {
  result.calls = calls;
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => site.close(() => resolve()));
}
const button = result.buttonBeforeStop as { stopping?: boolean; disabled?: boolean } | undefined;
const startedAt = calls.find(c => c.path === "/started")?.at;
const resumedAt = calls.find(c => c.path === "/resumed")?.at;
const pass = button?.stopping === true && button.disabled === false && typeof result.stopClickedAt === "number" && startedAt !== undefined && resumedAt !== undefined && result.stopClickedAt >= startedAt && result.stopClickedAt < resumedAt && result.submitsAfterStop === 0 && result.submitsAfterControl === 1 && calls.find(c => c.path === "/submit")?.body === "第二条" && result.firstValue === "第一条" && result.controlValue === "第二条" && !result.error;
console.log(pass ? "PASS" : "FAIL", JSON.stringify(result), out);
if (!pass) process.exitCode = 1;
