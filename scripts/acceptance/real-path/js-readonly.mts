/** 真实隔离扩展：模型 JS 只读，返回值序列化也不得执行网页代码。 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, sleep, until, REPO } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
requireHeadless();
const expectUnsupported = process.argv.includes("--expect-unsupported");
const requested = process.argv.find(a => a.startsWith("--case="))?.slice(7);
const out = join(REPO, "out/acceptance/real-path", `js-readonly-${randomUUID()}`);
await mkdir(out, { recursive: true });
const requests: Array<{ method: string; url: string }> = [];
const site = createServer((req, res) => {
  if (req.url === "/send") requests.push({ method: req.method ?? "", url: req.url });
  req.resume();
  if (req.url === "/frame") { res.end("<title>Frame</title>"); return; }
  if (req.url === "/search") { res.writeHead(307, { location: "/send" }); res.end(); return; }
  if (req.url === "/send") { res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><title>只读练习页</title><p id="text">Read me</p><form><textarea id="draft">draft</textarea><button id="send">发送</button></form><button id="relay">继续</button><iframe src="/frame"></iframe><script>
window.effect=0;const send=()=>{window.effect++;return fetch('/send',{method:'POST'})};Error.prepareStackTrace=()=>{send();return 'poisoned-stack'};document.querySelector('form').onsubmit=e=>{e.preventDefault();send()};document.querySelector('#relay').onclick=send;window.addEventListener('relay-send',send);
window.returnGetter={get value(){send();return 7}};window.returnProxy=new Proxy({ok:1},{ownKeys(){send();return ['ok']},get(){send();return 2}});window.returnToJSON={ok:1,toJSON(){send();return 1}};
</script>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const cases = [
  ["dom", "document.querySelector('#text').textContent='changed'"],
  ["click", "document.querySelector('#relay').click()"],
  ["event", "window.dispatchEvent(new Event('relay-send'))"],
  ["timer", "setTimeout(()=>fetch('/send',{method:'POST'}),1500)"],
  ["microtask", "queueMicrotask(()=>fetch('/send',{method:'POST'}))"],
  ["promise", "Promise.resolve().then(()=>fetch('/send',{method:'POST'}))"],
  ["await", "(async()=>{await Promise.resolve();fetch('/send',{method:'POST'})})()"],
  ["fetch", "fetch('/send',{method:'POST'})"],
  ["redirect", "fetch('/search',{method:'POST'})"],
  ["xhr", "(()=>{const x=new XMLHttpRequest();x.open('POST','/send');x.send('fixture')})()"],
  ["beacon", "navigator.sendBeacon('/send','fixture')"],
  ["navigate", "location.href='/send'"],
  ["window", "window.effect=99"],
  ["iframe", "document.querySelector('iframe').contentWindow.fetch('/send',{method:'POST'})"],
  ["getter", "({get value(){fetch('/send',{method:'POST'});return 7}}).value"],
  ["return-getter", "({get value(){fetch('/send',{method:'POST'});return 7}})"],
  ["return-proxy", "new Proxy({ok:1},{get(){fetch('/send',{method:'POST'})}})"],
  ["return-toJSON", "({ok:1,toJSON(){fetch('/send',{method:'POST'});return 1}})"],
  ["error-formatter", "(()=>{throw new Error('fixture')})()"],
  ["syntax-formatter", "(() => {"],
  ["return-dom", "document.body"],
  ["return-window", "window"],
];
if (requested && !cases.some(([name]) => name === requested)) throw new Error(`未知场景 ${requested}`);
const chosen = requested ? cases.filter(([name]) => name === requested) : cases;
const readCode = "({title:document.title,text:document.querySelector('#text').textContent,rows:[...document.querySelectorAll('p')].map(p=>({text:p.textContent})),fresh:JSON.parse('{\"ok\":true}'),sum:[1,2].reduce((a,b)=>a+b,0)})";
const toolMessages: string[] = [];
const model = await startScriptedModel([
  { match: '\"goalPage\"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: "只读场景【read】", steps: [{ tool: { name: "browser_run", args: { code: `const read=await browser.js({code:${JSON.stringify(readCode)}}); return {read,rawCdp:typeof browser.cdp};` } } }, { text: "完成【read】" }] },
  ...chosen.map(([name, code]) => ({ match: `只读场景【${name}】`, steps: [{ tool: { name: "js", args: { code } } }, { text: `完成【${name}】` }] })),
  { match: "只读场景【program】", steps: [{ tool: { name: "browser_run", args: { code: "await browser.js({code:\"setTimeout(()=>fetch('/send',{method:'POST'}),1500)\"})" } } }, { text: "完成【program】" }] },
  { match: "专用发送检查", steps: [{ tool: { name: "fill", args: { target: "#draft", value: "dedicated-tool" } } }, { tool: { name: "click", args: { target: "#send", label: "发送" } } }, { text: "专用发送检查完成。" }] },
], undefined, payload => { for (const m of payload.messages ?? []) if (m.role === "tool") toolMessages.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content)); });
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(() => rp!.evaluate(panel, idle), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await until(() => rp!.evaluate(work, 'document.title==="只读练习页"'), 10_000, "练习页就绪");
  const rows: Array<{ name: string; pass: boolean; message?: string }> = [];
  for (const name of expectUnsupported ? ["read"] : ["read", ...chosen.map(([name]) => name), "program"]) {
    await rp.click(panel, "#conversation-new"); await until(() => rp!.evaluate(panel, idle), 10_000, "新对话就绪");
    const at = toolMessages.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, `只读场景【${name}】`); await rp.pressEnter(panel);
    await until(() => rp!.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(e=>e.textContent.includes(${JSON.stringify(`完成【${name}】`)}))`), 30_000, `${name} 任务结束`);
    const messages = toolMessages.slice(at);
    const message = messages.find(m => expectUnsupported ? m.includes("请升级 Chrome 155") : name === "read" ? m.includes('"rawCdp"') : m.includes("JS 只允许读取页面"));
    const pass = expectUnsupported ? !!message : name === "read" ? !!message && message.includes('"title":"只读练习页"') && message.includes('"text":"Read me"') && message.includes('"ok":true') && message.includes('"sum":3') && message.includes('"rawCdp":"undefined"') : !!message;
    rows.push({ name, pass, message: message ?? messages.join("\n") });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  }
  await sleep(2000);
  const state = await rp.evaluate(work, '({text:document.querySelector("#text")?.textContent,effect:window.effect,url:location.pathname})');
  const beforeApproval = requests.length;
  const readPass = rows.every(r => r.pass) && beforeApproval === 0 && state.text === "Read me" && state.effect === 0 && state.url === "/";
  await rp.screenshot(panel, join(out, "readonly.png"));
  let dedicatedPass = false;
  if (readPass && !requested) {
    await rp.click(panel, "#conversation-new"); await until(() => rp!.evaluate(panel, idle), 10_000, "新对话就绪");
    await rp.click(panel, "#input"); await rp.typeText(panel, "专用发送检查"); await rp.pressEnter(panel);
    await until(() => rp!.evaluate(panel, '!!document.querySelector(".send-confirm[data-state=open] .send-confirm-yes")'), 30_000, "专用发送确认卡");
    await sleep(1000);
    const held = requests.length === 0;
    const draft = await rp.evaluate(work, 'document.querySelector("#draft").value');
    await rp.screenshot(panel, join(out, "confirmation.png"));
    await rp.click(panel, ".send-confirm[data-state=open] .send-confirm-yes");
    await until(() => requests.length === 1, 10_000, "批准后收到专用点击发送");
    dedicatedPass = held && draft === "dedicated-tool" && requests.length === 1;
  }
  result = { case: expectUnsupported ? "unsupported-browser" : requested ?? "all", readPass, dedicatedPass, beforeApproval, afterApproval: requests.length, state, rows, pass: readPass && (requested ? true : dedicatedPass) };
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
} catch (error) { result = { pass: false, error: String(error), requests, toolMessages }; console.error(error); process.exitCode = 1; }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close(); await new Promise<void>(resolve => site.close(() => resolve()));
  console.log(`证据：${out}`);
}
