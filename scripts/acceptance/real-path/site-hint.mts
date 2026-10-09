/**
 * 站点提示只在对应网站上交给模型（docs/evals/20261010-site-hints-excalidraw.md）。只装扩展、隔离构建、本机脚本模型；需要能上网打开 excalidraw.com。
 *   npx tsx scripts/acceptance/real-path/site-hint.mts --headless
 * 同一个标签页先开真实的 excalidraw.com 发一句话，再换到本机练习页、新开对话发一句话。脚本模型记下每次请求的内容。
 *   a) 在 excalidraw.com 上，这一轮第一次带工具的模型请求里有 Excalidraw 的做法（粘贴 excalidraw/clipboard）。
 *   b) 在本机练习页上，这一轮第一次带工具的模型请求里没有这段做法。
 * 失败方式：去掉注入（或把表里的网站改成别的），a 失败。反例结果见验收文件。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-site-hint`);

await mkdir(out, { recursive: true });

const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>练习页</title><body><h1>练习页</h1><p>这里没有画板。</p></body></html>`); });

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ON_SITE = "站点提示案例一：在这个画板上画两个方框。";

const OFF_SITE = "站点提示案例二：这个页面讲了什么？";

/** 提示里一定有的两句：标题和创建方法。 */
const MARKS = ["# Site hint (excalidraw.com)", "excalidraw/clipboard"];

type Part = { text?: string };

type Message = { role: string; content?: string | Part[] | null };

const textOf = (content: Message["content"]) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";

/** 每个任务第一次带工具的请求：系统提示词全文。 */
const firstPrompt = new Map<string, string>();

const model = await startScriptedModel([
  { match: ON_SITE, steps: [{ text: "好的，我来画。" }] },
  { match: OFF_SITE, steps: [{ text: "这是一个练习页。" }] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const messages = (payload.messages ?? []) as Message[];
  const ask = [ON_SITE, OFF_SITE].find(text => messages.some(m => m.role === "user" && textOf(m.content).includes(text)));

  if (ask && !firstPrompt.has(ask)) firstPrompt.set(ask, messages.filter(m => m.role === "system").map(m => textOf(m.content)).join("\n"));
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: "https://excalidraw.com" }, work);
  await until(async () => (await rp.evaluate(work, `!!document.querySelector(".excalidraw canvas")`).catch(() => false)) || undefined, 60_000, "Excalidraw 画布");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");

  /** 在当前页发一句话，等这一轮的模型请求到达、侧栏回到空闲。 */
  const ask = async (text: string) => {
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => firstPrompt.has(text) || undefined, 60_000, `模型收到：${text}`, 100);
    await sleep(1_000);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏空闲");
  };

  await ask(ON_SITE);
  await rp.screenshot(work, join(out, "a-excalidraw.png"));
  const onSite = firstPrompt.get(ON_SITE) ?? "";
  check("a 在 excalidraw.com 上，模型请求里有 Excalidraw 的做法", MARKS.every(mark => onSite.includes(mark)), { found: MARKS.filter(mark => onSite.includes(mark)), promptChars: onSite.length });

  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await until(async () => (await rp.evaluate(work, `document.title === "练习页"`).catch(() => false)) || undefined, 15_000, "练习页");
  await rp.click(panel, "#conversation-new");
  await sleep(1_500);
  await ask(OFF_SITE);
  const offSite = firstPrompt.get(OFF_SITE) ?? "";
  check("b 在本机练习页上，模型请求里没有这段做法", offSite.length > 0 && MARKS.every(mark => !offSite.includes(mark)), { found: MARKS.filter(mark => offSite.includes(mark)), promptChars: offSite.length });
  await rp.screenshot(panel, join(out, "b-panel.png"));
  await writeFile(join(out, "prompts.json"), JSON.stringify({ onSite: onSite.slice(-2_500), offSiteTail: offSite.slice(-600) }, null, 2));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
