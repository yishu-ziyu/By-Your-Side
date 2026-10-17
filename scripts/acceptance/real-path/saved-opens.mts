/**
 * 用户教过「以后我说 X，就打开这几个网址」：再说 X 时，宿主开工就并行打开它们，不等模型；模型只回一句。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页。记忆按真实格式写进扩展的记忆库（教的那一步由真实模型另测）。
 *   npx tsx scripts/acceptance/real-path/saved-opens.mts --headless
 * 判据：
 *   a) 说「听说新模型发布了」：3 个渠道在 3 秒内全部出现在后台（其中一个要 8 秒才加载完），用户原来的页面仍在前面；
 *      3 秒内就问模型，消息里带宿主已打开的事实；模型想再读网页被拦下；这一轮不做目标核对。
 *   b) 重开侧栏后重放：回答还在，不再多开标签页。
 *   c) 「新模型发布了，帮我总结一下这次各家的变化和区别」多了一件事：不由宿主打开。
 *   d) 删掉这条记忆后再说同一句：不打开。
 * 失败方式：去掉宿主打开，a 里 3 秒内一个渠道也不出现；改成等页面加载完，模型要 8 秒后才被问到。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { MEMORY_FORMAT_VERSION } from "../../../shared/memory.js";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-saved-opens`);

await mkdir(artifacts, { recursive: true });

const ASK = "听说新模型发布了";

const MORE = "新模型发布了，帮我总结一下这次各家的变化和区别";

const site = createServer(async (req, res) => {
  const name = (req.url ?? "/").slice(1) || "home";
  // 慢网站：开标签页的调用要等页面能用才返回，宿主不能等它。
  if (name === "channel-c") await sleep(8_000);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const CHANNELS = ["channel-a", "channel-b", "channel-c"].map(name => `${origin}/${name}`);

/** 提到这几句话的每次主模型请求（整份消息和发出时间），看这一轮问了几次、何时问、带没带宿主事实。 */
const asked: Array<{ text: string; at: number }> = [];

let goalChecks = 0;

const model = await startScriptedModel([
  { match: MORE, steps: [{ text: "这句要总结，交给模型。" }] },
  // 模型想再去读页面：这一轮的网页工具应被拦下，拦下后照常回一句。
  { match: ASK, steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: "已在后台打开三个渠道。" }] },
], undefined, payload => {
  const text = JSON.stringify(payload.messages ?? []);
  if (text.includes("You check whether a browser assistant has finished")) { goalChecks += 1; return; }
  if (text.includes(ASK) || text.includes(MORE)) asked.push({ text, at: Date.now() });
});

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

const SAMPLE = `(() => ({ answers: [...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].map(e => e.innerText.trim()), idle: document.querySelector("#send-btn")?.disabled === false }))()`;

type Sample = { answers: string[]; idle: boolean };

const channelTabs = async () => (await rp.targets()).filter(t => t.type === "page" && CHANNELS.some(url => t.url.startsWith(url)));

const memoryJs = (body: string) => `new Promise((ok,no)=>{const r=indexedDB.open('sideagent-memory');r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('kv','readwrite');const store=tx.objectStore('kv');const q=store.get('memories');q.onsuccess=()=>{const doc=JSON.parse(q.result??'null')??{format:${MEMORY_FORMAT_VERSION},rev:0,methodRev:0,entries:[],forgottenExperiences:[]};${body};doc.rev++;store.put(JSON.stringify(doc)+'\\n','memories')};tx.oncomplete=()=>{db.close();ok(true)};tx.onerror=()=>no(tx.error)}})`;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/home` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const now = Date.now();
  const quote = `记住：以后我说“新模型发布了”，你就把我常去的这几个渠道都打开：${CHANNELS.join("、")}。`;
  const entry = { id: "saved-open-test", factId: "saved-open-test", version: 1, text: `听到“新模型发布了”时，打开这些渠道：${CHANNELS.join("、")}`, scope: { kind: "all" }, sourceConversationId: "seed",
    createdAt: now, updatedAt: now, kind: "profile", sourceQuote: quote, useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION };
  await rp.evaluate(panel, memoryJs(`doc.entries.push(${JSON.stringify(entry)})`));

  const send = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const answered = async (count: number, label: string) => until(async () => {
    const sample = await rp.evaluate(panel, SAMPLE) as Sample;
    return sample.answers.length >= count && sample.idle ? sample : undefined;
  }, 60_000, label);

  // a
  const started = Date.now();
  await send(ASK);
  const allOpen = await until(async () => (await channelTabs()).length === CHANNELS.length ? Date.now() - started : undefined, 3_000, "3 秒内打开全部渠道").catch(() => null);
  const a = await answered(1, "a 交付");
  await rp.screenshot(panel, join(artifacts, "a.png"));
  const front = await rp.evaluate(work, "document.visibilityState");
  await sleep(3_000);
  const tools = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .tool-row, #messages [data-tool]")].map(e => e.innerText.trim()).slice(-5)`);
  Object.assign(evidence, { allOpenMs: allOpen, firstAskMs: asked[0] ? asked[0].at - started : null, answer: a.answers.at(-1), askedA: asked.length, goalChecks, front, tools });
  assert.ok(allOpen !== null, `all ${CHANNELS.length} channels open within 3 s (open now: ${(await channelTabs()).length})`);
  assert.equal(front, "visible", "the user's own page stays in front");
  assert.ok(asked[0] && asked[0].at - started < 3_000, `the model is asked without waiting for the slow page (${asked[0] ? asked[0].at - started : "never"} ms)`);
  assert.ok(asked[0]!.text.includes("[SAVED OPEN"), "the request carries the host fact that the pages are open");
  assert.ok(asked[1]?.text.includes("宿主已按用户记下的做法打开了这些页面"), "the model's page tool is blocked this turn");
  assert.equal(goalChecks, 0, "no goal check for a turn that only opened the saved pages");

  // b
  await rp.evaluate(panel, "location.reload()").catch(() => undefined);
  const replay = await until(async () => {
    const sample = await rp.evaluate(panel, SAMPLE).catch(() => null) as Sample | null;
    return sample?.answers.some(text => text.includes("三个渠道")) ? sample : undefined;
  }, 30_000, "重开侧栏后重放");
  await sleep(2_000);
  evidence.replay = { answers: replay.answers.length, tabs: (await channelTabs()).length };
  assert.equal((await channelTabs()).length, CHANNELS.length, "reopening the sidebar opens no extra tabs");

  // c
  for (const tab of await channelTabs()) await rp.cdp.send("Target.closeTarget", { targetId: tab.targetId });
  await send(MORE);
  await answered(2, "c 交付");
  await sleep(1_000);
  evidence.more = { tabs: (await channelTabs()).length };
  assert.equal((await channelTabs()).length, 0, "a message with another request is left to the model");

  // d
  await rp.evaluate(panel, memoryJs(`doc.entries=doc.entries.filter(e=>e.id!=='saved-open-test')`));
  await send(ASK);
  await answered(3, "d 交付");
  await sleep(1_000);
  evidence.deleted = { tabs: (await channelTabs()).length };
  assert.equal((await channelTabs()).length, 0, "after the memory is deleted, the phrase opens nothing");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
