/**
 * 交付前核对按当前页面判断，不按改动之前读的整页：否则勾选之后，核对仍拿勾选前的列表说「没勾上」，助手回去白查。
 * 只装扩展、隔离构建、本机脚本模型；本机转发服务截下核对请求，再改写成脚本结论。
 *   npx tsx scripts/acceptance/real-path/goal-check-stale-read.mts --headless
 * 助手先用程序读整页（未勾选、剩 2 件），再点勾选框（剩 1 件），再读一次整页，再列一次标签页（不改页面），然后交付。
 * 判据：核对收到的输入里，只有勾选前那份整页读数标了过时；勾选后那份不标，后面列标签页也不让它变过时；
 * 当前页面标了当前、显示剩 1 件；核对的说明里写了以当前页面为准。
 * 只证明程序这一层：核对模型是脚本，不代表真模型会不会照着判。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-goal-check-stale-read`);

await mkdir(artifacts, { recursive: true });

const TASK = "把买牛奶标记为已完成";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

const model = await startScriptedModel([
  { match: TASK, steps: [
    { tool: { name: "browser_run", args: { label: "读待办列表", code: "const s = await browser.snapshot(); return s.text;" } } },
    { tool: { name: "click", args: { target: "#milk", label: "勾选买牛奶" } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "tabs", args: { action: "list" } } },
    { text: "已把买牛奶标记为完成，还剩 1 件。" },
  ] },
  { match: "GOAL-CHECK-DONE", steps: [{ text: JSON.stringify({ status: "done" }) }] },
]);

/** 核对收到的一份读数。 */
interface Observation { tool: string; stale: boolean; text: string }

/** 截下的一次核对请求：系统说明，和最后一条用户消息里的 JSON 输入。 */
interface CheckRequest { system: string; page: { current: boolean; text: string } | null; observations: Observation[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 消息内容是字符串或分段数组；只取文字段。 */
const messageText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => isRecord(part) && typeof part.text === "string" ? part.text : "").join("") : "";

/** 把转发服务收到的请求体解析成核对请求；形状不对就返回 null，由判据报失败。 */
function checkRequest(body: string): CheckRequest | null {
  let payload: unknown;
  let input: unknown;

  try {
    payload = JSON.parse(body);

    if (!isRecord(payload) || !Array.isArray(payload.messages)) return null;
    input = JSON.parse(messageText(payload.messages.filter(m => isRecord(m) && m.role === "user").at(-1)?.content));
  } catch {
    return null;
  }

  if (!isRecord(input) || !Array.isArray(input.observations)) return null;
  const system = payload.messages.filter(m => isRecord(m) && (m.role === "system" || m.role === "developer")).map(m => messageText(m.content)).join("\n");
  const page = isRecord(input.page) ? { current: input.page.current === true, text: typeof input.page.text === "string" ? input.page.text : "" } : null;
  const observations = input.observations.flatMap(item => isRecord(item) && typeof item.tool === "string" && typeof item.text === "string" ? [{ tool: item.tool, stale: item.stale === true, text: item.text }] : []);

  return { system, page, observations };
}

const checks: Array<CheckRequest | null> = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    checks.push(checkRequest(body));
    const original: unknown = JSON.parse(body);
    forward = JSON.stringify({ ...(isRecord(original) ? original : {}), messages: [{ role: "user", content: "GOAL-CHECK-DONE" }] });
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>待办</title><h1>todos</h1>
<ul><li><input type="checkbox" id="milk" aria-label="买牛奶"><label for="milk">买牛奶</label></li><li><input type="checkbox" id="bill" aria-label="交电费"><label for="bill">交电费</label></li></ul>
<p id="left">2 items left!</p>
<script>document.addEventListener("change", () => { const n = document.querySelectorAll("input:not(:checked)").length; document.getElementById("left").textContent = n + (n === 1 ? " item left!" : " items left!"); });</script>`);
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的证据：每份读数的工具名、标记和关键状态，不存整页文字。 */
let evidence: unknown = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/todos` }, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => checks.length >= 1 || undefined, 60_000, "goal check ran");
  await rp.screenshot(panel, join(artifacts, "panel.png"));

  const input = checks[0];
  assert.ok(input, "the goal check request has the expected shape");
  const reads = input.observations.map(item => ({ tool: item.tool, stale: item.stale, beforeClick: item.text.includes("2 items left"), afterClick: item.text.includes("1 item left") }));
  const instruction = ["Judge the current state of the page", "Where page and a stale read differ, page is right", "a stale read remains valid evidence for such content", "stale: true marks a whole-page read"].every(text => input.system.includes(text));
  evidence = { page: { current: input.page?.current ?? null, oneLeft: input.page?.text.includes("1 item left") ?? false }, reads, instruction };
  const before = reads.filter(read => read.tool === "browser_run" && read.beforeClick);
  assert.ok(before.length >= 1, `the check saw the pre-click whole-page read (${JSON.stringify(reads)})`);
  assert.ok(before.every(read => read.stale), `the pre-click whole-page read is marked stale (${JSON.stringify(reads)})`);
  const after = reads.filter(read => read.tool === "snapshot" && read.afterClick);
  assert.equal(after.length, 1, `the check saw the post-click whole-page read (${JSON.stringify(reads)})`);
  assert.equal(after[0]!.stale, false, `the post-click whole-page read, followed only by a tab listing, is not stale (${JSON.stringify(reads)})`);
  assert.ok(reads.some(read => read.tool === "tabs"), `the tab listing reached the check (${JSON.stringify(reads)})`);
  assert.ok(!reads.some(read => (read.tool === "click" || read.tool === "tabs") && read.stale), "action and tab results are not marked stale");
  assert.equal(input.page?.current, true, "the current page is labeled current");
  assert.ok(input.page?.text.includes("1 item left"), "the current page shows the state after the click");
  assert.ok(instruction, "the check's instructions say the current page decides and explain stale reads");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
