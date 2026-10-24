/**
 * 整页翻译的第一屏：只装扩展的隔离无头 Chrome、真侧栏、本机练习页与本机脚本模型（主模型 2.5 秒后才调用翻译，每批翻译 1.5 秒才回）。
 * a 说「翻译这页」：模型调用翻译之前页面一点不变；调用之后 0.6 秒内出现第一段译文（不再等一批翻译请求）。
 * b 还原后再说「重新翻译」：这页的段落都翻过，一个翻译请求都不发，调用后 0.4 秒内出现译文。
 * c 只问一个词怎么翻、模型没调用翻译：页面始终不被改动。
 *   npx tsx scripts/acceptance/real-path/translate-first-screen.mts --headless
 * 证据在 out/acceptance/real-path/<时间>-translate-first-screen/：每步的网页截图和 result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-translate-first-screen`);
await mkdir(out, { recursive: true });
const PARAGRAPHS = Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i + 1} explains how full duplex voice lets both people talk at the same time without waiting for a turn.</p>`).join("");
const PAGE = `<!doctype html><meta charset="utf-8"><title>Duplex notes</title><h1>Full duplex voice</h1>${PARAGRAPHS}`;
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(PAGE));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const THINK_MS = 2500;
const translate = (action: string) => ({ tool: { name: "page_translation", args: { action } }, delayMs: THINK_MS });
const model = await startScriptedModel([
  { match: "把这个页面翻译成中文", steps: [translate("translate"), { text: "已把这页翻译成中文。" }] },
  { match: "译文还原一下", steps: [{ tool: { name: "page_translation", args: { action: "restore" } } }, { text: "已还原成原文。" }] },
  { match: "重新翻译这一页", steps: [translate("translate"), { text: "已重新翻译。" }] },
  { match: "翻译一下 serendipity", steps: [{ text: "serendipity 意思是「意外发现美好事物的运气」。", delayMs: THINK_MS }] },
], { delayMs: 1500 });
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
// 网页自己记下第一次出现翻译占位（翻译开始动页面）和第一段译文的时刻，与按下回车同一个时钟。
const WATCH = `(() => { const tr = window.__tr = { t0: performance.now(), mark: null, done: null }; new MutationObserver(() => { const now = performance.now(); if (tr.mark === null && document.querySelector('[data-bys-translation]')) tr.mark = now; if (tr.done === null && document.querySelector('[data-bys-translation="true"]')) tr.done = now; }).observe(document.documentElement, { subtree: true, childList: true }); return true; })()`;
type Watch = { t0: number; mark: number | null; done: number | null };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  const translateRequests = () => model.requests.filter(r => r.rule === "translate").length;

  const say = async (text: string, answer: string): Promise<Watch> => {
    await rp.evaluate(work, WATCH);
    await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel);
    await until(async () => (await rp.evaluate(panel, `document.body.innerText.includes(${JSON.stringify(answer)})`)) || null, 60000, `侧栏出现「${answer}」`);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || null, 30000, "侧栏回到空闲");
    // SAFETY: WATCH 写入的 window.__tr 只有这三个数字字段。
    return await rp.evaluate(work, "window.__tr") as Watch;
  };
  const since = (w: Watch, at: number | null) => at === null ? null : Math.round(at - w.t0);

  const a = await say("把这个页面翻译成中文。", "已把这页翻译成中文。");
  await rp.screenshot(work, join(out, "a-translated.png"));
  const aMark = since(a, a.mark), aDone = since(a, a.done);
  check("a 模型调用翻译之前页面不变", aMark !== null && aMark >= THINK_MS - 200, { firstPageChangeMs: aMark, modelCallsAfterMs: THINK_MS });
  check("a 调用翻译后 0.6 秒内出现第一段译文", aMark !== null && aDone !== null && aDone - aMark <= 600, { firstPageChangeMs: aMark, firstTranslationMs: aDone });
  const afterA = translateRequests();

  await say("译文还原一下", "已还原成原文。");
  const restored = await rp.evaluate(work, "document.querySelectorAll('[data-bys-translation]').length");
  check("b 还原后页面没有译文", restored === 0, { translationNodes: restored as Json });

  const b = await say("重新翻译这一页", "已重新翻译。");
  await rp.screenshot(work, join(out, "b-retranslated.png"));
  const bMark = since(b, b.mark), bDone = since(b, b.done);
  check("b 重新翻译不再请求翻译", translateRequests() === afterA, { requestsBefore: afterA, requestsAfter: translateRequests() });
  check("b 调用后 0.4 秒内出现译文", bMark !== null && bDone !== null && bDone - bMark <= 400, { firstPageChangeMs: bMark, firstTranslationMs: bDone });

  // 新载入这页再问：c 只看这一句有没有改动页面。
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => (await rp.evaluate(work, "document.readyState === 'complete' && document.querySelectorAll('p').length === 20 && !document.querySelector('[data-bys-translation]')")) || null, 15000, "练习页重新载入");
  const c = await say("翻译一下 serendipity 这个词", "意外发现美好事物的运气");
  await sleep(1500);
  const touched = await rp.evaluate(work, "document.querySelectorAll('[data-bys-translation]').length");
  check("c 模型没调用翻译，页面始终不变", c.mark === null && touched === 0, { firstPageChangeMs: since(c, c.mark), translationNodes: touched as Json });
  await rp.screenshot(work, join(out, "c-untouched.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, requests: model.requests, dependency: "real isolated extension and side panel, local page; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
