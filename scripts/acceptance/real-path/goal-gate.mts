/**
 * 交付前对清单（docs/evals/20261014-goal-gate.md）：用户说了不止一件事、助手只做完一部分就想交回答时，侧栏不出这份回答，
 * 过程行写「还在做第 N 件（共 M 件）」，助手拿到没做的那一项接着做，全做完才出回答。
 * 只装扩展、隔离构建、本机脚本模型；目标核对请求经本机转发服务换成脚本结论（带清单）。
 *   npx tsx scripts/acceptance/real-path/goal-gate.mts --headless [--record]
 * A 编号列表：一句话要三件事，做完两件就想交。
 * B 插话：做第一件时用户插话加了一件，做完第一件就想交。
 * 失败方式：侧栏出现过「只做了一部分」的那份回答；或过程行没写做到第几件；或续做时模型没拿到没做的那一项。
 * --record：把侧栏录成 mp4 放进证据目录（改前改后对比用）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const record = process.argv.includes("--record");

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-goal-gate`);

await mkdir(artifacts, { recursive: true });

const TASK_A = "帮我做三件事：1. 看看开着哪些标签页 2. 读一下这页标题 3. 数一下这页有几段";

const PARTIAL_A = "标签页和标题都看好了：开着一个标签页，标题是「三段的文章」。";

const TODO_A = "数一下这页有几段";

const FINAL_A = "三件都做完了：开着一个标签页，标题是「三段的文章」，这页有三段。";

const TASK_B = "看看开着哪些标签页";

const ADD_B = "顺便读一下这页标题";

const PARTIAL_B = "第一件做好了：开着一个标签页。";

const TODO_B = "读一下这页标题";

const FINAL_B = "开着一个标签页，这页标题是「三段的文章」。";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

const list = { name: "tabs", args: { action: "list" } };

/** 每次核对的脚本结论：第一次判没做完（清单里最后一件没做），第二次判做完。 */
const VERDICTS: Record<string, unknown> = {
  A1: { status: "continue", remaining: TODO_A, items: [{ text: "看看开着哪些标签页", done: true }, { text: "读一下这页标题", done: true }, { text: TODO_A, done: false }] },
  A2: { status: "done", items: [{ text: "看看开着哪些标签页", done: true }, { text: "读一下这页标题", done: true }, { text: TODO_A, done: true }] },
  B1: { status: "continue", remaining: TODO_B, items: [{ text: TASK_B, done: true }, { text: TODO_B, done: false }] },
  B2: { status: "done", items: [{ text: TASK_B, done: true }, { text: TODO_B, done: true }] },
};

// 规则按数组顺序匹配：续做的提示里也带着任务原话，所以 [GOAL CHECK] 的两条放在最前，用核对写进提示的「还差」区分。
const model = await startScriptedModel([
  { match: `not finished yet: ${TODO_A}`, steps: [{ tool: list }, { text: FINAL_A }] },
  { match: `not finished yet: ${TODO_B}`, steps: [{ tool: list }, { text: FINAL_B }] },
  { match: TASK_A, steps: [{ tool: list }, { tool: list }, { text: PARTIAL_A }] },
  // 第一步挂 4 秒：测试在这期间插话，插话随工具结果一起进下一次请求。
  { match: TASK_B, steps: [{ tool: list, delayMs: 4_000 }, { text: PARTIAL_B }] },
  ...["A1", "A2", "B1", "B2"].map(key => ({ match: `GATE-CHECK-${key}`, steps: [{ text: JSON.stringify(VERDICTS[key]) }] })),
]);

let checkKeys: string[] = [];

let checks = 0;

/** 主模型收到的每条 [GOAL CHECK] 提示（续做时宿主写给模型的那句）。 */
const nudges: string[] = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    const key = checkKeys[checks] ?? checkKeys.at(-1)!;
    checks += 1;
    // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
    const payload = JSON.parse(body) as { model?: string; stream?: boolean };
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: `GATE-CHECK-${key}` }] });
  } else if (req.method === "POST" && body.includes("[GOAL CHECK]")) {
    // SAFETY: OpenAI 兼容请求体；只读最后一条用户消息的正文。
    const messages = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? [];
    const last = messages.filter(m => m.role === "user").at(-1)?.content;
    const text = Array.isArray(last) ? last.map(part => (part as { text?: string }).text ?? "").join("") : String(last ?? "");

    if (text.includes("[GOAL CHECK]") && !nudges.includes(text)) nudges.push(text);
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>三段的文章</title><h1>三段的文章</h1><p>第一段。</p><p>第二段。</p><p>第三段。</p>");
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

/** 停止录屏并合成视频；没录时为 null。失败时也要录下来（改前那一版就是失败的样子）。 */
let stop: (() => Promise<string | null>) | null = null;

/** 侧栏里出现过的正式回答、过程行标题，以及出回答之前状态有没有回到空闲。 */
interface Seen { answers: string[]; titles: string[]; idleTimes: number; timeline?: string[] }

/** 写进 result.json 的证据。 */
interface Evidence { a?: Seen & { nudge?: string }; b?: Seen & { nudge?: string }; video?: string | null }

const evidence: Evidence = {};

// 记下出现过的每份正式回答（带交付编号的气泡）、过程行标题，以及状态灯从亮到灭的次数（一件事从头做到尾只灭一次）。
// 装上时已在对话里的回答（上一个情况的）不算。
const watch = () => `(() => { window.__seen = { answers: [], titles: [], idleTimes: 0, timeline: [] };
  const t0 = Date.now(); let pill = null; let lit = false;
  const old = new Set(document.querySelectorAll("#messages .msg.assistant[data-delivery-id]"));
  const seen = window.__seen;
  const note = () => {
    if (window.__seen !== seen) return;
    for (const el of document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")) { if (old.has(el)) continue; const t = el.textContent.trim(); if (t && !window.__seen.answers.includes(t)) window.__seen.answers.push(t); }
    for (const el of document.querySelectorAll("#messages .run-title")) { const t = el.textContent.trim(); if (t && !window.__seen.titles.includes(t)) window.__seen.titles.push(t); }
    const on = !!document.querySelector("#status-pill")?.classList.contains("running");
    if (window.__started && lit && !on) seen.idleTimes += 1;
    lit = on;
    const now = document.querySelector("#status-pill")?.className ?? "";
    if (now !== pill) { pill = now; seen.timeline.push(\`\${Date.now() - t0} pill=\${now} answers=\${seen.answers.length} title=\${document.querySelector("#messages .run-steps:last-of-type .run-title")?.textContent ?? ""}\`); }
  };
  new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  return true; })()`;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/article` }, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  stop = record ? await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")) : null;
  const running = () => rp.evaluate(panel, 'document.querySelector("#status-pill")?.classList.contains("running")');
  // SAFETY: watch() 装好的 window.__seen 就是 Seen 的形状。
  const seen = async () => (await rp.evaluate(panel, "window.__seen")) as Seen;
  const answered = async (text: string) => (await seen()).answers.some(t => t.includes(text)) || undefined;

  const send = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
  };

  // A：编号列表，一句话三件事。
  checkKeys = ["A1", "A2"];
  checks = 0;
  await rp.evaluate(panel, watch());
  await send(TASK_A);
  // 从状态灯亮起开始盯：发出到亮起之间本来就不亮。
  await until(async () => await running() || undefined, 10_000, "A: running", 20);
  await rp.evaluate(panel, "window.__started = true");
  await until(() => answered(FINAL_A), 60_000, "A: final answer", 50);
  await until(async () => !(await running()) || undefined, 30_000, "A: run idle");
  await sleep(500);
  await rp.screenshot(panel, join(artifacts, "a-final.png"));
  evidence.a = { ...(await seen()), nudge: nudges.find(text => text.includes(`not finished yet: ${TODO_A}`)) };
  assert.equal(checks, 2, "A: checked twice (after two things, after all three)");
  // 回答逐字显示，被收起时可能只显示了开头几个字：按开头认。
  assert.ok(!evidence.a.answers.some(t => t.startsWith(PARTIAL_A.slice(0, 3))), `A: the partial answer never showed (${JSON.stringify(evidence.a.answers)})`);
  assert.ok(evidence.a.titles.some(t => t.includes("还在做第 3 件（共 3 件）")), `A: the run said which thing it was on (${JSON.stringify(evidence.a.titles)})`);
  assert.ok(evidence.a.nudge?.includes(JSON.stringify([TODO_A])), "A: the model was told the thing still to do");
  assert.equal(evidence.a.idleTimes, 1, "A: the task stayed running until the final answer (status went idle once)");

  // B：做第一件时插话加一件。
  checkKeys = ["B1", "B2"];
  checks = 0;
  await rp.evaluate(panel, "window.__started = false");
  await rp.evaluate(panel, watch());
  await send(TASK_B);
  await until(async () => await running() || undefined, 10_000, "B: running", 20);
  await rp.evaluate(panel, "window.__started = true");
  await sleep(1_000);
  await send(ADD_B);
  await until(() => answered(FINAL_B), 60_000, "B: final answer", 50);
  await until(async () => !(await running()) || undefined, 30_000, "B: run idle");
  await sleep(500);
  await rp.screenshot(panel, join(artifacts, "b-final.png"));
  evidence.b = { ...(await seen()), nudge: nudges.find(text => text.includes(`not finished yet: ${TODO_B}`)) };
  assert.equal(checks, 2, "B: checked twice");
  assert.ok(!evidence.b.answers.some(t => t.startsWith(PARTIAL_B.slice(0, 3))), `B: the partial answer never showed (${JSON.stringify(evidence.b.answers)})`);
  assert.ok(evidence.b.titles.some(t => t.includes("还在做第 2 件（共 2 件）")), `B: the run said which thing it was on (${JSON.stringify(evidence.b.titles)})`);
  assert.ok(evidence.b.nudge?.includes(JSON.stringify([TODO_B])), "B: the model was told the thing still to do");
  assert.equal(evidence.b.idleTimes, 1, "B: the task stayed running until the final answer (status went idle once)");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (stop) evidence.video = await stop().catch(() => null);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence: { a: evidence.a && { titles: evidence.a.titles, answers: evidence.a.answers }, b: evidence.b && { titles: evidence.b.titles, answers: evidence.b.answers } }, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
