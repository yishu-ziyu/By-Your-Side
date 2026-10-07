/**
 * 回答之后的续做只在原网页上，并且看得见（docs/evals/20261007-goal-continue-same-page.md R1、R3、R4、反例）。
 * 只装扩展、隔离构建、本机脚本模型；目标核对请求经本机转发服务改写成脚本结论。
 *   npx tsx scripts/acceptance/real-path/goal-continue-same-page.mts --headless
 * A 同一页确实漏做：核对判「没做完」→ 侧栏新一轮标题写「还没做完，接着做」，下面一行写还差的事；做完后这一行不留。
 * B 核对期间用户把标签页换到别的网页：助手不再动（模型收不到 [GOAL CHECK]），侧栏不再出现执行中。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-goal-continue-same-page`);

await mkdir(artifacts, { recursive: true });

const TASK_A = "把这一页的三条要点列出来";

const TASK_B = "把这一页的结论翻成中文";

const REMAINING = "列出第三条要点";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

// 规则按数组顺序匹配：续做的提示里也带着任务原话，所以 [GOAL CHECK] 放在最前。
const model = await startScriptedModel([
  { match: "[GOAL CHECK]", steps: [{ tool: { name: "tabs", args: { action: "list" } }, delayMs: 2_000 }, { text: "补上了第三条：结论。" }] },
  { match: TASK_A, steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: "列了前两条：背景、方法。" }] },
  { match: TASK_B, steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: "结论译了一半。" }] },
  { match: "GOAL-CHECK-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", remaining: REMAINING }) }] },
  { match: "GOAL-CHECK-DONE", steps: [{ text: JSON.stringify({ status: "done" }) }] },
]);

/** 目标核对：每次收到时调用 onCheck（第几次），按返回值作答。 */
let onCheck: (n: number) => Promise<"continue" | "done"> = async () => "done";

let checks = 0;

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    checks += 1;
    const verdict = await onCheck(checks);
    // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
    const payload = JSON.parse(body) as { model?: string; stream?: boolean };
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: verdict === "continue" ? "GOAL-CHECK-CONTINUE" : "GOAL-CHECK-DONE" }] });
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

const site = createServer((req, res) => {
  const title = req.url === "/next" ? "下一个网页" : "三条要点的文章";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>背景。方法。结论。</p>`);
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const rp = await launchRealPath();

let error: string | null = null;

/** 侧栏里出现过的过程行标题与「还差」行。 */
interface Seen { titles: string[]; asides: string[] }

/** 写进 result.json 的证据。 */
interface Evidence { a?: Seen & { asideAfterEnd: boolean; continuations: number }; b?: { continuations: number; runningAfterMove: boolean; titles: string[] } }

const evidence: Evidence = {};

// 侧栏里出现过的过程行标题与「还差」行，用 MutationObserver 记下（续做的标题只在第一步之前出现）。
const WATCH = `(() => { window.__seen = { titles: [], asides: [] };
  new MutationObserver(() => {
    for (const el of document.querySelectorAll("#messages .run-title")) { const t = el.textContent.trim(); if (t && !window.__seen.titles.includes(t)) window.__seen.titles.push(t); }
    for (const el of document.querySelectorAll("#messages .trail-aside")) { const t = el.textContent.trim(); if (t && !window.__seen.asides.includes(t)) window.__seen.asides.push(t); }
  }).observe(document.getElementById("messages"), { subtree: true, childList: true, characterData: true }); return true; })()`;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/article` }, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.evaluate(panel, WATCH);
  const running = () => rp.evaluate(panel, 'document.querySelector("#status-pill")?.classList.contains("running")');
  const continuations = () => model.requests.filter(r => r.rule === "[GOAL CHECK]" && r.step === 0).length;
  // SAFETY: WATCH 装好的 window.__seen 只有这两个字符串数组。
  const seen = async () => (await rp.evaluate(panel, "window.__seen")) as Seen;

  // A：同一页，第一次核对判没做完，第二次判做完。
  onCheck = async n => (n === 1 ? "continue" : "done");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK_A);
  await rp.pressEnter(panel);
  await until(async () => (await seen()).asides.some(t => t.includes(REMAINING)) || undefined, 60_000, "A: continuation explained in the panel", 50);
  await rp.screenshot(panel, join(artifacts, "a-continuing.png"));
  await until(async () => checks >= 2 && !(await running()) || undefined, 60_000, "A: continuation finished");
  await sleep(1_000);
  await rp.screenshot(panel, join(artifacts, "a-finished.png"));
  const a = await seen();
  evidence.a = { titles: a.titles, asides: a.asides, asideAfterEnd: Boolean(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .trail-aside")].some(el => el.getClientRects().length > 0)`)), continuations: continuations() };
  assert.ok(a.titles.some(t => t.includes("还没做完，接着做")), `A: run title said why it continued (${JSON.stringify(a.titles)})`);
  assert.equal(evidence.a.continuations, 1, "A: continued once on the same page");
  assert.equal(evidence.a.asideAfterEnd, false, "A: the still-to-do line is gone after the run ends");

  // B：新任务；核对进行中把标签页换到别的网页，核对仍判没做完。
  await rp.evaluate(panel, WATCH);
  onCheck = async () => {
    await rp.cdp.send("Page.navigate", { url: `${origin}/next` }, work);
    await sleep(1_500);

    return "continue";
  };

  const before = continuations();
  checks = 0;
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK_B);
  await rp.pressEnter(panel);
  await until(async () => checks >= 1 || undefined, 60_000, "B: goal check ran");
  // 续做若发生，会在核对放行后几百毫秒内开始；等 6 秒。
  let runningAfterMove = false;

  for (let i = 0; i < 24; i++) {
    await sleep(250);

    if (await running()) runningAfterMove = true;
  }

  await rp.screenshot(panel, join(artifacts, "b-moved.png"));
  evidence.b = { continuations: continuations() - before, runningAfterMove, titles: (await seen()).titles };
  assert.equal(evidence.b.continuations, 0, "B: no continuation after the tab moved to another site");
  assert.equal(runningAfterMove, false, "B: the panel did not start running again");
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
