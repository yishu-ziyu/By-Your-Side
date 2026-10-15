/**
 * 交付前核对按当前页面判断，不按改动之前读的整页：否则勾选之后，核对仍拿勾选前的列表说「没勾上」，助手回去白查。
 * 只装扩展、隔离构建、本机脚本模型；本机转发服务截下核对请求，再改写成脚本结论。
 *   npx tsx scripts/acceptance/real-path/goal-check-stale-read.mts --headless
 * 助手先用程序读整页（未勾选、剩 2 件），再点勾选框（剩 1 件），然后交付。
 * 判据：核对收到的输入里，勾选前那份整页读数标了过时，当前页面标了当前，并且当前页面里是已勾选、剩 1 件。
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
    { text: "已把买牛奶标记为完成，还剩 1 件。" },
  ] },
  { match: "GOAL-CHECK-DONE", steps: [{ text: JSON.stringify({ status: "done" }) }] },
]);

/** 截下的核对输入（核对请求里用户消息的 JSON）。 */
const checks: Array<{ page?: { current?: boolean; text?: string } | null; observations?: Array<{ tool: string; stale?: boolean; text: string }> }> = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    // SAFETY: OpenAI 兼容请求体；核对的输入是最后一条用户消息里的 JSON。
    const payload = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
    const user = payload.messages.filter(m => m.role === "user").at(-1)?.content;
    const text = Array.isArray(user) ? user.map(part => (part as { text?: string }).text ?? "").join("") : String(user);
    checks.push(JSON.parse(text));
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: "GOAL-CHECK-DONE" }] });
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

  const input = checks[0]!;
  const reads = (input.observations ?? []).map(item => ({ tool: item.tool, stale: item.stale ?? false, beforeClick: item.text.includes("2 items left") }));
  evidence = { page: { current: input.page?.current ?? null, oneLeft: input.page?.text?.includes("1 item left") ?? false }, reads };
  const before = reads.filter(read => read.tool === "browser_run" && read.beforeClick);
  assert.ok(before.length >= 1, `the check saw the pre-click whole-page read (${JSON.stringify(reads)})`);
  assert.ok(before.every(read => read.stale), `the pre-click whole-page read is marked stale (${JSON.stringify(reads)})`);
  assert.equal(input.page?.current, true, "the current page is labeled current");
  assert.ok(input.page?.text?.includes("1 item left"), "the current page shows the state after the click");
  assert.ok(!reads.some(read => read.tool === "click" && read.stale), "the action result itself is not marked stale");
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
