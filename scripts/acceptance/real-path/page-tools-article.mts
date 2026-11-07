import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, REPO, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-tools-article`);
await mkdir(out, { recursive: true });
const SECTIONS = ["起源", "原因", "后果"];
const filler = "<p>正文内容。</p>".repeat(80);
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset=utf-8><title>拖延</title><h1>拖延</h1>${SECTIONS.map(name => `<h2>${name}</h2>${filler}`).join("")}<h2 style="display:none">藏起来的标题</h2>`));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const TOOL = `导航做好了。
<app title="章节导航">
<input id="q" placeholder="搜索"><div id="msg"></div><div id="list"></div>
<script>
const list=document.getElementById("list"),msg=document.getElementById("msg");let rows=[];
const draw=()=>{const q=document.getElementById("q").value;list.innerHTML="";for(const s of rows.filter(s=>s.text.includes(q))){const b=document.createElement("button");b.textContent=s.text;b.onclick=()=>bys.page.jump(s.index).then(()=>{msg.textContent="已跳到 "+s.text}).catch(e=>{msg.textContent=e.message});list.append(b)}};
document.getElementById("q").oninput=draw;
bys.page.read().then(p=>{rows=p.sections;msg.textContent=p.title+" 字数 "+p.text.length;draw()}).catch(e=>{msg.textContent=e.message});
</script>
</app>`;
const model = await startScriptedModel([{ match: "章节", steps: [{ text: TOOL }] }]);
const rp = await launchRealPath();
let error: string | null = null;
const evidence: Record<string, unknown> = {};
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ sideagent_mini_apps: true, inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, "做章节导航"); await rp.pressEnter(panel);
  const frame = await until(async () => (await rp.targets()).find(t => t.type === "iframe" && t.url.includes("mini-app")), 30_000, "小程序出现");
  const app = await rp.attach(frame.targetId);
  const inApp = <T,>(code: string) => rp.evaluate(app, code) as Promise<T>;
  await until(async () => (await inApp<number>('document.querySelectorAll("#list button").length')) === 4 || undefined, 15_000, "读到 4 个可见标题");
  const names = await inApp<string[]>('[...document.querySelectorAll("#list button")].map(b=>b.textContent)');
  assert.deepEqual(names, ["拖延", ...SECTIONS], "只列出页面上看得见的标题");
  assert.match(await inApp<string>('document.getElementById("msg").textContent'), /拖延 字数 \d{3,}/, "读到了页面正文");
  assert.equal(await rp.evaluate(work, "scrollY"), 0, "打开工具不动页面");
  evidence.searched = await inApp<string[]>('(()=>{const q=document.getElementById("q");q.value="后果";q.dispatchEvent(new Event("input",{bubbles:true}));return [...document.querySelectorAll("#list button")].map(b=>b.textContent)})()');
  assert.deepEqual(evidence.searched, ["后果"], "搜索只留下匹配的章节");
  await rp.click(app, "#list button");
  const bar = '#messages .gc-app-bar:not([hidden])';
  await until(async () => (await rp.evaluate(panel, `document.querySelector(${JSON.stringify(bar)})?.innerText ?? ""`) as string).includes("跳到「后果」") || undefined, 10_000, "侧栏写清要跳到哪一节");
  assert.equal(await rp.evaluate(work, "scrollY"), 0, "用户确认前不移动页面");
  await rp.click(panel, `${bar} button`);
  await until(async () => (await inApp<string>('document.getElementById("msg").textContent')) === "已跳到 后果" || undefined, 10_000, "点击后跳转");
  const landed = await rp.evaluate(work, `(()=>{const h=[...document.querySelectorAll("h2")].find(x=>x.textContent==="后果");return Math.abs(Math.round(h.getBoundingClientRect().top))})()`) as number;
  evidence.landed = landed;
  assert.ok(landed < 5, `页面滚到了点的那一节：${landed}`);
  await rp.screenshot(panel, join(out, "jumped.png"));
  await sleep(300);
} catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
await writeFile(join(out, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", error, evidence, dependency: "real isolated extension and side panel; scripted model; local page" }, null, 2));
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", error, evidence, out }));
await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
process.exit(error ? 1 : 0);
