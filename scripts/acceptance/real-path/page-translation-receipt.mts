import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-translation-receipt`);
await mkdir(out, { recursive: true });

const page = '<article><h1>Weather notes</h1><p id="first">The north station opened in April.</p><p id="second">The harbor received the second instrument on Friday.</p></article>';
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(page));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${siteAddress(server).port}/article`;

let receiptText = "";
const model = await startScriptedModel([
  {
    match: "把前两段双语写进网页",
    pageTranslationTargetsMatch: true,
    pageTranslationDestination: "scoped",
    steps: [
      { tool: { name: "page_translation", args: { action: "translate", mode: "bilingual", scope: { url, quotes: ["The north station opened in April.", "The harbor received the second instrument on Friday."] } } } },
      { text: "前两段双语译文已写入网页。" },
    ],
  },
], { delayMs: 50 }, payload => {
  if (!payload.tools?.length) return;
  for (const m of payload.messages ?? []) {
    if (m.role !== "tool") continue;
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).map(p => p.text ?? "").join("");
    if (text.includes('"translated":2')) receiptText = text;
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
  await rp.typeText(panel, "把前两段双语写进网页");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `${ready} && [...document.querySelectorAll("#messages .msg.assistant")].some(n => n.innerText.includes("前两段双语译文已写入网页"))`), 60_000, "翻译回答");

  const written = await rp.evaluate(work, `document.querySelectorAll('[data-bys-translation="true"]').length`);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(receiptText) as Record<string, unknown>; } catch { parsed = null; }
  check("网页已写入两段译文", written === 2, { written });
  check("返回给模型的翻译结果不含误导性的空 blocks 且明确标注已生效", !!parsed && !("blocks" in parsed) && parsed.status === "applied" && parsed.translated === 2 && parsed.remaining === 0, { receiptText });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, receiptText }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
