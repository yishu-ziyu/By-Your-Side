import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-goal-check-facts`);
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>练习页</title><body><h1>练习页</h1><button id="mark">记一下</button></body></html>`;
const serve = () => createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
const home = serve(), other = serve();
await new Promise<void>(done => home.listen(0, "127.0.0.1", done));
await new Promise<void>(done => other.listen(0, "127.0.0.1", done));
const otherUrl = `http://127.0.0.1:${siteAddress(other).port}/notes`;

const done = (pointedFound: boolean) => JSON.stringify({ items: [{ text: "这件事", done: true }], goalOnPage: true, pointedFound, status: "done", remaining: "", correction: "" });
const verdict = { text: done(true) };
const REWRITE = "在那一页上没找到，要不要换个做法？";
const rules: Rule[] = [{ match: '"goalPage"', steps: [verdict] }, { match: "[GOAL CHECK]", steps: [{ text: REWRITE }] }];
type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
const repairs: string[] = [], checkInputs: string[] = [];
const model = await startScriptedModel(rules, undefined, payload => {
  const messages = (payload.messages ?? []) as Message[];
  const last = textOf(messages.filter(m => m.role === "user").at(-1) ?? { role: "user" });
  if (last.includes('"goalPage"')) checkInputs.push(last);
  for (const message of messages) if (message.role === "user" && textOf(message).includes("[GOAL CHECK]") && !repairs.includes(textOf(message))) repairs.push(textOf(message));
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const shown = (text: string) => `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(text)})`;

try {
  const homeUrl = `http://127.0.0.1:${siteAddress(home).port}/`;
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: homeUrl }, work);
  await rp.cdp.send("Target.createTarget", { url: "about:blank", background: true });
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");

  const run = async (task: string, answer: string, steps: Rule["steps"], text: string) => {
    verdict.text = text;
    repairs.length = 0;
    rules.push({ match: task, steps: [...steps, { text: answer }] });
    await rp.cdp.send("Page.navigate", { url: homeUrl }, work);
    await rp.click(panel, "#conversation-new");
    await sleep(800);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#input"); await rp.typeText(panel, task); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, shown(answer)) || undefined, 30_000, `回答：${answer}`);
    await sleep(3_000);
  };
  const elsewhere: Rule["steps"] = [{ tool: { name: "navigate", args: { url: otherUrl } } }, { tool: { name: "click", args: { target: "#mark" } } }];

  await run("用例 a：去笔记网站点记一下。", "已在笔记网站记好。", elsewhere, done(true));
  check("用户要去别的网站，模型也认为找到了目标：回答不被要求重写", repairs.length === 0, { repairs: repairs.map(r => r.slice(0, 120)) });

  await run("用例 b：点这一页的记一下。", "这一页上的按钮点好了。", [{ tool: { name: "click", args: { target: "#mark" } } }], done(false));
  check("模型说没找到，但助手没离开这一页：回答不被要求重写", repairs.length === 0, { repairs: repairs.map(r => r.slice(0, 120)) });

  await run("用例 c：这一页第三个视频讲什么。", "我去别的网站查到了答案。", elsewhere, done(false));
  await until(async () => await rp.evaluate(panel, shown(REWRITE)) || undefined, 30_000, "改写后的回答");
  check("模型说没找到，助手又确实去了别的网站：仍然要求说清楚", repairs.some(r => r.includes("The user pointed at something")), { repairs: repairs.map(r => r.slice(0, 120)) });

  const unfinished = JSON.stringify({ items: [{ text: "第二件事", done: false }], goalOnPage: false, status: "continue", repair: "complete_task", verificationSubject: "answer", remaining: "第二件事", correction: "", finding: "", evidence: "第一件做好了" });
  await run("用例 d：做两件事。", "第一件做好了。", [{ tool: { name: "click", args: { target: "#mark" } } }], unfinished);
  await until(async () => repairs.length > 0 || undefined, 30_000, "继续提示");
  check("只凭模型读回答的判断，不对助手说已确认", repairs[0]!.includes("not verified against the page") && !repairs[0]!.includes("check confirmed"), { repair: repairs[0]!.slice(0, 200) });

  checkInputs.length = 0;
  await run("用例 e：开一个标签页再关掉。", "开了又关了。", [{ tool: { name: "tabs", args: { action: "open", url: otherUrl } } }, { tool: { name: "tabs", args: { action: "close" } } }], done(true));
  const facts = checkInputs.at(-1) ?? "";
  check("关掉标签页作为事实交给核对", facts.includes('"closed":true'), { navigation: facts.match(/"navigation":.{0,300}/)?.[0] ?? null });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(end => home.close(() => end())); await new Promise<void>(end => other.close(() => end()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
