/** 隔离扩展：确认后只允许发送仍与确认时一致的内容、收件人和目标。 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, sleep, until, REPO } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const requested = process.argv.find(a => a.startsWith("--case="))?.slice(7);
const all = ["click-same", "click-changed", "click-tail", "click-recipient", "click-target", "click-ambiguous-same", "click-ambiguous-changed", "enter-same", "enter-changed", "enter-tail", "enter-recipient", "enter-target", "enter-ambiguous-same", "enter-ambiguous-changed", "script-same", "script-changed", "script-tail", "script-recipient", "script-target", "script-ambiguous-same", "script-ambiguous-changed", "decline"] as const;
if (requested && !all.some(c => c === requested)) throw new Error(`未知场景 ${requested}`);
const cases = requested ? all.filter(c => c === requested) : all;
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-send-confirm-binding-${randomUUID().slice(0, 8)}`);
await mkdir(out, { recursive: true });
const posts: Array<{ body: string; recipient: string; note?: string; at: number }> = [];
const initial = "甲".repeat(140);
const site = createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    posts.push({ ...JSON.parse(body), at: Date.now() }); res.end("ok"); return;
  }
  const extra = req.url?.includes("multi=1") ? '<textarea aria-label="附注">附注原文</textarea>' : "";
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><title>确认练习页</title><form><input name="recipient" aria-label="收件人" value="小王"><textarea id="draft" aria-label="留言">${initial}</textarea>${extra}<button id="send">发送</button></form><script>const f=document.querySelector('form'), d=document.querySelector('#draft'); f.onsubmit=async e=>{e.preventDefault();await fetch('/send',{method:'POST',body:JSON.stringify({body:d.value,recipient:document.querySelector('[name=recipient]').value,note:document.querySelector('[aria-label=附注]')?.value})})};d.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit(document.querySelector('#send'))}})</script>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const click = { tool: { name: "click", args: { target: "#send", label: "发送" } } };
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...all.map(name => ({ match: `确认场景 ${name}`, steps: name.startsWith("enter-")
    ? [{ tool: { name: "click", args: { target: "#draft", label: "留言" } } }, { tool: { name: "press_key", args: { key: "Enter" } } }, { text: "操作结束。" }]
    : name.startsWith("script-")
      ? [{ tool: { name: "js", args: { code: "document.querySelector('#send').click()", purpose: "发送留言" } } }, { text: "操作结束。" }]
      : [click, { text: "操作结束。" }] })),
]);
const rp = await launchRealPath();
const results: Array<{ name: string; pass: boolean; actual: unknown }> = [];
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
  for (const name of cases) {
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/${name.includes("ambiguous") ? "?multi=1" : ""}` }, work);
    await until(() => rp.evaluate(work, '!!document.querySelector("#draft")'), 10_000, "练习页就绪");
    await rp.click(panel, "#conversation-new"); await until(() => rp.evaluate(panel, idle), 10_000, "新对话就绪");
    const before = posts.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, `确认场景 ${name}`); await rp.pressEnter(panel);
    await until(() => rp.evaluate(panel, '!!document.querySelector(".send-confirm[data-state=open] .send-confirm-yes")'), 30_000, `${name} 确认卡`);
    if (name.endsWith("-changed")) await rp.evaluate(work, name.includes("ambiguous") ? 'document.querySelector("[aria-label=附注]").value="附注已变化", true' : 'document.querySelector("#draft").value="内容已变化", true');
    if (name.endsWith("-tail")) await rp.evaluate(work, `document.querySelector("#draft").value=${JSON.stringify(initial.slice(0, 120) + "尾部变化")}, true`);
    if (name.endsWith("-recipient")) await rp.evaluate(work, 'document.querySelector("[name=recipient]").value="小李", true');
    if (name.endsWith("-target")) await rp.evaluate(work, `(()=>{const e=document.querySelector(${JSON.stringify(name.startsWith("enter-") ? "#draft" : "#send")});e.replaceWith(e.cloneNode(true));return true})()`);
    await sleep(1000);
    const approvedAt = Date.now();
    await rp.click(panel, `.send-confirm[data-state=open] .send-confirm-${name === "decline" ? "no" : "yes"}`);
    await until(() => rp.evaluate(panel, '!document.querySelector(".send-confirm[data-state=open]")'), 10_000, `${name} 确认结束`);
    await until(() => rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].some(m=>m.textContent.includes("操作结束"))'), 30_000, `${name} 任务结束`);
    if (name.endsWith("-same")) await until(() => posts.length > before, 10_000, `${name} 服务器收到`).catch(() => undefined);
    await sleep(1500);
    const received = posts.slice(before);
    const expectedSend = name.endsWith("-same");
    if (name === "script-changed") {
      await rp.evaluate(panel, 'setTimeout(()=>location.reload(),0), true');
      await until(() => rp.evaluate(panel, 'document.querySelector("#messages")?.innerText.includes("确认后内容、收件人或目标发生变化，未发送")'), 30_000, "重开侧栏后恢复未发送提示");
      await sleep(1500);
    }
    const panelText = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText.slice(-1200)'));
    const correctPost = expectedSend ? received.length === 1 && received[0]?.body === initial && received[0]?.recipient === "小王" && (!name.includes("ambiguous") || received[0]?.note === "附注原文") : received.length === 0;
    const correctNotice = expectedSend || name === "decline" || (panelText.includes("确认后内容、收件人或目标发生变化，未发送") && !panelText.includes("已核对页面"));
    const pass = correctPost && correctNotice;
    results.push({ name, pass, actual: { sent: received.length, matched: received[0]?.body === initial && received[0]?.recipient === "小王", notice: correctNotice, ...(received[0] ? { confirmToPostMs: received[0].at - approvedAt } : {}), ...(!pass ? { panelText } : {}) } });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(results.at(-1)?.actual));
    if (name === "click-changed") await rp.screenshot(panel, join(out, "changed.png"));
    if (name === "click-ambiguous-changed") await rp.screenshot(panel, join(out, "ambiguous.png"));
  }
} catch (error) { results.push({ name: "流程", pass: false, actual: String(error) }); console.error(String(error)); }
finally { await writeFile(join(out, "result.json"), JSON.stringify(results, null, 2)); await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => site.close(() => resolve())); }
console.log(`证据：${out}`);
if (results.length !== cases.length || results.some(result => !result.pass)) process.exitCode = 1;
