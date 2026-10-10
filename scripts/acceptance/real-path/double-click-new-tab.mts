/**
 * 助手双击打开新标签页后，下一步不带 tabId 的读页读的是新页，不是原页。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/double-click-new-tab.mts --headless
 * 练习页 A 上有两个元素：单击「单击打开 C」会用 window.open 开 C 页；双击「双击打开 B」会用 window.open 开 B 页。
 * 每页有一段只属于自己的标记文字。模型调 snapshot 时不带 tabId，和真实模型平常一样。
 *   对照段：助手单击「单击打开 C」，再 snapshot。判据：点击结果写明新页已是工作页；回到模型的读页结果里有 C 页的标记文字。
 *   主段：助手切回 A 页、读一次（确认读的是 A），双击「双击打开 B」，再 snapshot。
 *         判据：双击结果写明新页已是工作页；回到模型的读页结果里有 B 页的标记文字，没有 A 页的。
 * 判据只读回到模型的工具结果原文和扩展后台的 chrome.tabs.query。
 * 失败方式：Agent 一侧的缺省页只在单击跟到新页时更换、双击时不换，主段的读页仍读 A 页，主段失败、对照段通过。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-double-click-new-tab`);

await mkdir(out, { recursive: true });

// 标记用普通文字：读页会把像口令的字串遮成 [redacted]；也不用页标题，因为页面上的助手状态条会提到新页的标题。
const MARK = { a: "苹果园今天开门", b: "香蕉园今天开门", c: "樱桃园今天开门" };

const PAGE_A = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>原页 A</title><body style="font:16px sans-serif;margin:40px">
<h1>原页 A</h1><p>${MARK.a}</p>
<p><button id="once" type="button" onclick="window.open('/c')">单击打开 C</button></p>
<p><span id="twice" role="button" tabindex="0" style="display:inline-block;padding:8px 16px;border:1px solid #888;user-select:none" ondblclick="window.open('/b')">双击打开 B</span></p>
</body></html>`;

const page = (title: string, mark: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${mark}</p>`;

const site = createServer((req, res) => {
  const html = req.url === "/b" ? page("新页 B", MARK.b) : req.url === "/c" ? page("新页 C", MARK.c) : PAGE_A;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = { control: "双击新页对照：单击打开 C，然后读页面。", main: "双击新页主段：回 A 页，双击打开 B，然后读页面。" };
const FINAL = { control: "对照完成。", main: "主段完成。" };
const switchBack = { tool: { name: "tabs", args: { action: "switch", tabId: 0 } } };

const model = await startScriptedModel([
  // 目标核对的请求带着用户原话：先认它，直接判完成。
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK.control, steps: [
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: { target: "#once", label: "单击打开 C" } } },
    { tool: { name: "snapshot", args: {} } },
    { text: FINAL.control },
  ] },
  { match: ASK.main, steps: [
    switchBack,
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "double_click", args: { target: "#twice", label: "双击打开 B" } } },
    { tool: { name: "snapshot", args: {} } },
    { text: FINAL.main },
  ] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Receipt = { part: string; name: string; args: string; text: string };
const receipts: Receipt[] = [];
const seenCalls = new Set<string>();
let part = "setup";

/** 回到模型的每个工具结果原文（每次请求带着全部历史，按调用编号去重）。 */
function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length) return;
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) calls.set(call.id, call.function);
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const call = calls.get(id);
    receipts.push({ part, name: call?.name ?? "?", args: call?.arguments ?? "", text: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 4000) });
  }
}

const has = (text: string | undefined, mark: string) => (text ?? "").includes(mark);
/** 读页结果开头写着它读的是哪个标签页。 */
const tabOf = (text: string | undefined) => Number(/<page-content untrusted tab=(\d+)/.exec(text ?? "")?.[1] ?? NaN);

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  const tabsNow = async () => (await rp.evaluate(sw, "chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url, active: t.active })))")) as Array<{ id: number; url: string; active: boolean }>;
  const pageA = (await tabsNow()).find(t => t.url === `${origin}/`)!.id;
  switchBack.tool.args.tabId = pageA;

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 90_000, `回答「${text}」`);

  // ── 对照段：单击开新页 C，再不带 tabId 读页 ──
  part = "control";
  await ask(ASK.control);
  await answered(FINAL.control);
  const pageC = (await tabsNow()).find(t => t.url === `${origin}/c`)?.id ?? null;
  const cClick = receipts.find(r => r.part === "control" && r.name === "click")?.text;
  const cSnaps = receipts.filter(r => r.part === "control" && r.name === "snapshot");
  check("对照 单击结果写明新开的 C 页已是工作页", pageC !== null && has(cClick, `A new tab opened (tab ${pageC}`) && has(cClick, "now your working tab"), { pageC, clickReceipt: cClick ?? null });
  check("对照 单击后不带 tabId 的读页读到 C 页", cSnaps.length === 2 && cSnaps.every(r => !/"tabId"/.test(r.args)) && has(cSnaps[1]?.text, MARK.c) && !has(cSnaps[1]?.text, MARK.a) && tabOf(cSnaps[1]?.text) === pageC, { pageA, pageC, snapshots: cSnaps.map(r => ({ args: r.args, tab: tabOf(r.text), hasA: has(r.text, MARK.a), hasC: has(r.text, MARK.c), head: r.text.slice(0, 300) })) });
  await rp.screenshot(panel, join(out, "control-panel.png"));

  // ── 主段：切回 A，双击开新页 B，再不带 tabId 读页 ──
  part = "main";
  await rp.cdp.send("Page.bringToFront", {}, work);
  await ask(ASK.main);
  await answered(FINAL.main);
  const pageB = (await tabsNow()).find(t => t.url === `${origin}/b`)?.id ?? null;
  const bClick = receipts.find(r => r.part === "main" && r.name === "double_click")?.text;
  const bSnaps = receipts.filter(r => r.part === "main" && r.name === "snapshot");
  check("主段 切回 A 后不带 tabId 的读页读到 A 页（双击前的起点）", has(bSnaps[0]?.text, MARK.a), { head: bSnaps[0]?.text.slice(0, 300) ?? null });
  check("主段 双击结果写明新开的 B 页已是工作页", pageB !== null && has(bClick, `A new tab opened (tab ${pageB}`) && has(bClick, "now your working tab"), { pageB, doubleClickReceipt: bClick ?? null });
  check("主段 双击后不带 tabId 的读页读到 B 页，不是 A 页", bSnaps.length === 2 && bSnaps.every(r => !/"tabId"/.test(r.args)) && has(bSnaps[1]?.text, MARK.b) && !has(bSnaps[1]?.text, MARK.a) && tabOf(bSnaps[1]?.text) === pageB, { pageA, pageB, snapshots: bSnaps.map(r => ({ args: r.args, tab: tabOf(r.text), hasA: has(r.text, MARK.a), hasB: has(r.text, MARK.b), head: r.text.slice(0, 300) })) });
  await rp.screenshot(panel, join(out, "main-panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", checks, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
