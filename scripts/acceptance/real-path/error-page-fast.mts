/**
 * 网站打不开时，新开标签页和打开网址要马上如实说「Chrome 显示了错误页」，不干等到超时（10-13 真实必应连接被断开：新开标签页等了约 14 秒才报超时）。
 *   npx tsx scripts/acceptance/real-path/error-page-fast.mts --headless
 * 本机一个一连上就断开的网站、一个没人监听的端口。脚本模型先 tabs open 断开的网站，再 navigate 到没人监听的端口。
 * 判据：两次结果各自在 4 秒内回到模型，都写着 document: error_page。
 * 失败方式：新开标签页时 Chrome 的「开始加载」通知早于监听装好，错误页又不能注入，只能等到 10 秒超时。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-error-page-fast`);

await mkdir(out, { recursive: true });

const home = createHttpServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><meta charset=\"utf-8\"><title>我的页面</title><h1>我的页面</h1>"));
await new Promise<void>(done => home.listen(0, "127.0.0.1", done));
// 一连上就断开：Chrome 显示「连接已重置」错误页。
const reset = createServer(socket => socket.resetAndDestroy());
await new Promise<void>(done => reset.listen(0, "127.0.0.1", done));
// 关掉的端口：Chrome 显示「拒绝连接」错误页。
const closed = createServer();
await new Promise<void>(done => closed.listen(0, "127.0.0.1", done));
const closedPort = (closed.address() as AddressInfo).port;
await new Promise<void>(done => closed.close(() => done()));

const resetUrl = `http://127.0.0.1:${(reset.address() as AddressInfo).port}/`;
const closedUrl = `http://127.0.0.1:${closedPort}/`;
const ASK = "错误页：先新开标签页打开一个网站，再打开另一个网址。";
const FINAL = "两个网站都打不开。";
const receipts: Array<{ name: string; text: string; ms: number }> = [];
let lastRequestAt = Date.now();
const seen = new Set<string>();

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "tabs", args: { action: "open", url: resetUrl } } },
    { tool: { name: "navigate", args: { url: closedUrl } } },
    { text: FINAL },
  ] },
], undefined, (payload: { tools?: unknown[]; messages?: Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> }> }) => {
  if (!payload.tools?.length) return;
  const now = Date.now();
  const names = new Map<string, string>();

  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) names.set(call.id, call.function.name);

  for (const m of payload.messages ?? []) {
    if (m.role !== "tool" || !m.tool_call_id || seen.has(m.tool_call_id)) continue;
    seen.add(m.tool_call_id);
    receipts.push({ name: names.get(m.tool_call_id) ?? "?", text: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 400), ms: now - lastRequestAt });
  }

  lastRequestAt = now;
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(home).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);

  const open = receipts.find(r => r.name === "tabs");
  const nav = receipts.find(r => r.name === "navigate");
  check("新开标签页：4 秒内回来，写着错误页", !!open && open.ms < 4000 && open.text.includes("document: error_page"), open ?? null);
  check("打开网址：4 秒内回来，写着错误页", !!nav && nav.ms < 4000 && nav.text.includes("document: error_page"), nav ?? null);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, receipts }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); home.closeAllConnections(); home.close(); reset.close();
}

console.log(`${checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL"} error-page-fast → ${out}`);
process.exit(checks.length && checks.every(c => c.pass) ? 0 : 1);
