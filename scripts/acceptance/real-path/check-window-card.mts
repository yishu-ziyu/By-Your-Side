/**
 * 中途有一步没找到目标、但任务做完了：目标核对出结论前的几秒里，不先闪出「没做成 · 继续原任务」再收回。
 * 只装扩展、隔离构建、本机脚本模型；目标核对晚 4 秒回「做完了」，这段时间每 200 毫秒看一次侧栏。
 *   npx tsx scripts/acceptance/real-path/check-window-card.mts --headless
 *   a) 回答出来到核对出结论之间，一次都没出现「继续原任务」。
 *   b) 核对出结论后过程行是「已核对页面」，也没有「继续原任务」。
 * 失败方式：核对期间照常按任务视图出卡，a 失败。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-check-window-card`);

await mkdir(out, { recursive: true });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>条目</title><body><main><h1>故宫</h1><p>明清两朝的皇宫。</p></main></body></html>`));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const TASK = "核对窗口：打开这个条目";
const ANSWER = "已打开「故宫」条目。";
const DONE_JSON = JSON.stringify({ items: [{ text: "打开条目", done: true }], status: "done", remaining: "" });

const model = await startScriptedModel([
  // 目标核对的输入带 lastReply，排在前面；晚 4 秒回，留出能看清的核对窗口。
  { match: `"lastReply"`, steps: [{ text: DONE_JSON, delayMs: 4_000 }] },
  { match: TASK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${siteAddress(site).port}/` } } },
    { tool: { name: "click", args: { target: "#search-box-that-is-not-here", label: "搜索框" } } },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")'), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(ANSWER)}))`) || undefined, 60_000, "回答");
  const look = `(() => { const r = document.querySelector("#resume-entry-root"); return { card: !!r && !r.hidden && r.childElementCount > 0 && r.textContent.includes("继续原任务") ? r.textContent.replace(/\\s+/g, " ").slice(0, 80) : "", line: [...document.querySelectorAll(".run-check")].map(e => e.textContent.replace("·", "").trim()).filter(Boolean).at(-1) ?? "" }; })()`;
  const flashes: string[] = [];
  let last = { card: "", line: "" };

  for (let i = 0; i < 60; i++) {
    last = await rp.evaluate(panel, look) as { card: string; line: string };

    if (last.card) flashes.push(last.card);

    if (last.line && last.line !== "核对中…") break;
    await sleep(200);
  }
  await sleep(1_000);
  const after = await rp.evaluate(panel, look) as { card: string; line: string };
  await rp.screenshot(panel, join(out, "panel.png"));
  check("a 核对出结论前没闪出「继续原任务」", flashes.length === 0, { flashes: flashes.slice(0, 2), samples: flashes.length });
  check("b 结论是「已核对页面」，也没有「继续原任务」", after.line === "已核对页面" && !after.card, after);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
