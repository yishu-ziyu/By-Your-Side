/**
 * 助手在自己新开的后台标签页里输入和点击，要一次生效（2026-10-13 用户在日常 Chrome 里让助手新开百度搜天气，
 * 两个模型都是点了「百度一下」页面不动，靠目标核对发现后再补，慢且先错后改）。
 *   npx tsx scripts/acceptance/real-path/background-tab-input.mts --headed
 * 只能在有窗口的 Chrome 里跑：从没显示过的后台标签页不渲染，CDP 的鼠标和键盘输入会丢；无头 Chrome 里不会丢，复现不了。
 * 运行时屏幕上会弹出一个测试 Chrome 窗口，约 30 秒后关掉。
 * 用户停在「我的页面」。脚本模型让助手 tabs open 一个搜索页（后台打开，从没到前台），在搜索框填「天气」，点「搜索」。
 * 判据：网站收到 /results?q=天气（搜索真的提交了）；点击结果没有说「页面没有变化」。
 * 前提：点击做完之前活动标签一直是「我的页面」；新页到过前台就渲染过了，那次运行不算数。
 * 运行时别点弹出的测试窗口：10-13 前 6 次运行里有 3 次新页中途到了前台；提醒用户别点窗口、并记下扩展的切页调用（activations.json）后连跑 3 次都没再出现，多半是人点了窗口（没证实）。
 * 失败方式：去掉附加调试器时的焦点模拟，网站收不到搜索，点击结果写「Nothing on the page changed」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

if (!process.argv.includes("--headed")) {
  console.error("这个用例只在有窗口的 Chrome 里有意义，请加 --headed（会弹出一个测试窗口）。");
  process.exit(2);
}

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-background-tab-input`);

await mkdir(out, { recursive: true });

const SEARCH = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>搜索</title><body style="font:16px sans-serif;margin:40px">
<form action="/results" method="get"><input id="q" name="q" aria-label="搜索词" style="width:300px"> <button id="go">搜索</button></form></body></html>`;

const gets: string[] = [];
let searchedAt = Infinity;

const site = createServer((req, res) => {
  gets.push(req.url ?? "");
  if ((req.url ?? "").startsWith("/results")) searchedAt = Math.min(searchedAt, Date.now());
  const url = new URL(req.url ?? "/", "http://x");
  const body = url.pathname === "/mine" ? "<title>我的页面</title><h1>我的页面</h1>"
    : url.pathname === "/results" ? `<title>${url.searchParams.get("q")}_搜索结果</title><h1>结果：${url.searchParams.get("q")}</h1>`
    : SEARCH;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8">${body}`);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const ASK = "后台输入：新开一个标签页打开搜索页，搜天气。";
const FINAL = "搜索完成。";
const receipts: Array<{ name: string; text: string }> = [];
const receiptAt = new Map<string, number>();

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/search` } } },
    { tool: { name: "fill", args: { target: "#q", value: "天气" } } },
    { tool: { name: "click", args: { target: "#go", label: "搜索" } } },
    { text: FINAL },
  ] },
], undefined, (payload: { messages?: Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> }> }) => {
  const names = new Map<string, string>();
  for (const m of payload.messages ?? []) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  for (const m of payload.messages ?? []) {
    if (m.role !== "tool" || receipts.some(r => r.name === `${names.get(m.tool_call_id ?? "")}#${m.tool_call_id}`)) continue;
    receiptAt.set(names.get(m.tool_call_id ?? "") ?? "?", Date.now());
    receipts.push({ name: `${names.get(m.tool_call_id ?? "")}#${m.tool_call_id}`, text: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 600) });
  }
});

const SPY = `(() => { if (globalThis.__acts) return true; globalThis.__acts = [];
  for (const [ns, fn] of [["tabs", "update"], ["tabs", "highlight"], ["windows", "update"]]) { const orig = chrome[ns][fn].bind(chrome[ns]);
    chrome[ns][fn] = (...a) => { __acts.push({ t: Date.now(), call: ns + "." + fn, args: JSON.stringify(a).slice(0, 200), stack: (new Error().stack || "").split("\\n").slice(2, 7).join(" | ") }); return orig(...a); }; }
  chrome.tabs.onActivated.addListener((i) => __acts.push({ t: Date.now(), activated: i.tabId })); return true; })()`;
const rp = await launchRealPath({ headed: true });
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const user = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/mine` }, user);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  await rp.evaluate(sw, SPY);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, SPY);
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, user);

  const active = async () => (await rp.evaluate(sw, "chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t ? t.title : null)")) as string | null;
  const activeSamples: Array<{ at: number; title: string | null }> = [];
  let polling = true;
  const poll = (async () => { while (polling) { activeSamples.push({ at: Date.now(), title: await active() }); await sleep(100); } })();

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);
  await sleep(1500);
  polling = false;
  await poll;
  await rp.screenshot(panel, join(out, "panel.png"));
  const acts = { sw: await rp.evaluate(sw, "globalThis.__acts"), panel: await rp.evaluate(panel, "globalThis.__acts"), searchedAt, receiptAt: Object.fromEntries(receiptAt), samples: activeSamples };
  await writeFile(join(out, "activations.json"), JSON.stringify(acts, null, 2));

  const searched = gets.filter(u => u.startsWith("/results"));
  check("网站收到搜索：/results?q=天气", searched.some(u => decodeURIComponent(u).includes("q=天气")), { gets });
  const click = receipts.find(r => r.name.startsWith("click#"));
  check("点击结果没有说页面没有变化", !!click && !/Nothing on the page changed/i.test(click.text), click ?? null);
  const fill = receipts.find(r => r.name.startsWith("fill#"));
  check("填写读回是「天气」", !!fill && fill.text.includes("天气"), fill ?? null);
  // 前提：搜索提交之前（没提交就是点击结果回来之前），新页一直在后台。新页一旦到过前台就渲染过了，这次运行证明不了什么。
  const clickDoneAt = Math.min(searchedAt, receiptAt.get("click") ?? Infinity);
  const beforeClick = activeSamples.filter(s => s.at <= clickDoneAt);
  // 采样每 100 ms 一次会漏掉短暂切换；扩展后台的 onActivated 记录不会漏。
  const swActs = ((await rp.evaluate(sw, "globalThis.__acts")) ?? []) as Array<{ t: number; activated?: number }>;
  const userTabId = (await rp.evaluate(sw, `chrome.tabs.query({}).then(ts => ts.find(t => t.title === "我的页面")?.id ?? null)`)) as number | null;
  const flips = swActs.filter(a => a.activated != null && a.activated !== userTabId && a.t <= clickDoneAt);
  check("前提：搜索提交之前，活动标签一直是「我的页面」", beforeClick.length > 5 && beforeClick.every(s => s.title === "我的页面") && flips.length === 0, { samples: beforeClick.length, other: beforeClick.filter(s => s.title !== "我的页面").map(s => s.title), activated: flips as unknown as Json });
  const after = activeSamples.filter(s => s.at > clickDoneAt && s.title !== "我的页面");
  console.log(after.length ? `注意：点击之后新页到过前台 ${after.length} 次（${after[0]!.title}）` : "点击之后新页也一直在后台");
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, receipts, gets, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(`${checks.every(c => c.pass) && checks.length ? "PASS" : "FAIL"} background-tab-input → ${out}`);
process.exit(checks.length && checks.every(c => c.pass) ? 0 : 1);
