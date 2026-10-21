/**
 * 页面加载时就调了自己的数据接口（播放器拿字幕、列表拿数据），助手之后才来看网页请求：这条请求要看得到，
 * 否则模型只能自己拼一个没签名的接口地址，拿到错的数据（B 站字幕那次 9 分钟就耗在这）。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/network-before-recording.mts --headless
 *   a) 模型看网页请求时，结果里有页面加载时那条 /api/player 请求，并标明是记录开始前的。
 *   b) 模型清空记录再看：加载时那条不再补回来。
 * 失败方式：只读扩展自己记下的请求，a 失败。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-network-before-recording`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>视频页</title><body><main><h1>一期访谈</h1><p id="state">加载中</p></main>
<script>fetch("/api/player?aid=7&cid=9&w_rid=signed").then(r => r.json()).then(j => { document.querySelector("#state").textContent = "字幕 " + j.subtitles.length + " 条"; });</script></body></html>`;
const site = createServer((req, res) => {
  if (req.url?.startsWith("/api/player")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ subtitles: [] }));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const port = siteAddress(site).port;

const LOOK = "请求核对一：看看这页加载时调了哪些接口";
const CLEARED = "请求核对二：清空后再看";
const results: string[] = [];
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
const model = await startScriptedModel([
  { match: LOOK, steps: [{ tool: { name: "network", args: { urlContains: "/api/" } } }, { text: "看到了页面加载时的接口。" }] },
  { match: CLEARED, steps: [{ tool: { name: "network", args: { clear: true } } }, { tool: { name: "network", args: { urlContains: "/api/" } } }, { text: "清空后再看了一遍。" }] },
], undefined, payload => {
  const last = payload.messages?.at(-1);

  if (last?.role === "tool" && /network/i.test(textOf(last.content))) results.push(textOf(last.content));
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/video` }, work);
  await until(async () => await rp.evaluate(work, `document.querySelector("#state")?.textContent.startsWith("字幕")`), 30_000, "页面加载完");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  const say = async (text: string, done: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(done)}))`) || undefined, 60_000, `回答：${done}`);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  };

  await say(LOOK, "看到了页面加载时的接口");
  const seen = results.at(-1) ?? "";
  check("a 看网页请求时有加载时那条 /api/player，标明记录开始前", /\/api\/player\?aid=7&cid=9&w_rid=signed[^\n]*\(before recording\)/.test(seen), { result: seen.slice(0, 600) });

  await rp.click(panel, "#conversation-new");
  await sleep(1_500);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");
  await say(CLEARED, "清空后再看了一遍");
  const after = results.at(-1) ?? "";
  check("b 清空记录后，加载时那条不再补回来", !after.includes("/api/player"), { result: after.slice(0, 400) });
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, results }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
