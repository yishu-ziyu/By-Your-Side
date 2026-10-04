// 前提：记忆里“我查资料常去维基百科和 X”（关于你、所有网站）在新任务开始时被带给模型。
// 预置用 memory-foundation.mts 已核对的库形状（格式 2，产品读后升级）；“说一句就记下”由记忆验收另行覆盖。判据：重启后新任务的带工具请求含这条原文；同时预置一条别站的网站范围条目，它不能出现（反例）。否则 exit 1。
import { createServer } from "node:http";
import { launchRealPath, requireHeadless, siteAddress, sleep, until } from "../acceptance/real-path/harness.mts";
import { configureViaSettings } from "../acceptance/real-path/inproc-config.mts";
import { startScriptedModel } from "../acceptance/real-path/scripted-model.mts";

requireHeadless();

type MemoryScope = { kind: "all" } | { kind: "site"; hostname: string };

const PREF = "我查资料常去维基百科和 X", OTHER = "在 shop.test 结账前先用优惠券";

const entry = (id: string, text: string, scope: MemoryScope) => ({ id, version: 1, text, scope, sourceConversationId: "seed", createdAt: Date.now(), updatedAt: Date.now(), kind: "profile", status: "active", sourceQuote: text, useCount: 0, formatVersion: 2 });

const doc = JSON.stringify({ format: 2, entries: [entry("pref-sources", PREF, { kind: "all" }), entry("other-site", OTHER, { kind: "site", hostname: "shop.test" })] }) + "\n";

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>Agents</title><p>MCP</p>`)).listen(0, "127.0.0.1");

await new Promise(r => site.once("listening", r));

const requests: Array<{ messages?: unknown[]; tools?: unknown[] }> = [];

const model = await startScriptedModel([{ match: "记忆前提", steps: [{ text: "收到记忆。" }] }], undefined, p => requests.push(p));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP blog.test 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });

const ready = async () => { const p = await rp.attach(await rp.openSidePanel()); await until(async () => (await rp.evaluate(p, `document.querySelector('#send-btn')?.disabled===false`)) || undefined, 20000, "侧栏就绪");

 return p; };

let ok = false;

try {
  let panel = await ready();
  await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "k" } }, { baseUrl: model.baseUrl });
  await rp.evaluate(panel, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(doc)}, "memories"); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); })`);
  await rp.restart();
  const blog = await rp.cdp.send("Target.createTarget", { url: "http://blog.test/post" }); await rp.cdp.send("Target.activateTarget", { targetId: blog.targetId }); await sleep(800);
  panel = await ready();
  await rp.click(panel, "#input"); await rp.typeText(panel, "记忆前提：查一下 MCP"); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes('收到记忆')`)) || undefined, 60000, "回答");
  const main = requests.flatMap(r => r.tools?.length ? [JSON.stringify(r.messages)] : []);
  const recalled = main.some(m => m.includes(PREF)), leaked = main.some(m => m.includes(OTHER));
  ok = recalled && !leaked;
  console.log(JSON.stringify({ ok, recalled, leaked, mainRequests: main.length }));
} catch (e) { console.error(e); } finally { await rp.close(); await rp.remove(); await model.close(); site.close(); }

process.exitCode = ok ? 0 : 1;
