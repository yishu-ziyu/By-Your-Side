import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-program-send-timeout`);
await mkdir(out, { recursive: true });
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>团队聊天</title><body>
<h2>和 @小王 的对话</h2><form id="f"><textarea id="draft" aria-label="消息">周五下午三点开会。</textarea><button id="send">发送</button></form>
<script>document.querySelector('#f').addEventListener('submit', e => { e.preventDefault(); fetch('/send', {method:'POST',body:document.querySelector('#draft').value}); });</script></body></html>`;
const posts: number[] = [];
const site = createServer(async (req, res) => {
  if (req.method === "POST") { for await (const _ of req) {} posts.push(Date.now()); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const ask = "用例：用网页程序发送这条消息。";
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ask, steps: [{ tool: { name: "browser_run", args: { label: "发送消息", code: 'return await browser.click({ target: "#send", label: "发送" });' } } }, { text: "程序结束。" }] },
]);
const rp = await launchRealPath();
const result: Record<string, unknown> = {};
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, ask); await rp.pressEnter(panel);
  const yes = () => rp.evaluate(panel, `!![...document.querySelectorAll(".send-confirm .send-confirm-yes")].find(b => !b.disabled && b.offsetParent)`);
  result.confirmShown = await until(async () => await yes() || null, 20_000, "发送确认出现", 100).then(() => true, () => false);
  result.before = posts.length;
  if (!result.confirmShown) throw new Error("没有进入发送确认路径");
  await rp.screenshot(panel, join(out, "confirmation.png"));
  const started = Date.now();
  await sleep(62_000);
  result.waitedMs = Date.now() - started;
  result.confirmAfterDeadline = await yes();
  if (result.confirmAfterDeadline) {
    await rp.click(panel, ".send-confirm .send-confirm-yes");
    await sleep(3000);
  }
  result.postsAfterDeadline = posts.length;
  await rp.screenshot(panel, join(out, "after-deadline.png"));
} catch (error) { result.error = String(error); }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ result, posts }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}
const pass = result.confirmShown === true && result.before === 0 && result.postsAfterDeadline === 0 && !result.error;
console.log(pass ? "PASS" : "FAIL", JSON.stringify(result), out);
if (!pass) process.exitCode = 1;
