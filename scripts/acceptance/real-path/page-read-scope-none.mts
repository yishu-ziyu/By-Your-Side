import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-read-scope-none`);
await mkdir(out, { recursive: true });

const SENTINEL = "无关超长页正文唯一标记九九八一";
const LONG_PARA = `${SENTINEL}：这是一段用于构成三万六千字超长无关文章的可见正文内容。`.repeat(850);
const LONG_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>无关超长文章</title><body><article><h1>无关超长文章</h1><p>${LONG_PARA}</p><button id="act">按钮</button></article></body></html>`;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(LONG_PAGE);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${siteAddress(site).port}`;

type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
let scopeCalls = 0;
let mainUserPrompt = "";

const rules: Rule[] = [
  { match: '"requests"', steps: [{ text: '{"scope":"none"}' }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ items: [{ text: "回答问题", done: true }], goalOnPage: false, status: "done", remaining: "", correction: "" }) }] },
  { match: "讲个两字冷笑话", steps: [{ text: "好冷。" }] },
];

const model = await startScriptedModel(rules, undefined, payload => {
  const messages = (payload.messages ?? []) as Message[];
  const sys = messages.filter(m => m.role === "system").map(textOf).join("\n");
  if (sys.includes("Classify how much of the current page")) scopeCalls += 1;
  if (payload.tools?.length) {
    for (const m of messages) {
      const t = textOf(m);
      if (m.role === "user" && t.includes("讲个两字冷笑话")) mainUserPrompt = t;
    }
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${baseUrl}/long` }, work);
  await until(async () => await rp.evaluate(work, `(document.body?.innerText.length ?? 0) > 32000`) || undefined, 15_000, "超长页加载");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, "讲个两字冷笑话"); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("好冷")`) || undefined, 30_000, "回答显示");

  check("超长页触发了范围判断并返回 none", scopeCalls === 1, { scopeCalls });
  check("判定与当前页无关时不再把无关长文和控件树塞进主模型提示", !mainUserPrompt.includes(SENTINEL) && !mainUserPrompt.includes("[FRESH PAGE OBSERVATION"), { promptLen: mainUserPrompt.length, hasSentinel: mainUserPrompt.includes(SENTINEL), hasObs: mainUserPrompt.includes("[FRESH PAGE OBSERVATION") });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(end => site.close(() => end()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
