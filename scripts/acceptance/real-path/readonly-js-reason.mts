import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule, type Step } from "./scripted-model.mts";

requireHeadless();

const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-readonly-js-reason`);
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>白板练习页</title><body><h1>白板练习页</h1><button id="mark" onclick="fetch('/clicked',{method:'POST'})">记一下</button></body></html>`;
const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const TASK = "用例 stuck：把内容画到白板上。";
const STOP_REPLY = "卡住了，要我换哪种办法？";
const unfinished = JSON.stringify({ items: [{ text: "画到白板", done: false }], goalOnPage: false, status: "continue", repair: "complete_task", verificationSubject: "answer", remaining: "画到白板", finding: "白板还是空的", correction: "", evidence: STOP_REPLY });
const failingReads = (prefix: string): Step[] => Array.from({ length: 16 }, (_, index) => ({ tool: { name: "js", args: { code: `localStorage.getItem('${prefix}${index}')` } } }));
const rules: Rule[] = [
  { match: '"goalPage"', steps: [{ text: unfinished }] },
  { match: TASK, steps: [...failingReads("first"), { text: STOP_REPLY, delayMs: 1_000 }] },
];
type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
const toolTexts = new Set<string>();
const model = await startScriptedModel(rules, undefined, payload => {
  const messages = (payload.messages ?? []) as Message[];
  for (const message of messages) if (message.role === "tool") toolTexts.add(textOf(message));
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const panelText = (panel: string) => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""') as Promise<string>;

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await rp.cdp.send("Target.createTarget", { url: "about:blank", background: true });
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  const idle = () => rp.evaluate(panel, '!document.querySelector("#status-pill")?.classList.contains("running")');
  const say = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  await rp.cdp.send("Page.bringToFront", {}, work);

  await say(TASK);
  await until(async () => (await panelText(panel)).includes("原地打转") && await idle() || undefined, 60_000, "第一次停下");
  await sleep(4_000);
  const readError = [...toolTexts].find(t => t.includes("只读表达式")) ?? "";
  check("被只读模式拒绝时，报错写明原因和该换什么办法", readError.includes("换写法也会被拒绝") && readError.includes("snapshot"), { readError: readError.slice(0, 160) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
