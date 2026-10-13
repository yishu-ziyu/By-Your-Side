/**
 * 网页脚本里不带参数的 waitForLoad，等到页面内容出来就返回，不陪图片干等（10-13 真实必应：结果页内容出来后又等了约 6 秒才往下走）。
 *   npx tsx scripts/acceptance/real-path/wait-load-default.mts --headless
 * 本机搜索页：提交后结果页里有一张要 5 秒才返回的图片。脚本模型发一个 browser_run：回车提交，再 waitForLoad()。
 * 判据：结果页请求到达后 2.5 秒内，这个 browser_run 的结果回到模型，且结果里是结果页的标题；图片当时还没返回。
 * 失败方式：把默认改回 load，结果要等图片返回（约 5 秒）才回来。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-wait-load-default`);

await mkdir(out, { recursive: true });

const IMAGE_DELAY_MS = 5000;
let resultsAt = Infinity, imageServedAt = Infinity;

const site = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/slow.png") {
    await sleep(IMAGE_DELAY_MS);
    imageServedAt = Date.now();
    res.writeHead(200, { "content-type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    return;
  }
  if (url.pathname === "/results") resultsAt = Math.min(resultsAt, Date.now());
  const body = url.pathname === "/results"
    ? `<title>${url.searchParams.get("q")}_结果</title><h1>结果：${url.searchParams.get("q")}</h1><img src="/slow.png" alt="">`
    : `<title>搜索</title><form action="/results"><input id="q" name="q" aria-label="搜索词" value="天气" autofocus></form>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8">${body}`);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const ASK = "等待默认：提交搜索后等页面好了告诉我标题。";
const FINAL = "已提交。";
let programReceipt: { at: number; text: string } | null = null;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "browser_run", args: { label: "回车提交并等待", code: "await browser.click({target:'#q',label:'搜索框'}); await browser.pressKey({key:'Enter'}); await browser.waitForLoad({timeoutMs:10000}); return (await browser.pageInfo()).title;" } } },
    { text: FINAL },
  ] },
], undefined, (payload: { messages?: Array<{ role: string; content?: unknown; tool_call_id?: string }> }) => {
  const tool = (payload.messages ?? []).find(m => m.role === "tool");
  if (tool && !programReceipt) programReceipt = { at: Date.now(), text: (typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content)).slice(0, 600) };
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 60_000, `回答「${FINAL}」`);

  const receipt = programReceipt as { at: number; text: string } | null;
  const afterResults = receipt ? receipt.at - resultsAt : null;
  check("结果页请求到达后 2.5 秒内，脚本结果回到模型", afterResults !== null && afterResults >= 0 && afterResults < 2500, { afterResultsMs: afterResults });
  check("脚本结果里是结果页的标题", !!receipt && receipt.text.includes("天气_结果"), receipt?.text ?? null);
  check("脚本结果回来时图片还没返回（证明没陪图片等）", !!receipt && receipt.at < imageServedAt, { receiptAt: receipt?.at ?? null, imageServedAt: Number.isFinite(imageServedAt) ? imageServedAt : null });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(`${checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL"} wait-load-default → ${out}`);
process.exit(checks.length && checks.every(c => c.pass) ? 0 : 1);
