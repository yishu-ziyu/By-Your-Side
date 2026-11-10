import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-send-confirm-panel-close`);
await mkdir(out, { recursive: true });

const DRAFT = "周五下午三点开会。";
const TASK = "把草稿发出去。";
const DONE = "收尾了。";
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>留言练习页</title><body style="font:16px sans-serif;margin:40px">
<form id="f"><textarea id="draft" rows="3" cols="40" aria-label="留言">${DRAFT}</textarea><p><button id="send">发送</button></p></form>
<script>document.querySelector('#f').addEventListener('submit', async e => { e.preventDefault(); await fetch('/send', { method: 'POST', body: document.querySelector('#draft').value }); });</script></body></html>`;

let sent = 0;
const site = createServer(async (req, res) => {
  if (req.method === "POST") { req.setEncoding("utf8"); for await (const _ of req) {  } sent += 1; res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const clickSend = { tool: { name: "click", args: { target: "#send", label: "发送" } } };
const model = await startScriptedModel([
  { match: JSON.stringify({ message: TASK }).slice(0, -1) + ',"clauses":', steps: [{ text: JSON.stringify({ steps: [{ action: "start", taskId: null }] }) }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: '"lastReply"', steps: [{ text: JSON.stringify({ status: "done", remaining: null }) }] },
  { match: TASK, steps: [clickSend, { text: DONE }] },
]);

const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let failure = "";

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panelTargets = async () => (await rp.targets()).filter(t => t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`));
  let panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = (session: string) => until(async () => await rp.evaluate(session, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await ready(panel);
  const cards = (session: string) => rp.evaluate(session, `[...document.querySelectorAll(".send-confirm")].map(c => ({ text: c.innerText.replace(/\\s+/g, " ").trim(), state: c.dataset.state ?? "", buttons: [...c.querySelectorAll("button")].map(b => b.textContent) }))`) as Promise<Array<{ text: string; state: string; buttons: string[] }>>;
  const pageHint = () => rp.evaluate(work, `[...document.querySelectorAll("[data-sideagent-overlay='send-confirm']")].map(n => n.textContent).join("")`) as Promise<string>;

  await rp.click(panel, "#input"); await rp.typeText(panel, TASK); await rp.pressEnter(panel);
  await until(async () => (await cards(panel)).some(c => c.buttons.includes("发送") && c.buttons.includes("先不发")) || undefined, 30_000, "侧栏出现能点的确认卡", 100);
  await sleep(800);
  await rp.screenshot(panel, join(out, "1-waiting.png"));
  evidence.before = { cards: await cards(panel), pageHint: await pageHint() };

  for (const target of await panelTargets()) await rp.cdp.send("Target.closeTarget", { targetId: target.targetId });
  await until(async () => (await panelTargets()).length === 0 || undefined, 10_000, "侧栏关掉");
  await sleep(4000);
  evidence.whileClosed = { pageHint: await pageHint(), sent, modelCalls: model.requests.length };

  assert.equal(String((evidence.whileClosed as { pageHint: string }).pageHint), "等你在侧栏确认", "侧栏关着时网页上还提示等你确认");
  panel = await rp.attach(await rp.openSidePanel());
  await ready(panel);
  await sleep(1500);
  await rp.screenshot(panel, join(out, "2-reopened.png"));
  const reopened = await cards(panel);
  evidence.reopened = { cards: reopened, sent };
  assert.equal(sent, 0, "关掉侧栏不能把内容发出去");
  assert.ok(reopened.length === 1 && reopened[0].buttons.includes("发送") && reopened[0].buttons.includes("先不发"), `重开侧栏后确认卡还能点：${JSON.stringify(reopened)}`);
  await rp.click(panel, ".send-confirm .send-confirm-yes");
  await until(async () => sent === 1 || undefined, 10_000, "重开后点发送，服务器收到");
  await until(async () => String(await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].map(m => m.textContent).join(" ")`)).includes(DONE) || undefined, 60_000, "任务做完");
  await rp.screenshot(panel, join(out, "3-sent.png"));
  const after = await cards(panel);
  evidence.after = { cards: after, sent };
  assert.equal(sent, 1, "恰好发出 1 条");
  assert.ok(after.length === 1 && after[0].text === "你确认过，已发送" && after[0].buttons.length === 0, `卡收成已发送：${JSON.stringify(after)}`);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ failure, evidence, requests: model.requests, notCovered: ["真实网站、真模型", "日常 Chrome 里真的点侧栏关闭按钮"] }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(JSON.stringify(evidence, null, 2));
console.log(`证据：${out}`);
if (failure) { console.log(`FAIL ${failure}`); process.exitCode = 1; } else console.log("PASS");
