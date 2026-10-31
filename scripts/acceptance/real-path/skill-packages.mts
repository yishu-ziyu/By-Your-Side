/** Real extension and sidebar, scripted model and local video/VTT pages. Only the two direct entries must add no model calls. */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { PRODUCT_DATA, startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-skill-packages`);
await mkdir(out, { recursive: true });
const requests: string[] = [];
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture.local");
  requests.push(url.href);
  if (url.pathname.endsWith(".vtt")) {
    const name = url.pathname.slice(1, -4).toUpperCase();
    if (!["ALPHA", "BETA"].includes(name)) { res.writeHead(404).end("missing"); return; }
    res.writeHead(200, { "content-type": "text/vtt; charset=utf-8" }).end(`WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${name} subtitle line one\n\n00:00:04.000 --> 00:00:06.000\n${name} subtitle line two\n`);
    return;
  }
  const video = url.searchParams.get("video") ?? "alpha";
  const language = video === "empty" ? "zh" : "en";
  const track = video === "broken" ? "missing" : video;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>字幕练习 ${video}</title><body><main><h1>字幕练习 ${video}</h1><video controls><track kind="subtitles" src="/${track}.vtt" srclang="${language}" label="${language}"></video></main></body></html>`);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const host = "captions-fixture.test";
const origin = `http://${host}`;
const FIRST = "读取这个视频的字幕";
const SAVE = "把刚才的做法存成技能，名字叫「字幕」";
const inputSchema = { type: "object", additionalProperties: false, properties: { language: { type: "string", minLength: 2, maxLength: 12 }, format: { type: "string", minLength: 3, maxLength: 3 } }, required: ["language", "format"] };
const outputSchema = { type: "object", additionalProperties: false, properties: { language: { type: "string" }, format: { type: "string" }, text: { type: "string" } }, required: ["language", "format", "text"] };
const program = (input: string) => `const found=await browser.videoCaptions({});
const track=found.captionTracks.find(item=>item.lang===${input}.language&&item.url);
if(!track)return {status:"empty",data:{language:${input}.language,format:${input}.format,text:""},sourceUrl:found.sourceUrl,appliedInput:${input}};
const file=await browser.fetch({url:track.url});
await browser.assert({ok:file.ok,name:"字幕文件可读取",reason:"字幕文件请求失败"});
const lines=file.text.split(/\\r?\\n/);
let text="";
if(${input}.format==="txt")text=lines.filter(line=>line&&line!=="WEBVTT"&&!line.includes("-->")&&!/^\\d+$/.test(line)).join("\\n");
else text=lines.filter(line=>line!=="WEBVTT").join("\\n").replaceAll(".000",",000");
return {status:"observed",data:{language:${input}.language,format:${input}.format,text},sourceUrl:file.url,appliedInput:${input}};`;
const rules: Rule[] = [
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: '"visitedHosts"', steps: [{ text: JSON.stringify({ notes: [] }) }] },
  { match: FIRST, steps: [{ tool: { name: "browser_run", args: { code: program('{language:"en",format:"txt"}') } } }, { text: "ALPHA subtitle line one" }] },
  { match: SAVE, steps: [{ tool: { name: "learned_operation", args: { action: "save", name: "字幕", purpose: "读取当前视频字幕并转成文本", inputSchema, outputSchema, code: program("input"), exampleInput: { language: "en", format: "txt" }, validationInput: { language: "en", format: "srt" }, validationExpect: "observed" } } }, { text: "已保存字幕技能" }] },
];
const turns = new Map<string, string[]>();
const model = await startScriptedModel(rules, undefined, payload => {
  const messages = payload.messages ?? [];
  const textOf = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
  let at = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "user" && !PRODUCT_DATA.some(head => textOf(messages[index]!.content).startsWith(head))) { at = index; break; }
  if (at < 0) return;
  const text = textOf(messages[at]!.content);
  turns.set(text, messages.slice(at + 1).filter(message => message.role === "tool").map(message => textOf(message.content)));
});
const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${host} 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
let panel = "";
let work = "";
const idle = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
const send = async (text: string, expected: string, goalChecks: number) => {
  const before = model.requests.filter(request => request.rule === '"goalPage"' && request.finished).length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m=>m.textContent.includes(${JSON.stringify(expected)})) && ${idle}`), 90_000, `交付 ${text}`);
  await until(() => model.requests.filter(request => request.rule === '"goalPage"' && request.finished).length >= before + goalChecks, 30_000, `目标核对 ${text}`);
};
// 保存和翻页会延迟触发上一轮的模型核对；等它们安静后，才单独计量这次直接运行。
const settleModel = async () => {
  let count = model.requests.length;
  let since = Date.now();
  await until(() => {
    if (model.requests.length !== count) { count = model.requests.length; since = Date.now(); return undefined; }
    return model.requests.every(request => request.finished) && Date.now() - since >= 3_500 ? true : undefined;
  }, 20_000, "上一轮模型核对收尾");
};
const idb = 'new Promise((resolve,reject)=>{const req=indexedDB.open("sideagent-memory");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const get=db.transaction("kv").objectStore("kv").get("learned-operations");get.onerror=()=>reject(get.error);get.onsuccess=()=>{const raw=get.result;db.close();resolve(typeof raw==="string"?JSON.parse(raw):null)}}})';
const readOperations = async () => rp.evaluate(panel, idb) as Promise<{ operations: Array<Record<string, unknown>> } | null>;
const navigate = async (video: string) => {
  await rp.cdp.send("Page.navigate", { url: `${origin}/?video=${video}` }, work);
  await until(() => rp.evaluate(work, `location.search===${JSON.stringify(`?video=${video}`)}&&document.readyState==="complete"&&!!document.querySelector("video track")`), 15_000, `${video} 页面加载`);
};
const pageSkill = (expression: string) => `(()=>{const host=document.querySelector("[data-sideagent-skill-packages]");const root=host?.shadowRoot;return ${expression}})()`;
try {
  work = await rp.attach((await rp.targets()).find(target => target.url === "about:blank")!.targetId);
  await navigate("alpha");
  panel = await rp.attach(await rp.openSidePanel());
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, inproc_fast_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })})`);
  await send(FIRST, "ALPHA subtitle line one", 1);
  await send(SAVE, "已保存字幕技能", 1);
  await until(async () => (await readOperations())?.operations.length === 1 || undefined, 20_000, "字幕技能落盘");
  const operation = (await readOperations())!.operations[0]!;

  await rp.click(panel, "#input");
  await rp.typeText(panel, "/");
  await until(() => rp.evaluate(panel, `!document.querySelector("#pskill-menu")?.hidden&&!!document.querySelector("#pskill-menu .pskill-op")`), 15_000, "字幕技能菜单");
  await rp.evaluate(panel, `document.querySelector("#pskill-menu .pskill-manage-entry").click();true`);
  await until(() => rp.evaluate(panel, `!document.querySelector(".pskill-sheet")?.hidden&&document.querySelector(".pskill-sheet").textContent.includes("字幕")`), 10_000, "技能管理");
  await rp.evaluate(panel, `[...document.querySelectorAll(".pskill-sheet .pskill-row")].find(row=>row.textContent.includes("字幕"))?.querySelector("[data-package-config]")?.click();true`);
  await until(() => rp.evaluate(panel, `!!document.querySelector("[data-package-form]")`), 10_000, "配置字幕技能");
  await rp.evaluate(panel, `(()=>{document.querySelector("[data-package-page]").click();document.querySelector('[data-package-form] [name="language"]').value="en";document.querySelector('[data-package-form] [name="format"]').value="txt";return true})()`);
  await rp.screenshot(panel, join(out, "config-form.png"));
  await rp.evaluate(panel, `document.querySelector("[data-package-form]").requestSubmit();true`);
  const config = await rp.evaluate(panel, `chrome.storage.local.get("sideagent_skill_packages").then(value=>value.sideagent_skill_packages)`);
  check("两个入口和默认参数持久化", JSON.stringify(config).includes(operation.id as string) && JSON.stringify(config).includes('"pageButton":true') && JSON.stringify(config).includes('"format":"txt"'), config as Json);
  await rp.screenshot(panel, join(out, "configured.png"));
  await rp.evaluate(panel, `document.querySelector(".pskill-shade").click();true`);

  await navigate("beta");
  await settleModel();
  const beforeSlash = model.requests.length;
  await rp.evaluate(panel, `(()=>{const i=document.querySelector("#input");i.value="/";i.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  await until(() => rp.evaluate(panel, `!document.querySelector("#pskill-menu")?.hidden&&[...document.querySelectorAll("#pskill-menu .pskill-op")].some(row=>row.textContent.includes("字幕"))`), 15_000, "新页面上的字幕技能");
  await rp.evaluate(panel, `[...document.querySelectorAll("#pskill-menu .pskill-op")].find(row=>row.textContent.includes("字幕")).click();true`);
  await until(() => rp.evaluate(panel, `document.querySelector(".skill-operation-result")?.textContent.includes("BETA subtitle line one")&&document.querySelector(".skill-operation-result")?.textContent.includes("未调用模型")`), 30_000, "斜杠入口直接读到 BETA");
  check("斜杠入口没有调用模型", model.requests.length === beforeSlash, { before: beforeSlash, after: model.requests.length });
  await rp.screenshot(panel, join(out, "slash-result.png"));

  const panelTarget = (await rp.targets()).find(target => target.type === "page" && target.url.includes("/sidepanel.html"))!.targetId;
  await rp.cdp.send("Target.closeTarget", { targetId: panelTarget });
  panel = "";
  await rp.cdp.send("Page.reload", { ignoreCache: true }, work);
  await until(() => rp.evaluate(work, `document.readyState==="complete"&&!!document.querySelector("[data-sideagent-skill-packages]")?.shadowRoot?.querySelector("[data-skill-id]")`), 20_000, "刷新且侧栏关闭后网页按钮恢复");
  await settleModel();
  const beforePage = model.requests.length;
  await rp.evaluate(work, pageSkill(`root.querySelector("[data-skill-id]").click(),true`));
  await until(() => rp.evaluate(work, pageSkill(`root.textContent.includes("BETA subtitle line one")&&root.textContent.includes("未调用模型")`)), 30_000, "网页按钮直接读到 BETA");
  check("网页按钮不依赖侧栏且不调用模型", model.requests.length === beforePage, { before: beforePage, after: model.requests.length });
  await rp.screenshot(work, join(out, "page-result.png"));

  await navigate("broken");
  await until(() => rp.evaluate(work, pageSkill(`!!root.querySelector("[data-skill-id]")`)), 15_000, "失败页按钮");
  await settleModel();
  const beforeFailure = model.requests.length;
  await rp.evaluate(work, pageSkill(`root.querySelector("[data-skill-id]").click(),true`));
  await until(() => rp.evaluate(work, pageSkill(`root.textContent.includes("没有运行成功")`)), 30_000, "网页按钮显示失败");
  check("失败运行同样没有调用模型", model.requests.length === beforeFailure, { before: beforeFailure, after: model.requests.length });
  await rp.screenshot(work, join(out, "page-failure.png"));

  panel = await rp.attach(await rp.openSidePanel());
  await until(() => rp.evaluate(panel, idle), 60_000, "重开侧栏");
  const stored = await readOperations();
  const stats = stored?.operations[0]?.stats as { successes?: number; failures?: number } | undefined;
  check("同一技能记录两次成功和一次失败", stats?.successes === 2 && stats?.failures === 1, stats as Json);
  await rp.evaluate(panel, `(()=>{const i=document.querySelector("#input");i.value="/";i.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  await until(() => rp.evaluate(panel, `!document.querySelector("#pskill-menu")?.hidden`), 10_000, "重开后技能菜单");
  await rp.evaluate(panel, `document.querySelector("#pskill-menu .pskill-manage-entry").click();true`);
  await until(() => rp.evaluate(panel, `!!document.querySelector("[data-package-config]")`), 10_000, "重开后配置入口");
  await rp.evaluate(panel, `document.querySelector("[data-package-config]").click();true`);
  await until(() => rp.evaluate(panel, `!!document.querySelector("[data-package-form]")`), 10_000, "停用页面入口");
  await rp.evaluate(panel, `document.querySelector("[data-package-page]").click();document.querySelector("[data-package-form]").requestSubmit();true`);
  await until(() => rp.evaluate(work, `!document.querySelector("[data-sideagent-skill-packages]")?.shadowRoot?.querySelector("[data-skill-id]")`), 15_000, "停用后网页按钮消失");
  check("停用网页入口立即生效", true, null);
  check("字幕文件确实重新请求", requests.filter(url => url.includes("beta.vtt")).length >= 2, requests.filter(url => url.includes(".vtt")));
} catch (error) {
  check("完整技能包路径", false, String(error));
  if (panel) await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
  if (work) await rp.screenshot(work, join(out, "page-failure-state.png")).catch(() => {});
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(item => item.pass) ? "PASS" : "FAIL", checks, requests, modelRequests: model.requests, turns: Object.fromEntries(turns) }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>(done => site.close(() => done()));
}
console.log(`证据：${out}`);
if (!checks.length || checks.some(item => !item.pass)) process.exitCode = 1;
