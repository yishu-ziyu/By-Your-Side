/**
 * 做完一轮后侧栏只留一个结论（#334）：一步没做成、换法做成，模型说做完了，目标核对判做完。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；目标核对的结论由本机转发服务换成脚本结论。
 *   npx tsx scripts/acceptance/real-path/finished-turn.mts --headless
 * 路径：模型先说一句开场话并点一个不存在的按钮（没做成）→ 填草稿（有读回）→ 点「显示答案」→ 回答「已写好草稿…」。
 *   A) 核对扣 2.5 秒后判做完：回答里没有「还有没做完」「没全部完成」；没有「继续原任务」；开场话和读回在过程块里；
 *      过程行核对期间写「核对中…」，之后写「已核对页面」；过程里不再重复回答原文。
 *   B) 同样的路径，核对判没做到（blocked）：出现「继续原任务」，过程行写「没做成」。
 * 判据只看侧栏里用户看得到的内容。
 * 失败方式：去掉「核对判做完后不出卡」，A 的「继续原任务」仍在（反例结果写在 PR 描述里）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-finished-turn`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>草稿与答案</title></head><body><main>
<h2>草稿</h2><textarea id="draft" rows="3" cols="50" aria-label="草稿"></textarea>
<p><button id="reveal" onclick="document.getElementById('answer').hidden=false">显示答案</button></p><p id="answer" hidden>答案是 42。</p></main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

const CASES = {
  a: { ask: "案例甲：在草稿框里写 hello，再点「显示答案」。", opening: "我先填草稿，再点显示答案，不碰别的。甲", final: "已写好草稿并显示了答案。【甲完成】" },
  b: { ask: "案例乙：在草稿框里写 hello，再点「显示答案」。", opening: "我先填草稿，再点显示答案，不碰别的。乙", final: "已写好草稿并显示了答案。【乙完成】" },
};

/** 一步没做成（目标不存在）→ 填写（有读回）→ 点按钮成功 → 说做完了。 */
const steps = (c: { opening: string; final: string }): Step[] => [
  { text: c.opening, thenTool: { name: "click", args: { target: "#reveal-old" } } },
  { tool: { name: "fill", args: { target: "#draft", value: "hello" } } },
  { tool: { name: "click", args: { target: "#reveal" } } },
  { text: c.final },
];

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

const model = await startScriptedModel([
  { match: CASES.a.ask, steps: steps(CASES.a) },
  { match: CASES.b.ask, steps: steps(CASES.b) },
  { match: "VERDICT-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: "VERDICT-BLOCKED", steps: [{ text: JSON.stringify({ status: "blocked", cause: "unresponsive", remaining: "点显示答案" }) }] },
]);

/** 下一次目标核对扣多久、怎么判。 */
let verdict = { holdMs: 0, probe: "VERDICT-DONE" };

const checks: Array<{ probe: string; releasedAt: number }> = [];

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    const next = verdict;
    await sleep(next.holdMs);
    // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
    const payload = JSON.parse(body) as Record<string, unknown>;
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: next.probe }] });
    checks.push({ probe: next.probe, releasedAt: Date.now() });
  }

  try {
    const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502).end();
  }
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

/** 某条用户消息这一轮里用户看得到的东西。 */
const TURN_JS = (ask: string, final: string) => `(() => {
  const vis = el => !!el && el.getClientRects().length > 0;
  const user = [...document.querySelectorAll("#messages .msg.user")].find(u => u.textContent.includes(${JSON.stringify(ask)}));
  const turn = [];
  for (let n = user?.nextElementSibling; n && !n.matches(".msg.user"); n = n.nextElementSibling) turn.push(n);
  const run = turn.find(n => n.matches("details.run-steps"));
  const answer = turn.find(n => n.matches(".msg.assistant[data-delivery-id]") && n.dataset.deliveryKind !== "ack" && n.textContent.includes(${JSON.stringify(final)}));
  return {
    answer: answer ? answer.innerText.trim() : null,
    summary: run ? run.querySelector("summary")?.innerText.replace(/\\s+/g, " ").trim() ?? "" : null,
    openingInProcess: !!run?.querySelector(".run-body .opening-line"),
    openingOutsideVisible: turn.some(n => n.matches(".opening-line") && vis(n)),
    evidenceInProcess: !!run?.querySelector(".fill-evidence"),
    evidenceOutside: turn.some(n => n.matches(".fill-evidence")),
    answerRepeatedInProcess: !!run && run.querySelector(".run-body").textContent.includes(${JSON.stringify(final)}),
    failedChip: !!run?.querySelector(".chip.error"),
    resumeVisible: [...document.querySelectorAll("button")].some(b => b.textContent.includes("继续原任务") && vis(b)),
    panelText: document.querySelector("#messages")?.innerText ?? "",
  };
})()`;

type Turn = { answer: string | null; summary: string | null; openingInProcess: boolean; openingOutsideVisible: boolean; evidenceInProcess: boolean; evidenceOutside: boolean; answerRepeatedInProcess: boolean; failedChip: boolean; resumeVisible: boolean; panelText: string };

const rp = await launchRealPath();
let error: string | null = null;
const evidence: Record<string, unknown> = {};
let panelForDump: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  panelForDump = panel;

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "previous turn settled", 100);

  /** 发出一条，等回答出现、核对结论放出后再等 1.5 秒；记下回答出现到核对结论之间过程行写什么。 */
  async function runCase(key: keyof typeof CASES, next: typeof verdict) {
    const c = CASES[key];
    await settled();
    await rp.cdp.send("Page.navigate", { url: origin }, work);
    await sleep(500);
    verdict = next;
    const before = checks.length;
    await rp.click(panel, "#input");
    await rp.typeText(panel, c.ask);
    await rp.pressEnter(panel);
    const read = async () => await rp.evaluate(panel, TURN_JS(c.ask, c.final)) as Turn;
    const whileChecking = await until(async () => { const t = await read(); return t.answer && (t.summary?.includes("核对中…") || checks.length > before) ? t : undefined; }, 60_000, `${key}: answer shown before the verdict`, 100);
    await rp.screenshot(panel, join(artifacts, `${key}-checking.png`));
    await until(async () => checks.length > before || undefined, 30_000, `${key}: goal check released`, 100);
    await sleep(1_500);
    const end = await read();
    await rp.evaluate(panel, `(() => { const u = [...document.querySelectorAll("#messages .msg.user")].find(u => u.textContent.includes(${JSON.stringify(c.ask)})); let n = u; while (n && !n.matches?.("details.run-steps")) n = n.nextElementSibling; if (n) n.open = true; return true; })()`);
    await sleep(300);
    await rp.screenshot(panel, join(artifacts, `${key}-final-expanded.png`));
    await rp.evaluate(panel, `(() => { document.querySelectorAll("#messages details.run-steps").forEach(d => d.open = false); return true; })()`);
    await rp.screenshot(panel, join(artifacts, `${key}-final.png`));

    return { whileChecking: { ...whileChecking, panelText: undefined }, end: { ...end, panelText: end.panelText.slice(-600) } };
  }

  // A) 核对判做完。
  const a = await runCase("a", { holdMs: 2_500, probe: "VERDICT-DONE" });
  evidence.a = a;
  assert.ok(a.end.failedChip, `a: precondition — the process has a failed step: ${JSON.stringify(a.end)}`);
  assert.ok(a.end.answer && !/还有没做完|没全部完成|没算作完成|没在页面上核对/.test(a.end.answer), `a: the answer has no host note: ${JSON.stringify(a.end.answer)}`);
  assert.ok(!a.end.resumeVisible, "a: no 继续原任务 after the goal check says done");
  assert.ok(a.end.openingInProcess && !a.end.openingOutsideVisible, `a: the opening line is inside the process block: ${JSON.stringify(a.end)}`);
  assert.ok(a.end.evidenceInProcess && !a.end.evidenceOutside, `a: the readback is inside the process block: ${JSON.stringify(a.end)}`);
  assert.ok(!a.end.answerRepeatedInProcess, "a: the process does not repeat the answer");
  assert.match(a.whileChecking.summary ?? "", /核对中…/, `a: summary while checking: ${JSON.stringify(a.whileChecking.summary)}`);
  assert.match(a.end.summary ?? "", /做了 \d+ 步 · \d[^·]*秒 · 已核对页面/, `a: summary after the verdict: ${JSON.stringify(a.end.summary)}`);
  assert.ok(!(a.end.summary ?? "").includes("换了做法"), `a: the collapsed summary no longer says 换了做法: ${JSON.stringify(a.end.summary)}`);

  // B) 核对判没做到。
  const b = await runCase("b", { holdMs: 0, probe: "VERDICT-BLOCKED" });
  evidence.b = b;
  assert.ok(b.end.resumeVisible, `b: 继续原任务 shows when the goal check says not done: ${JSON.stringify(b.end)}`);
  assert.match(b.end.summary ?? "", /没做成/, `b: summary says a step did not work: ${JSON.stringify(b.end.summary)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (panelForDump) await writeFile(join(artifacts, "messages.html"), String(await rp.evaluate(panelForDump, 'document.querySelector("#messages")?.outerHTML ?? ""').catch(() => ""))).catch(() => {});
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local proxy scripts goal-check verdicts; local practice page", evidence, checks, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
