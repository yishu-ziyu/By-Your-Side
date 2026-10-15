/**
 * 服务商有并发上限时（Kimi 编程套餐同一账号同时只收 1 个请求），扩展把主任务请求和后台判断排队发出，不撞 403。
 * 只装扩展、隔离构建、本机脚本模型：主模型是 Kimi For Coding，发往 api.kimi.com 的请求在 offscreen 文档里被 CDP 拦下，
 * 转给本机的仿 Kimi 服务（Anthropic Messages 流式格式）。仿 Kimi 服务同一时间只接一个请求，每个请求停一会儿再回，
 * 另一个请求在这期间到达就回 403「concurrent request limit」（与真 Kimi 回的原文相同）。
 *   npx tsx scripts/acceptance/real-path/provider-concurrency.mts --headless
 * 用户说「记住我住在北京」：任务开头同时有主任务请求和记忆判断。
 * 判定：侧栏出现正常回答和「已记住…北京」回执、没有错误卡；仿 Kimi 服务一次 403 都没回；任意时刻在途请求不超过 1 个；
 * 主任务请求在按下发送后 300 ms 内发出（记忆判断早几十毫秒发起，也不挡它）；记忆判断在主任务请求结束之后才完成；
 * 诊断记录里有 model_queue（供应商、用途、等了多少毫秒）。
 * 失败方式：两个请求同时发出，其中一个被 403 拒绝（旧代码里主任务请求按 0.5 秒、1 秒重试，记忆判断按 1.5 秒、3 秒重试）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, until, type JsonRecord } from "./harness.mts";

requireHeadless();

const REMEMBER = "记住我住在北京";

const TASK_REPLY = "好的，这句我记下了。";

/** 记忆判断的回答（形状同 model-failover.mts 的 SAVE_DECISION）：按用户原话记下住在北京。 */
const SAVE_DECISION = { action: "save", text: "住在北京", evidence: REMEMBER, scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true } };

/** 仿 Kimi 服务每个请求停这么久再回：足够让同时发出的另一个请求落在它的在途期间。 */
const HOLD_MS = 1_500;

/** 主任务请求必须在用户按下发送后这么久内到达仿 Kimi 服务。 */
const MAIN_SENT_WITHIN_MS = 300;

const THROTTLE_BODY = JSON.stringify({ error: { type: "permission_error", message: "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again." }, type: "error" });

type Served = { kind: "main" | "side"; at: number; end?: number; status: number };

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const artifacts = join(REPO, "out/acceptance/real-path", `${stamp}-provider-concurrency`);

await mkdir(artifacts, { recursive: true });

/** 一条 Anthropic Messages 流式回答：只有一段正文。 */
function anthropicStream(text: string): string {
  const events: Array<[string, JsonRecord]> = [
    ["message_start", { type: "message_start", message: { id: "msg_local", type: "message", role: "assistant", model: "kimi-for-coding", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }],
    ["message_stop", { type: "message_stop" }],
  ];

  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const served: Served[] = [];
let inFlight = 0;
let maxInFlight = 0;

const kimi = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);

  // 提前建连接发的 HEAD 不是模型请求，不占名额。
  if (req.method !== "POST") {
    res.writeHead(200).end();

    return;
  }

  const kind = /"tools"\s*:\s*\[\s*\{/.test(body) ? "main" : "side";
  const entry: Served = { kind, at: Date.now(), status: 200 };
  served.push(entry);

  if (inFlight >= 1) {
    entry.status = 403;
    entry.end = Date.now();
    res.writeHead(403, { "content-type": "application/json" }).end(THROTTLE_BODY);

    return;
  }

  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise(resolve => setTimeout(resolve, HOLD_MS));
  res.writeHead(200, { "content-type": "text/event-stream" }).end(anthropicStream(kind === "main" ? TASK_REPLY : JSON.stringify(SAVE_DECISION)));
  inFlight -= 1;
  entry.end = Date.now();
});

await new Promise<void>(resolve => kimi.listen(0, "127.0.0.1", resolve));
const rp = await launchRealPath();
let error: string | null = null;
const evidence: Record<string, unknown> = {};

try {
  const offscreen = await until(async () => (await rp.targets()).find(t => t.url === `chrome-extension://${rp.extensionId}/inproc.html`), 30_000, "扩展内 agent 的 offscreen 文档");
  const offscreenSession = await rp.attach(offscreen.targetId);
  const port = siteAddress(kimi).port;

  rp.cdp.onEvent("Fetch.requestPaused", (message: { sessionId?: string; params: { requestId: string; request: { url: string; method: string; postData?: string } } }) => {
    if (message.sessionId !== offscreenSession) return;
    const { requestId, request } = message.params;
    void (async () => {
      const upstream = await fetch(`http://127.0.0.1:${port}${new URL(request.url).pathname}`, { method: request.method, headers: { "content-type": "application/json" }, body: request.method === "POST" ? request.postData : undefined });
      const body = Buffer.from(await upstream.arrayBuffer()).toString("base64");
      await rp.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: upstream.status, responseHeaders: [{ name: "content-type", value: upstream.headers.get("content-type") ?? "application/json" }, { name: "access-control-allow-origin", value: "*" }], body }, offscreenSession);
    })().catch(caught => { evidence.interceptError = String(caught); });
  });
  await rp.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.kimi.com/*", requestStage: "Request" }] }, offscreenSession);

  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // 主模型与快速模型都是 Kimi（评测里的配置）：后台判断和主任务请求发往同一个账号。
  const kimiConfig = { provider: "kimi-coding", modelId: "kimi-for-coding" };
  const items = { inproc_model_config: kimiConfig, inproc_fast_model_config: kimiConfig, "inproc_cred:kimi-coding": { type: "api_key", key: "local-demo-no-secret" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);

  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, REMEMBER);
  const sentAt = Date.now();
  await rp.pressEnter(panel);

  const messages = () => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""').then(String);
  const receipts = () => rp.evaluate(panel, '[...document.querySelectorAll(".memory-receipt")].map(e => e.innerText)') as Promise<string[]>;
  const errorCard = () => rp.evaluate(panel, '!!document.querySelector("#messages .error-card")') as Promise<boolean>;

  await until(async () => (await messages()).includes(TASK_REPLY) || await errorCard() || undefined, 60_000, "回答或错误卡出现");
  await until(async () => (await receipts()).find(r => /已记住.*北京/.test(r)) ?? (await errorCard() || undefined), 30_000, "「已记住…北京」回执");
  // 回答出来后再等 3 秒，让这一轮剩下的后台判断也发完，再看仿 Kimi 服务有没有回过 403。
  await new Promise(resolve => setTimeout(resolve, 3_000));
  await rp.screenshot(panel, join(artifacts, "sidebar.png"));

  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
  const lines = traces.split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; data?: JsonRecord });
  const queueRecords = lines.filter(l => l.type === "model_queue").map(l => l.data ?? {});
  const text = await messages();
  const mainServed = served.filter(r => r.kind === "main" && r.status === 200);
  const sideServed = served.filter(r => r.kind === "side" && r.status === 200);

  Object.assign(evidence, {
    requests: served.map(r => ({ kind: r.kind, atMs: r.at - sentAt, endMs: r.end === undefined ? null : r.end - sentAt, status: r.status })),
    maxInFlight, queueRecords, receipts: await receipts(), errorCard: await errorCard(), sidebarTail: text.slice(-400),
  });

  assert.ok(text.includes(TASK_REPLY), "侧栏出现正常回答");
  assert.equal(evidence.errorCard, false, "没有错误卡");
  assert.ok((evidence.receipts as string[]).some(r => /已记住.*北京/.test(r)), "侧栏出现「已记住…北京」");
  assert.equal(served.filter(r => r.status === 403).length, 0, "仿 Kimi 服务一次 403 都没回");
  assert.equal(maxInFlight, 1, "任意时刻在途请求不超过 1 个");
  assert.ok(mainServed.length >= 1 && sideServed.length >= 1, "主任务请求和后台判断都得到了回答");
  assert.ok(mainServed[0]!.at - sentAt <= MAIN_SENT_WITHIN_MS, `主任务请求在任务开始后 ${MAIN_SENT_WITHIN_MS} ms 内发出，没被后台判断挡住（${mainServed[0]!.at - sentAt} ms）`);
  assert.ok(sideServed[0]!.end! >= mainServed[0]!.end!, "记忆判断在主任务请求结束之后才完成");
  assert.ok(queueRecords.some(r => r.provider === "kimi-coding" && typeof r.waitedMs === "number" && (r.waitedMs as number) > 200 && (r.purpose === "main" || r.purpose === "side")), "诊断记录有 model_queue");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  const status = error ? "FAIL" : "PASS";
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status, evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  kimi.closeAllConnections();
  kimi.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null, evidence }, null, 2));

if (error) process.exitCode = 1;
