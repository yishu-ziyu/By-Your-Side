/**
 * 回答不等目标核对（docs/evals/20261004-cut-unused.md R3）：主模型写完回答，侧栏马上显示、任务回到空闲；
 * 目标核对（快速模型的旁路判断）随后才出结论。只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/answer-before-goal-check.mts --headless
 * 做法：模型地址指向一个本机转发服务；目标核对请求（系统提示词以核对说明开头）在这里扣住 5 秒再放行。
 * 失败方式：正式回答要等核对结束才交付（≥ 5 秒）；或回答出来了但侧栏仍在「执行中」直到核对结束。
 * 反例已实测：同一脚本在改动前的代码上失败（回答与空闲都在核对放行之后，见验收文件）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-before-goal-check`);

await mkdir(artifacts, { recursive: true });

const MARK = "看看开了哪些标签页";

const ANSWER = "现在开着两个标签页。";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

const HOLD_MS = 5_000;

const model = await startScriptedModel([
  { match: MARK, steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: ANSWER }] },
  { match: "GOAL-CHECK-PROBE", steps: [{ text: JSON.stringify({ status: "done" }) }] },
]);

const held: Array<{ receivedAt: number; releasedAt: number }> = [];

// 转发服务：目标核对请求扣住 HOLD_MS，换成脚本模型认得的一句再转发；其余原样转发。
const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    const receivedAt = Date.now();
    await sleep(HOLD_MS);
    // SAFETY: OpenAI 兼容请求体；只换 messages，展开时保留 stream 等其余字段。
    const payload = JSON.parse(body) as { model?: string; stream?: boolean };
    forward = JSON.stringify({ ...payload, messages: [{ role: "user", content: "GOAL-CHECK-PROBE" }] });
    held.push({ receivedAt, releasedAt: Date.now() });
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的证据（毫秒，都相对发出那一刻）。 */
interface Evidence { answerDoneMs?: number; visibleMs?: number; idleMs?: number; goalCheckReceivedMs?: number; goalCheckReleasedMs?: number }

const evidence: Evidence = {};

try {
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, MARK);
  const sentAt = Date.now();
  await rp.pressEnter(panel);

  // 正式交付的回答气泡（带交付编号），不是还在流式写出的草稿。
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].some(m => m.textContent.includes(${JSON.stringify(ANSWER)}))`) || undefined, 60_000, "delivered answer visible", 50);
  evidence.visibleMs = Date.now() - sentAt;
  await until(async () => await rp.evaluate(panel, '!document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 30_000, "run idle", 50);
  evidence.idleMs = Date.now() - sentAt;
  await rp.screenshot(panel, join(artifacts, "answer-visible.png"));
  await until(async () => held.length > 0 || undefined, 30_000, "goal check released");

  const answer = model.requests.find(r => r.rule === MARK && r.step === 1);
  evidence.answerDoneMs = answer?.lastTextAt !== undefined ? answer.lastTextAt - sentAt : undefined;
  evidence.goalCheckReceivedMs = held[0]!.receivedAt - sentAt;
  evidence.goalCheckReleasedMs = held[0]!.releasedAt - sentAt;

  assert.ok(evidence.answerDoneMs !== undefined, "the main model wrote the answer");
  assert.ok(evidence.visibleMs < evidence.goalCheckReleasedMs, `answer visible (${evidence.visibleMs} ms) before the goal check finished (${evidence.goalCheckReleasedMs} ms)`);
  assert.ok(evidence.visibleMs - evidence.answerDoneMs <= 1_000, `answer visible within 1 s of the main model finishing (${evidence.visibleMs - evidence.answerDoneMs} ms)`);
  assert.ok(evidence.idleMs < evidence.goalCheckReleasedMs, `run idle (${evidence.idleMs} ms) before the goal check finished (${evidence.goalCheckReleasedMs} ms)`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
