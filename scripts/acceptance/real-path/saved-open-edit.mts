/**
 * 「以后我说 X，就打开这几个网址」改过之后：在记忆面板改了网址，再说 X 打开的是新网址；改成不要自动打开，再说 X 就不由宿主打开。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页。记忆按真实格式写进扩展的记忆库，修改走侧栏记忆面板的「修改」「保存修改」。
 *   npx tsx scripts/acceptance/real-path/saved-open-edit.mts --headless
 * 判据：
 *   a) 说「新模型发布了」：记下的两个旧渠道打开（起点）。
 *   b) 面板里把网址改成两个新渠道后再说：新渠道打开，旧渠道一个也不开。
 *   c) 面板里改成「听到“新模型发布了”时不要自动打开」后再说：宿主一个渠道也不开。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { MEMORY_FORMAT_VERSION } from "../../../shared/memory.js";

requireHeadless();
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-saved-open-edit`);
await mkdir(artifacts, { recursive: true });
const ASK = "新模型发布了";
const site = createServer((req, res) => {
  const name = (req.url ?? "/").slice(1) || "home";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>${name}</title><h1>${name}</h1>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const OLD = ["old-a", "old-b"].map(name => `${origin}/${name}`);
const NEW = ["new-x", "new-y"].map(name => `${origin}/${name}`);
const model = await startScriptedModel([{ match: ASK, steps: [{ text: "好的。" }] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: unknown }> = [];
const check = (name: string, pass: boolean, actual: unknown) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const memoryJs = (body: string) => `new Promise((ok,no)=>{const r=indexedDB.open('sideagent-memory');r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('kv','readwrite');const store=tx.objectStore('kv');const q=store.get('memories');q.onsuccess=()=>{const doc=JSON.parse(q.result??'null')??{format:${MEMORY_FORMAT_VERSION},rev:0,methodRev:0,entries:[],forgottenExperiences:[]};${body};doc.rev++;store.put(JSON.stringify(doc)+'\\n','memories')};tx.oncomplete=()=>{db.close();ok(true)};tx.onerror=()=>no(tx.error)}})`;
const opened = async (urls: string[]) => (await rp.targets()).filter(t => t.type === "page" && urls.some(url => t.url.startsWith(url))).map(t => t.url.slice(origin.length));

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/home` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏就绪");
  const now = Date.now();
  const quote = `记住：以后我说“${ASK}”，你就把这两个渠道都打开：${OLD.join("、")}。`;
  const entry = { id: "saved-open-edit", factId: "saved-open-edit", version: 1, text: `听到“${ASK}”时，打开这些渠道：${OLD.join("、")}`, scope: { kind: "all" }, sourceConversationId: "seed",
    createdAt: now, updatedAt: now, kind: "profile", sourceQuote: quote, useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION };
  await rp.evaluate(panel, memoryJs(`doc.entries.push(${JSON.stringify(entry)})`));

  let answers = 0;
  const say = async () => {
    answers += 1;
    await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.assistant[data-delivery-id]").length>=${answers} && document.querySelector("#send-btn")?.disabled===false`) || undefined, 60_000, `第 ${answers} 句回答`);
    await sleep(2_000);
  };
  const closeAll = async () => { for (const tab of (await rp.targets()).filter(t => t.type === "page" && [...OLD, ...NEW].some(url => t.url.startsWith(url)))) await rp.cdp.send("Target.closeTarget", { targetId: tab.targetId }); };
  const edit = async (text: string, shot: string) => {
    await rp.click(panel, "#memory-open");
    await until(async () => await rp.evaluate(panel, `!!document.querySelector('button[data-memory-action="edit"][data-memory-id="${entry.id}"]')`) || undefined, 10_000, "记忆面板里出现这条");
    await rp.evaluate(panel, `document.querySelector('button[data-memory-action="edit"][data-memory-id="${entry.id}"]').click()`);
    await until(async () => await rp.evaluate(panel, `!!document.querySelector('textarea[data-memory-field="text"][data-memory-id="${entry.id}"]')`) || undefined, 5_000, "修改框");
    await rp.evaluate(panel, `(()=>{const t=document.querySelector('textarea[data-memory-field="text"][data-memory-id="${entry.id}"]');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await rp.screenshot(panel, join(artifacts, `${shot}-editing.png`));
    await rp.evaluate(panel, `document.querySelector('button[data-memory-action="save"][data-memory-id="${entry.id}"]').click()`);
    await until(async () => await rp.evaluate(panel, `!document.querySelector('textarea[data-memory-field="text"][data-memory-id="${entry.id}"]')`) || undefined, 10_000, "保存修改");
    await rp.click(panel, "#memory-close");
  };

  await say();
  const a = await opened([...OLD, ...NEW]);
  check("a 说那句话：打开记下的两个旧渠道", OLD.every(url => a.includes(url.slice(origin.length))) && !a.some(u => u.startsWith("/new")), a);
  await closeAll();

  await edit(`听到“${ASK}”时，打开这些渠道：${NEW.join("、")}`, "b");
  await say();
  const b = await opened([...OLD, ...NEW]);
  check("b 面板里改成新网址后再说：打开新渠道，旧渠道一个也不开", NEW.every(url => b.includes(url.slice(origin.length))) && !b.some(u => u.startsWith("/old")), b);
  await rp.screenshot(panel, join(artifacts, "b-after.png"));
  await closeAll();

  await edit(`听到“${ASK}”时不要自动打开任何网页`, "c");
  await say();
  const c = await opened([...OLD, ...NEW]);
  check("c 改成不要自动打开后再说：宿主一个渠道也不开", c.length === 0, c);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, dependency: "real isolated extension, memory panel, local pages; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}
console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", artifacts }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
