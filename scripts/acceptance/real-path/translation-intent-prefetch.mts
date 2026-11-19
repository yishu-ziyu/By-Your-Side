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
], { delayMs: 40 }, payload => {
  const sys = (payload.messages ?? []).filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n");
  if (sys.startsWith("Classify permission to write translations into a webpage.")) events.push({ kind: "intent", at: Date.now() - t0 });
  else if (payload.tools?.length) events.push({ kind: "main", at: Date.now() - t0 });
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
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, events }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
