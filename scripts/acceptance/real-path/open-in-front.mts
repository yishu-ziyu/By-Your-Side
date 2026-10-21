/**
 * 用户只是要打开一个网页来看（「打开练习页」）：助手用 tabs show 带 url，新页直接出现在用户眼前，不用再点「切过去看」。
 * 做事时开的页（tabs open）照旧开在后台，不换走用户正在看的页。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/open-in-front.mts --headless
 *   a) 「打开练习页」：模型调 tabs show + url 后，活动标签页就是练习页；工具结果写明用户正在看它。
 *   b) 「去练习页读一下标题」：模型调 tabs open，活动标签页仍是用户原来的页。
 * 失败方式：tabs show 不接受 url（旧行为，要求 tabId），a 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-open-in-front`);

await mkdir(out, { recursive: true });

const site = createServer((req, res) => {
  const title = req.url?.startsWith("/work") ? "做事页" : "练习页";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1></body></html>`);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const SHOW = "前台测试：打开练习页";
const WORK = "前台测试：去做事页读一下标题";
let toolResult = "";

const model = await startScriptedModel([
  { match: SHOW, steps: [{ tool: { name: "tabs", args: { action: "show", url: `${origin}/practice` } } }, { text: "练习页已经打开在你眼前。" }] },
  { match: WORK, steps: [{ tool: { name: "tabs", args: { action: "open", url: `${origin}/work` } } }, { text: "做事页的标题是「做事页」。" }] },
], undefined, payload => {
  const messages = (payload.messages ?? []) as Array<{ role: string; content?: unknown }>;
  const tool = messages.filter(m => m.role === "tool").at(-1);

  if (tool) toolResult = typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content);
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const activeTitle = async () => String(await rp.evaluate(panel, `chrome.tabs.query({ active: true, currentWindow: true }).then(t => t[0]?.title ?? "")`));
  const say = async (text: string, done: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(done)}))`) || undefined, 60_000, `回答：${done}`);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  };
  const before = await activeTitle();

  await say(SHOW, "练习页已经打开在你眼前");
  const afterShow = await activeTitle();
  check("a 「打开练习页」：练习页直接出现在眼前", afterShow === "练习页", { before, afterShow, toolResult: toolResult.slice(0, 200) });
  check("a 工具结果写明用户正在看这一页", /in front of the user|looking at it now/.test(toolResult), toolResult.slice(0, 200));
  await rp.screenshot(panel, join(out, "a-panel.png"));

  await say(WORK, "做事页的标题是");
  const afterOpen = await activeTitle();
  check("b 做事时开的页仍在后台，用户眼前还是练习页", afterOpen === "练习页", { afterOpen });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
