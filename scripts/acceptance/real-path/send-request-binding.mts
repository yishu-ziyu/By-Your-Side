/** 隔离扩展：用户确认后重放的网络请求必须保留已确认的地址、头和内容。 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, sleep, until, REPO } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const all = ["fetch-same", "fetch-body", "fetch-header", "fetch-url", "form-same", "form-body", "request-same", "request-header", "xhr-same", "xhr-url", "xhr-header"] as const;
const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
if (selected && !all.some(name => name === selected)) throw new Error(`未知场景 ${selected}`);
const cases = selected ? all.filter(name => name === selected) : all;
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-send-request-binding-${randomUUID().slice(0, 8)}`);
await mkdir(out, { recursive: true });
const posts: Array<{ body: string; recipient: string; path: string }> = [];
const initial = "原来的消息";
const site = createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    if (String(req.headers["content-type"]).startsWith("multipart/form-data")) {
      const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`).exec(body)?.[1] ?? "";
      posts.push({ body: field("body"), recipient: field("recipient"), path: req.url ?? "" });
    } else posts.push({ ...JSON.parse(body), path: req.url ?? "" });
    res.end("ok"); return;
  }
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><title>网络发送练习页</title><textarea id="draft">${initial}</textarea>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const payload = "JSON.stringify({body:document.querySelector('#draft').value,recipient:'小王'})";
const codes: Record<string, string> = {
  fetch: `window.__url=new URL('/send',location.href);window.__request={method:'POST',body:${payload}};fetch(window.__url,window.__request).catch(()=>{});true`,
  form: "window.__form=new FormData();window.__form.append('body',document.querySelector('#draft').value);window.__form.append('recipient','小王');fetch('/send',{method:'POST',body:window.__form}).catch(()=>{});true",
  request: `window.__request=new Request('/send',{method:'POST',body:${payload}});fetch(window.__request).catch(()=>{});true`,
  xhr: `window.__xhr=new XMLHttpRequest();window.__xhr.open('POST','/send');window.__xhr.send(${payload});true`,
};
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...all.map(name => ({ match: `网络场景 ${name}`, steps: [{ tool: { name: "js", args: { code: codes[name.split("-")[0]!]!, purpose: "发送留言" } } }, { text: "操作结束。" }] })),
]);
const rp = await launchRealPath();
const results: Array<{ name: string; pass: boolean; actual: unknown }> = [];
try {
  const work = await rp.attach((await rp.targets()).find(target => target.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
  for (const name of cases) {
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
    await until(() => rp.evaluate(work, '!!document.querySelector("#draft")'), 10_000, "练习页就绪");
    await rp.click(panel, "#conversation-new"); await until(() => rp.evaluate(panel, idle), 10_000, "新对话就绪");
    const before = posts.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, `网络场景 ${name}`); await rp.pressEnter(panel);
    await until(() => rp.evaluate(panel, '!!document.querySelector(".send-confirm[data-state=open] .send-confirm-yes")'), 30_000, `${name} 确认卡`);
    const mutations: Record<string, string> = {
      "fetch-body": `window.__request.body=JSON.stringify({body:'变更后的消息',recipient:'小王'})`,
      "fetch-header": `window.__request.headers={'x-recipient':'changed'}`,
      "fetch-url": `window.__url.pathname='/different-send'`,
      "form-body": `window.__form.set('body','变更后的消息')`,
      "request-header": `window.__request.headers.set('x-recipient','changed')`,
      "xhr-url": `window.__xhr.open('POST','/different-send')`,
      "xhr-header": `window.__xhr.setRequestHeader('x-recipient','changed')`,
    };
    if (mutations[name]) await rp.evaluate(work, `${mutations[name]}, true`);
    await sleep(1000); await rp.click(panel, '.send-confirm[data-state=open] .send-confirm-yes');
    await until(() => rp.evaluate(panel, '!document.querySelector(".send-confirm[data-state=open]")'), 10_000, `${name} 确认结束`);
    await until(() => rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].some(m=>m.textContent.includes("操作结束"))'), 30_000, `${name} 任务结束`);
    if (name.endsWith("-same")) await until(() => posts.length > before, 10_000, `${name} 服务器收到`).catch(() => undefined);
    await sleep(1500);
    const received = posts.slice(before);
    const panelText = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText.slice(-1200)'));
    const expectedSend = name.endsWith("-same");
    const correctPost = expectedSend ? received.length === 1 && received[0]?.body === initial && received[0]?.recipient === "小王" && received[0]?.path === "/send" : received.length === 0;
    const correctNotice = expectedSend || (panelText.includes("确认后内容、收件人或目标发生变化，未发送") && !panelText.includes("已核对页面"));
    const cleanup = name.startsWith("xhr-") ? await rp.evaluate(work, '!Object.hasOwn(window.__xhr,"open") && !Object.hasOwn(window.__xhr,"setRequestHeader")') : true;
    const pass = correctPost && correctNotice && cleanup === true;
    results.push({ name, pass, actual: { sent: received.length, correctPost, correctNotice, cleanup, ...(!pass ? { panelText } : {}) } });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(results.at(-1)?.actual));
  }
} catch (error) { results.push({ name: "流程", pass: false, actual: String(error) }); console.error(String(error)); }
finally { await writeFile(join(out, "result.json"), JSON.stringify(results, null, 2)); await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => site.close(() => resolve())); }
console.log(`证据：${out}`);
if (results.length !== cases.length || results.some(result => !result.pass)) process.exitCode = 1;
