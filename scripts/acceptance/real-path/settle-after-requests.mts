/**
 * 点击和回车之后，等网站的请求回来再告诉助手页面变没变。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/settle-after-requests.mts --headless
 * 练习页：
 *   「加载更多」：GET /items 900 毫秒后才回，再插入 5 条。按钮本身不变。
 *   「刷新列表」：马上显示「加载中」，GET /items 900 毫秒后换成结果。
 *   搜索框：回车提交，GET /search 300 毫秒后列出结果。
 *   「开始同步」：发出永不返回的 GET /hang，别的什么都不做。
 *   「什么也不做」：没有请求，页面不变。
 * 判据只读回到模型的工具结果原文、服务器记录的时刻和模型服务收到请求的时刻（同一台机器的时钟）。
 *   a 「加载更多」的工具结果写页面有反应。
 *   b 模型收到「刷新列表」的工具结果，晚于服务器送出 /items 的结果。
 *   c 回车的工具结果写页面有反应。
 *   d 「开始同步」的点击在 5 秒内回到模型。
 *   e 「什么也不做」写页面没有变化，并且很快返回（不等别处没回来的请求）。
 *   f 站内搜索（GET 表单）回车后跳到新页面：工具结果写加载了新文档，不写没有变化。
 * 失败方式：去掉等请求的代码，a、b 失败；去掉回车的变化报告，c 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-settle-after-requests`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>列表页</title><body style="font:16px sans-serif;margin:40px">
<h1>列表页</h1>
<section><h2>商品</h2><button id="more" type="button">加载更多</button><ul id="items"></ul></section>
<section><h2>订单</h2><button id="refresh" type="button">刷新列表</button><p id="orders">还没有订单</p></section>
<section><h2>搜索</h2><form id="f"><input id="q" aria-label="搜索" type="search"></form><ul id="hits"></ul></section>
<section><h2>同步</h2><button id="sync" type="button">开始同步</button></section>
<section><h2>其他</h2><button id="noop" type="button">什么也不做</button></section>
<section><h2>站内搜索</h2><form action="/results" method="get"><input name="w" aria-label="站内搜索" type="search"></form></section>
<script>
const add = (ul, n, w) => { for (let i = 1; i <= n; i++) { const li = document.createElement("li"); li.textContent = w + " " + i; ul.append(li); } };
more.onclick = async () => { await fetch("/items?for=more"); add(items, 5, "商品"); };
refresh.onclick = async () => { const p = document.getElementById("orders"); p.textContent = "加载中…"; await fetch("/items?for=refresh"); p.textContent = "共有 3 张订单：A-1、A-2、A-3"; };
f.onsubmit = async (e) => { e.preventDefault(); await fetch("/search?q=" + encodeURIComponent(q.value)); add(hits, 3, "结果"); };
sync.onclick = () => { fetch("/hang").catch(() => {}); };
</script></body></html>`;

const served: Record<string, number> = {};
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/items") { setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }).end("[]"); served[`items-${url.searchParams.get("for")}`] = Date.now(); }, 900); return; }
  if (url.pathname === "/search") { served.searchStarted = Date.now(); setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("[]"), 300); return; }
  if (url.pathname === "/hang") { served.hangStarted = Date.now(); return; }
  if (url.pathname === "/results") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>搜索结果</title><h1>搜索结果</h1><p>找到 2 条</p>`); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "等请求验收：读页面，然后点加载更多、刷新列表，搜索猫并回车，再点开始同步和什么也不做，最后站内搜索狗并回车。";
const FINAL = "都试过了。";
// 编号在读页后才知道：onPayload 从读页结果里填进这些参数，模型服务在回复前才序列化它们。
const t = { more: { target: "" }, refresh: { target: "" }, q: { target: "", value: "猫" }, sync: { target: "" }, noop: { target: "" }, w: { target: "", value: "狗" } };
const NAMES = { more: 'button "加载更多"', refresh: 'button "刷新列表"', q: 'searchbox "搜索"', sync: 'button "开始同步"', noop: 'button "什么也不做"', w: 'searchbox "站内搜索"' } as const;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: t.more } },
    { tool: { name: "click", args: t.refresh } },
    { tool: { name: "fill", args: t.q } },
    { tool: { name: "press_key", args: { key: "Enter" } } },
    { tool: { name: "click", args: t.sync } },
    { tool: { name: "click", args: t.noop } },
    { tool: { name: "fill", args: t.w } },
    { tool: { name: "press_key", args: { key: "Enter" } } },
    { text: FINAL },
  ] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Receipt = { name: string; args: string; text: string; seenAt: number };
const receipts: Receipt[] = [];
const seenCalls = new Set<string>();

/** 回到模型的每个工具结果原文和模型服务第一次收到它的时刻（每次请求带着全部历史，按调用编号去重）。 */
function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length) return;
  const now = Date.now();
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) calls.set(call.id, call.function);
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const call = calls.get(id);
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    receipts.push({ name: call?.name ?? "?", args: call?.arguments ?? "", text: text.slice(0, 4000), seenAt: now });
    if (call?.name !== "snapshot") continue;
    for (const [key, line] of Object.entries(NAMES)) {
      const ref = new RegExp(`\\[ref=(\\d+)\\] ${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(text)?.[1];
      if (ref) t[key as keyof typeof t].target = `@${ref}`;
    }
  }
}

const all = (name: string) => receipts.filter(r => r.name === name);
const of = (name: string, key?: keyof typeof t) => receipts.find(r => r.name === name && (!key || r.args.includes(`"${t[key].target}"`)));
const reacted = (text = "") => /Page reacted/.test(text);

try {
  const work = await rp.attach((await rp.targets()).find(x => x.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 120_000, `回答「${FINAL}」`);

  check("读页给出了全部目标的编号", Object.values(t).every(x => x.target.startsWith("@")), t);
  const more = of("click", "more");
  check("a 「加载更多」900 毫秒后才出结果：工具结果写页面有反应", reacted(more?.text), { result: more?.text ?? null });
  const refresh = of("click", "refresh");
  check("b 模型收到「刷新列表」的工具结果，晚于网站送出结果，且写页面有反应", !!refresh && served["items-refresh"] !== undefined && refresh.seenAt >= served["items-refresh"] && reacted(refresh.text), { seenAt: refresh?.seenAt ?? null, servedAt: served["items-refresh"] ?? null, result: refresh?.text ?? null });
  const enter = of("press_key");
  check("c 搜索框按回车：工具结果写页面有反应", reacted(enter?.text), { result: enter?.text ?? null });
  const sync = of("click", "sync");
  check("d 「开始同步」请求永不返回：点击 5 秒内回到模型", !!sync && served.hangStarted !== undefined && sync.seenAt - served.hangStarted < 5000, { waitedMs: sync && served.hangStarted ? sync.seenAt - served.hangStarted : null, result: sync?.text ?? null });
  const noop = of("click", "noop");
  // 从上一个工具结果到这一个，包括脚本模型回复、光标移动和点击本身；一直等满 3 秒的实现会超过 2.5 秒。
  const noopMs = noop && sync ? noop.seenAt - sync.seenAt : null;
  check("e 「什么也不做」：工具结果写页面没有变化，并且 2.5 秒内回到模型", /Nothing on the page changed/.test(noop?.text ?? "") && noopMs !== null && noopMs < 2500, { ms: noopMs, result: noop?.text ?? null });
  const nav = all("press_key")[1];
  check("f 站内搜索回车跳到新页面：工具结果写加载了新文档，不写没有变化", /new document/.test(nav?.text ?? "") && !/Nothing on the page changed/.test(nav?.text ?? ""), { result: nav?.text ?? null });
  // #257：写明换到了哪一页（标题和路径，不带查询参数），模型不必再跑一轮确认。
  check("f 工具结果写出新页面的标题和路径，不带查询参数", /new document: "搜索结果" — http:\/\/[^ ]+\/results/.test(nav?.text ?? "") && !/\/results\?/.test(nav?.text ?? ""), { result: nav?.text ?? null });
  await rp.screenshot(work, join(out, "page.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", checks, served, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
