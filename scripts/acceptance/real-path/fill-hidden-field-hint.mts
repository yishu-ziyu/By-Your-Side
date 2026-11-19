import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-hidden-field-hint`);
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>站内搜索练习</title><body style="font:16px sans-serif;margin:40px">
<header style="display:flex;gap:16px;align-items:center">
  <strong>练习站</strong>
  <div id="site-search" role="search" style="display:flex;gap:12px;align-items:center">
    <a id="toggle" href="/search">搜索</a>
    <a id="help" href="/help">帮助</a>
    <div id="box" style="display:none"><form action="/search"><input id="q" name="q" placeholder="搜索本站" aria-label="搜索本站"></form></div>
  </div>
  <button id="history" type="button">搜索历史</button>
</header>
<p>正文。</p>
<script>
const hit = k => fetch("/hit?k=" + k);
document.getElementById("toggle").addEventListener("click", e => { e.preventDefault(); hit("toggle"); document.getElementById("box").style.display = "block"; });
document.getElementById("help").addEventListener("click", e => { e.preventDefault(); hit("help"); });
document.getElementById("history").addEventListener("click", () => hit("history"));
</script></body></html>`;

const hits: string[] = [];
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/hit") { hits.push(url.searchParams.get("k") ?? ""); res.writeHead(204).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "隐藏搜索框练习：在本站搜索故宫。";
const FINAL = "已经填好搜索词。";
const QUERY = "故宫";
const reveal = { target: "" };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "fill", args: { target: "#q", value: QUERY } } },
    { tool: { name: "click", args: reveal } },
    { tool: { name: "fill", args: { target: "#q", value: QUERY } } },
    { text: FINAL },
  ] },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Receipt = { name: string; args: string; text: string };
const receipts: Receipt[] = [];
const seenCalls = new Set<string>();
const refs = { toggle: "", help: "", history: "" };
let work = "";
let atRefusal: { hits: string[]; page: unknown } | null = null;

async function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length) return;
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) calls.set(call.id, call.function);
  for (const m of payload.messages ?? []) {
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const call = calls.get(id);
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    receipts.push({ name: call?.name ?? "?", args: call?.arguments ?? "", text: text.slice(0, 4000) });
    if (call?.name === "snapshot") {
      const ref = (re: RegExp) => `@${re.exec(text)?.[1] ?? "?"}`;
      refs.toggle = ref(/\[ref=(\d+)\] link "搜索"/);
      refs.help = ref(/\[ref=(\d+)\] link "帮助"/);
      refs.history = ref(/\[ref=(\d+)\] button "搜索历史"/);
    }
    if (call?.name === "fill" && !atRefusal) {
      reveal.target = /@\d+/.exec(text.replace(/^[\s\S]*?零尺寸/, ""))?.[0] ?? "";
      const seen = [...hits];
      atRefusal = { hits: seen, page: await rp.evaluate(work, 'JSON.stringify({ box: getComputedStyle(document.getElementById("box")).display, value: document.getElementById("q").value })') };
    }
  }
}

try {
  work = await rp.attach((await rp.targets()).find(x => x.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 90_000, `回答「${FINAL}」`);

  const refusal = receipts.find(r => r.name === "fill")?.text ?? "";
  const before = atRefusal as { hits: string[]; page: unknown } | null;
  check("读页给出了三个可见控件的编号", Object.values(refs).every(r => /^@\d+$/.test(r)), refs);
  check("a 第一次填写因为输入框零尺寸没有写入", /零尺寸/.test(refusal), { refusal });
  check("b 失败结果点名了能让输入框出现的可见链接「搜索」及其编号", refusal.includes(refs.toggle) && refusal.includes("搜索"), { toggle: refs.toggle, refusal });
  check("c 失败结果没有点名区域里的「帮助」和区域外的「搜索历史」", !refusal.includes(refs.help) && !refusal.includes(refs.history) && !refusal.includes("帮助") && !refusal.includes("搜索历史"), { help: refs.help, history: refs.history, refusal });
  check("d 填写失败时页面没有被自动点击或展开，输入框里没有字", !!before && before.hits.length === 0 && before.page === JSON.stringify({ box: "none", value: "" }), before as Json);
  const after = await rp.evaluate(work, 'document.getElementById("q").value');
  check("e 按线索点了「搜索」后，第二次填写写进了输入框", hits.filter(h => h === "toggle").length === 1 && after === QUERY && /Filled #q/.test(receipts.filter(r => r.name === "fill")[1]?.text ?? ""), { hits, after, clicked: reveal.target });
  await rp.screenshot(work, join(out, "page.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", checks, hits, refs, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
