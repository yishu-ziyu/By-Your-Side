import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-translation-intent-prefetch`);
await mkdir(out, { recursive: true });

const page = '<article><h1>Notes</h1><p id="first">The north station opened in April.</p><p id="second">The harbor received the second instrument on Friday.</p></article>';
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(page));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${siteAddress(server).port}/article`;

const events: Array<{ kind: string; at: number }> = [];
const t0 = Date.now();
let holdSecondIntent = false;
let secondMainSeen: (() => void) | null = null;
const secondMainReady = new Promise<void>(resolve => { secondMainSeen = resolve; });
const model = await startScriptedModel([
  {
    match: "把前两段译文双语放进网页",
    pageTranslationTargetsMatch: true,
    pageTranslationDestination: "scoped",
    pageTranslationParagraphs: [1, 2],
    steps: [
      { delayMs: 600, tool: { name: "page_translation", args: { action: "translate", mode: "bilingual", scope: { url, quotes: ["The north station opened in April.", "The harbor received the second instrument on Friday."] } } } },
      { text: "前两段已双语写入。" },
    ],
  },
  {
    match: "把第二段再双语写进网页",
    pageTranslationTargetsMatch: true,
    pageTranslationDestination: "scoped",
    pageTranslationParagraphs: [2],
    steps: [
      { delayMs: 20, tool: { name: "page_translation", args: { action: "translate", mode: "bilingual", scope: { url, quotes: ["The harbor received the second instrument on Friday."] } } } },
      { text: "第二段已双语写入。" },
    ],
  },
  {
    match: "简短回一句你好",
    steps: [{ text: "你好，已立刻切到新问题。" }],
  },
], { delayMs: 40 }, async payload => {
  const sys = (payload.messages ?? []).filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n");
  if (sys.startsWith("Classify permission to write translations into a webpage.")) {
    events.push({ kind: "intent", at: Date.now() - t0 });
    if (holdSecondIntent) {
      await new Promise(resolve => setTimeout(resolve, 4500));
    }
  } else if (payload.tools?.length) {
    events.push({ kind: "main", at: Date.now() - t0 });
    if (holdSecondIntent) secondMainSeen?.();
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  await until(async () => await rp.evaluate(work, 'document.querySelectorAll("p").length === 2'), 15_000, "练习页就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled === false && document.querySelector("#send-btn")?.disabled === false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input");
  await rp.typeText(panel, "把前两段译文双语放进网页");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `${ready} && [...document.querySelectorAll("#messages .msg.assistant")].some(n => n.innerText.includes("前两段已双语写入"))`), 60_000, "翻译完成");

  const written = await rp.evaluate(work, `document.querySelectorAll('[data-bys-translation="true"]').length`);
  const intentEvents = events.filter(e => e.kind === "intent");
  const firstMain = events.find(e => e.kind === "main");
  const gapMs = intentEvents[0] && firstMain ? intentEvents[0].at - firstMain.at : null;
  check("网页成功写入两段双语译文", written === 2, { written });
  check("翻译授权分类器在主模型思考期间提前并行启动且仅调用一次", intentEvents.length === 1 && gapMs !== null && gapMs < 350, { intentCount: intentEvents.length, gapMs, events });

  holdSecondIntent = true;
  await rp.click(panel, "#input");
  await rp.typeText(panel, "把第二段再双语写进网页");
  await rp.pressEnter(panel);
  await Promise.race([secondMainReady, new Promise((_, rej) => setTimeout(() => rej(new Error("未等到第二轮主模型发出工具调用")), 15_000))]);
  await new Promise(resolve => setTimeout(resolve, 400));
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping")'), 10_000, "侧栏出现停止按钮");
  const stopClickedAt = Date.now();
  await rp.click(panel, "#send-btn");
  await until(async () => await rp.evaluate(panel, `${ready} && !document.querySelector("#send-btn")?.classList.contains("stopping")`), 15_000, "停止后恢复就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "简短回一句你好");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].some(n => n.innerText.includes("你好，已立刻切到新问题"))`), 15_000, "新问题回答显示");
  const recoverElapsedMs = Date.now() - stopClickedAt;
  check("预热授权挂起时点击停止会立刻中止，不再卡住后续新请求", recoverElapsedMs < 2500, { recoverElapsedMs });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, events }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
