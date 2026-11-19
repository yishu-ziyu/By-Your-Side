import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-read-midsize-direct`);
await mkdir(out, { recursive: true });

const TAIL_MARKER = "文章末尾唯一核对句：二零二六年底总结。";
const MID_PARA = "这是一段用于构成一万八千字常规文章的可见正文内容，用于检验预读能否直接完整读取而不必先阻塞调模型。".repeat(380);
const LONG_PARA = "这是一段用于构成三万六千字超长文章的可见正文内容，用于检验超长页仍走范围判断。".repeat(950);
const MID_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>常规长文</title><body><article><h1>常规长文</h1><p>${MID_PARA}</p><p>${TAIL_MARKER}</p><button id="act">下一步</button></article></body></html>`;
const LONG_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>超长文章</title><body><article><h1>超长文章</h1><p>${LONG_PARA}</p><button id="act">下一步</button></article></body></html>`;

const site = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/long" ? LONG_PAGE : MID_PAGE);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${siteAddress(site).port}`;

type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
let scopeCalls = 0;
let obsPrompt = "";

const rules: Rule[] = [
  { match: '"requests"', steps: [{ text: '{"scope":"local"}' }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ items: [{ text: "回答问题", done: true }], goalOnPage: true, pointedFound: true, status: "done", remaining: "", correction: "" }) }] },
  { match: "结尾写了什么", steps: [{ text: "结尾已核对。" }] },
  { match: "超长页标题是什么", steps: [{ text: "超长页已核对。" }] },
];
const model = await startScriptedModel(rules, undefined, payload => {
  const messages = (payload.messages ?? []) as Message[];
  const sys = messages.filter(m => m.role === "system").map(textOf).join("\n");
  if (sys.includes("Classify how much of the current page")) scopeCalls += 1;
  for (const m of messages) {
    const t = textOf(m);
    if (m.role === "user" && t.includes("[FRESH PAGE OBSERVATION")) obsPrompt = t;
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${baseUrl}/mid` }, work);
  await until(async () => await rp.evaluate(work, `document.body?.innerText.includes(${JSON.stringify(TAIL_MARKER)})`) || undefined, 15_000, "常规页加载");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, "结尾写了什么"); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("结尾已核对")`) || undefined, 30_000, "回答显示");

  const marker = "[Accessibility tree of the same page";
  const hasTree = obsPrompt.includes(marker);
  const mainBlock = hasTree ? obsPrompt.split(marker)[0]! : obsPrompt;
  check("1.8 万字常规文章免调 page_read_scope 阻塞判断", scopeCalls === 0, { scopeCalls });
  check("预读主正文段一次带回完整正文末尾且保留控件树", mainBlock.includes(TAIL_MARKER) && hasTree, { hasTailInMain: mainBlock.includes(TAIL_MARKER), hasTree, mainLen: mainBlock.length });

  scopeCalls = 0;
  await rp.cdp.send("Page.navigate", { url: `${baseUrl}/long` }, work);
  await until(async () => await rp.evaluate(work, `document.title === "超长文章" && (document.body?.innerText.length ?? 0) > 32000`) || undefined, 15_000, "超长页加载");
  await rp.click(panel, "#conversation-new");
  await sleep(800);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, "超长页标题是什么"); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("超长页已核对")`) || undefined, 30_000, "超长页回答");
  check("超过 3 万字的超长文章仍保留 page_read_scope 判断", scopeCalls >= 1, { scopeCalls });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(end => site.close(() => end()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
