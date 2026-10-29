/**
 * 两个会话在回答之后自己接着做、占满执行名额时，用户另开会话发的新任务照常开始。
 * 只装扩展、隔离构建、本机脚本模型；目标核对请求经本机转发服务改写成脚本结论。
 *   npx tsx scripts/acceptance/real-path/slot-yields-to-new-task.mts --headless
 * A、B 各发一条任务，核对都判「没做完」，续做挂在一次 60 秒的模型请求上。
 * C 在新会话里发任务：侧栏要出现 C 的回答，不出现「执行名额已满」；A、B 的续做只停一个（让出一个名额就够）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { recheckProbe, reverifyContinue, startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-slot-yields-to-new-task`);

await mkdir(artifacts, { recursive: true });

const TASKS = { a: "列出这一页的要点", b: "总结这一页的结论", c: "这一页的标题是什么" };

const ANSWER_C = "标题是「三条要点的文章」。";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

// 规则按数组顺序匹配：续做的提示里也带着任务原话，所以 [GOAL CHECK] 放在最前。
const model = await startScriptedModel([
  { match: "[GOAL CHECK]", steps: [{ tool: { name: "tabs", args: { action: "list" } }, delayMs: 60_000 }, { text: "补上了。" }] },
  { match: TASKS.a, steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: "要点：背景、方法。" }] },
  { match: TASKS.b, steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: "结论是：可行。" }] },
  { match: TASKS.c, steps: [{ text: ANSWER_C }] },
  { match: "GOAL-CHECK-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", remaining: "补完剩下的部分" }) }] },
]);

// 目标核对：A、B 判没做完。C 不调工具，不做核对。
const proxy = createServer(async (req, res) => {
  let body = "";

  req.setEncoding('utf8'); for await (const chunk of req) body += chunk;
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
    const payload = JSON.parse(body) as { model?: string; stream?: boolean };
    // 复核照首轮结论（继续）再判一次，带上复核读数里的原文。
    const again = reverifyContinue(body);
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: again ? recheckProbe("GOAL-CHECK-CONTINUE", again) : "GOAL-CHECK-CONTINUE" }] });
  }

  // 产品取消请求（停掉续做）时，把取消传给脚本模型，它才记得下「没写完就关了」。
  const cancel = new AbortController();
  res.on("close", () => { if (!res.writableFinished) cancel.abort(); });

  try {
    const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined, signal: cancel.signal });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
  }
});

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>三条要点的文章</title><h1>三条要点的文章</h1><p>背景。方法。结论。</p>");
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的证据。 */
const evidence: { continuationsStarted?: number; continuationsCancelled?: number; notices?: string[]; answers?: string[] } = {};

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
  const continuations = () => model.requests.filter(r => r.rule === "[GOAL CHECK]" && r.step === 0);

  const send = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
  };

  const newConversation = async (name: string) => {
    await rp.click(panel, "#conversation-new");
    await until(async () => (await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && !document.querySelector(".msg.user")')) || undefined, 20_000, `${name}：新会话`);
  };

  await send(TASKS.a);
  await until(async () => continuations().length >= 1 || undefined, 60_000, "A：回答后开始续做");
  await newConversation("B");
  await send(TASKS.b);
  await until(async () => continuations().length >= 2 || undefined, 60_000, "B：回答后开始续做");
  await rp.screenshot(panel, join(artifacts, "b-continuing.png"));

  await newConversation("C");
  await send(TASKS.c);
  const panelText = 'JSON.stringify({ answers: [...document.querySelectorAll("#messages .msg.assistant")].map(el => el.innerText.trim()), notices: [...document.querySelectorAll("#messages .msg.notice")].map(el => el.innerText.trim()) })';
  // SAFETY: panelText 只返回两个字符串数组。
  const read = async () => JSON.parse(String(await rp.evaluate(panel, panelText))) as { answers: string[]; notices: string[] };
  await until(async () => { const s = await read(); return s.answers.some(t => t.includes(ANSWER_C)) || s.notices.length > 0 || undefined; }, 30_000, "C：有回答或提示");
  await sleep(1_000);
  await rp.screenshot(panel, join(artifacts, "c-result.png"));
  const c = await read();
  Object.assign(evidence, c, { continuationsStarted: continuations().length, continuationsCancelled: continuations().filter(r => r.closedAt && !r.finished).length });
  assert.ok(!c.notices.some(t => t.includes("执行名额已满")), `C：不出现名额已满（${JSON.stringify(c.notices)}）`);
  assert.ok(c.answers.some(t => t.includes(ANSWER_C)), `C：侧栏出现回答（${JSON.stringify(c.answers)}）`);
  assert.equal(evidence.continuationsCancelled, 1, "只停一个续做，正好让出一个名额");
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
