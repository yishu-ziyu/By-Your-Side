// 前提：划选经侧栏交接（右键“问 By Your Side”写入的 pendingAsk）后，带工具的主任务请求里含划选原文。
// 右键菜单是 Chrome 自身界面，无头无法点；这里直接写入同一个交接存储，只证明交接之后的通路。
// 判据：脚本模型收到的带工具请求含 “[User's selected text]” 与划选原文；否则 exit 1。
import { createServer } from "node:http";
import { launchRealPath, requireHeadless, siteAddress, sleep, until } from "../acceptance/real-path/harness.mts";
import { configureViaSettings } from "../acceptance/real-path/inproc-config.mts";
import { startScriptedModel } from "../acceptance/real-path/scripted-model.mts";

requireHeadless();

const SELECTED = "Model Context Protocol";

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  .end(`<!doctype html><meta charset="utf-8"><title>Agents</title><p>We introduce <b>${SELECTED}</b>.</p>`)).listen(0, "127.0.0.1");

await new Promise(r => site.once("listening", r));

const requests: Array<{ messages?: unknown[]; tools?: unknown[] }> = [];

const model = await startScriptedModel([{ match: "划选前提", steps: [{ text: "收到划选。" }] }], undefined, p => requests.push(p));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP blog.test 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });

let ok = false;

try {
  const blog = await rp.cdp.send("Target.createTarget", { url: "http://blog.test/post" }); await rp.cdp.send("Target.activateTarget", { targetId: blog.targetId }); await sleep(800);
  let panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false`)) || undefined, 20000, "侧栏就绪");
  await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "k" } }, { baseUrl: model.baseUrl });
  await rp.evaluate(panel, `chrome.tabs.query({url:"http://blog.test/*"}).then(([t])=>chrome.storage.session.set({pendingAsk:{text:${JSON.stringify(SELECTED)},tabId:t.id,title:t.title,url:t.url}}))`);
  await rp.evaluate(panel, `location.reload()`).catch(() => {}); await sleep(1500);
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false`)) || undefined, 20000, "侧栏重开");
  const draft = await rp.evaluate(panel, `document.body.innerText.includes(${JSON.stringify(SELECTED)})`);
  await rp.click(panel, "#input"); await rp.typeText(panel, "划选前提：查一下这个词"); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes('收到划选')`)) || undefined, 60000, "回答");
  const main = requests.flatMap(r => r.tools?.length ? [JSON.stringify(r.messages)] : []);
  ok = main.some(m => m.includes("[User's selected text]") && m.includes(SELECTED));
  console.log(JSON.stringify({ ok, draftShowsSelection: draft, mainRequests: main.length }));
} catch (e) { console.error(e); } finally { await rp.close(); await rp.remove(); await model.close(); site.close(); }

process.exitCode = ok ? 0 : 1;
