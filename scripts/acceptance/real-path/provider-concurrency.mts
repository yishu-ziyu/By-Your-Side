/**
 * 服务商有并发上限时（Kimi 编程套餐同一账号同时只收 1 个请求），扩展把主任务请求和后台判断排队发出，不撞 403。
 * 只装扩展、隔离构建、本机脚本模型：主模型是 Kimi For Coding，发往 api.kimi.com 的请求在 offscreen 文档里被 CDP 拦下，
 * 转给本机的仿 Kimi 服务（Anthropic Messages 流式格式）。仿 Kimi 服务同一时间只接一个请求，每个请求停一会儿再回，
 * 另一个请求在这期间到达就回 403「concurrent request limit」（与真 Kimi 回的原文相同）。
 *   npx tsx scripts/acceptance/real-path/provider-concurrency.mts --headless [--case=start|held]
 * start：用户说「记住我住在北京」，任务开头同时有主任务请求和记忆判断。
 *   判定：侧栏出现正常回答和「已记住…北京」回执、没有错误卡；仿 Kimi 服务一次 403 都没回；任意时刻在途请求不超过 1 个；
 *   主任务请求在按下发送后 300 ms 内发出（记忆判断早几十毫秒发起，也不挡它）；记忆判断在主任务请求结束之后才完成。
 * held：同上一句，但记忆判断在仿 Kimi 服务上要 18 秒（短于记忆判断自己的 20 秒期限）。回答出来后马上开新会话问一句，
 *   这句的主任务请求要在扩展里排队等记忆判断结束，排队超过 15 秒（首字超时）。
 *   判定：用户看到这句的回答，没有错误卡，侧栏从没出现「正在重试」或「first response timeout」；一次 403 都没回；
 *   这句的主任务请求在记忆判断结束之后才到达，且离按下发送超过 15 秒（否则这次没测到排队超过首字超时）。
 * reading：同上一句，记忆判断在仿 Kimi 服务上要 8 秒；这期间用户在网页上划词点「解释」（阅读回答，不带排队回调的流式请求），
 *   随后在侧栏再问一句。判定：阅读卡里出现解释，侧栏出现第二句的回答（闸门没有卡死）；一次 403 都没回；
 *   点「解释」在记忆判断结束之前，解释请求在它结束之后才到达（确实排过队）。
 * 失败方式：两个请求同时发出，其中一个被 403 拒绝；或排队的时间算进首字超时，排队中就报超时、重试。
 * 诊断记录里的 model_queue 只打印，不作判定。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";

requireHeadless();

const REMEMBER = "记住我住在北京";

const TASK_REPLY = "好的，这句我记下了。";

/** 记忆判断的回答（形状同 model-failover.mts 的 SAVE_DECISION）：按用户原话记下住在北京。 */
const SAVE_DECISION = { action: "save", text: "住在北京", evidence: REMEMBER, scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true } };

/** 仿 Kimi 服务每个请求停这么久再回：足够让同时发出的另一个请求落在它的在途期间。 */
const HOLD_MS = 1_500;

/** held：记忆判断在仿 Kimi 服务上停这么久；第二句的主任务请求在这期间排队。 */
const SIDE_HOLD_MS = 18_000;

const ASK = "你好，第二个会话";

const ASK_REPLY = "你好！排完队也照常回答。";

/** reading：记忆判断在仿 Kimi 服务上停这么久，阅读请求在这期间排队。 */
const READING_SIDE_HOLD_MS = 8_000;

const MARKER = "The lighthouse keeper logged every storm in violet ink so that later sailors could trust the record.";

const EXPLAIN_ANSWER = "紫色染料能保存几十年，所以后来的水手信得过这份记录。";

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>灯塔日志</title>
<style>html,body{margin:0;background:#fff}article{max-width:36rem;margin:56px 0 80px 72px;font:17px/1.75 Georgia,serif;color:#222}</style></head>
<body><article><h1>灯塔日志</h1><p id="para"><span id="para-text">${MARKER}</span> 紫色是因为普通黑墨在盐雾里几个冬天就褪了。</p>
${"<p>港务长把各家的天气簿摊在桌上对照，决定哪条航道还安全。</p>".repeat(12)}</article></body></html>`;

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 主任务首字超时（能力表没登记 Kimi 的 firstEventMs，用主循环默认值）。 */
const FIRST_EVENT_TIMEOUT_MS = 15_000;

/** 主任务请求必须在用户按下发送后这么久内到达仿 Kimi 服务。 */
const MAIN_SENT_WITHIN_MS = 300;

const THROTTLE_BODY = JSON.stringify({ error: { type: "permission_error", message: "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again." }, type: "error" });

type Served = { kind: "main" | "side"; ask: boolean; reading: boolean; at: number; end?: number; status: number };

type Case = "start" | "held" | "reading";

const only = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const summary: Array<{ name: Case; status: string; artifacts: string; error: string | null; evidence: Record<string, unknown> }> = [];

for (const c of (["start", "held", "reading"] as Case[]).filter(c => !only || c === only)) summary.push(await runCase(c));

console.log(JSON.stringify(summary, null, 2));

if (summary.some(s => s.status !== "PASS")) process.exitCode = 1;

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

async function runCase(c: Case) {
  const artifacts = join(REPO, "out/acceptance/real-path", `${stamp}-provider-concurrency-${c}`);

  await mkdir(artifacts, { recursive: true });
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
    const entry: Served = { kind, ask: body.includes(ASK), reading: kind === "side" && body.includes(MARKER), at: Date.now(), status: 200 };
    served.push(entry);

    if (inFlight >= 1) {
      entry.status = 403;
      entry.end = Date.now();
      res.writeHead(403, { "content-type": "application/json" }).end(THROTTLE_BODY);

      return;
    }

    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const memory = kind === "side" && !entry.reading;
    await new Promise(resolve => setTimeout(resolve, memory && c === "held" ? SIDE_HOLD_MS : memory && c === "reading" ? READING_SIDE_HOLD_MS : HOLD_MS));
    res.writeHead(200, { "content-type": "text/event-stream" }).end(anthropicStream(entry.reading ? EXPLAIN_ANSWER : memory ? JSON.stringify(SAVE_DECISION) : entry.ask ? ASK_REPLY : TASK_REPLY));
    inFlight -= 1;
    entry.end = Date.now();
  });

  await new Promise<void>(resolve => kimi.listen(0, "127.0.0.1", resolve));
  const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const rp = await launchRealPath();
  let error: string | null = null;
  const evidence: Record<string, unknown> = { case: c };

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

    // 工作标签页先打开练习页：reading 要在上面划词。
    const workTargetId = (await rp.targets()).find(t => t.url === "about:blank")!.targetId;
    const work = await rp.attach(workTargetId);
    await rp.cdp.send("Page.enable", {}, work);
    await rp.cdp.send("DOM.enable", {}, work);
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
    await until(async () => (await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "练习页");

    const panel = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
    // 主模型与快速模型都是 Kimi（评测里的配置）：后台判断和主任务请求发往同一个账号。
    const kimiConfig = { provider: "kimi-coding", modelId: "kimi-for-coding" };
    const items = { inproc_model_config: kimiConfig, inproc_fast_model_config: kimiConfig, "inproc_cred:kimi-coding": { type: "api_key", key: "local-demo-no-secret" } };
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);

    const messages = () => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""').then(String);
    const receipts = () => rp.evaluate(panel, '[...document.querySelectorAll(".memory-receipt")].map(e => e.innerText)') as Promise<string[]>;
    const errorCard = () => rp.evaluate(panel, '!!document.querySelector("#messages .error-card")') as Promise<boolean>;
    // 重试提示是一闪而过的进度行：整个过程每 200 ms 看一次侧栏，出现过就记下。
    const glimpsed = new Set<string>();
    let watching = true;
    const watch = (async () => {
      while (watching) {
        const text = await messages().catch(() => "");

        for (const mark of ["正在重试", "first response timeout"]) if (text.includes(mark)) glimpsed.add(mark);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    })();

    const settled = 'document.querySelector("#send-btn")?.disabled===false';
    await until(async () => await rp.evaluate(panel, settled) || undefined, 60_000, "sidebar ready");
    await rp.click(panel, "#input");
    await rp.typeText(panel, REMEMBER);
    const sentAt = Date.now();
    await rp.pressEnter(panel);

    await until(async () => (await messages()).includes(TASK_REPLY) || await errorCard() || undefined, 60_000, "回答或错误卡出现");
    // held 随后切到新会话，第一句的回答只在这时看得到。
    evidence.firstAnswerSeen = (await messages()).includes(TASK_REPLY);
    let askAt: number | undefined;

    if (c === "held") {
      // 记忆判断还在仿 Kimi 服务上：开新会话问一句，它的主任务请求只能排队。
      await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.getAttribute("aria-busy") !== "true"') || undefined, 10_000, "可以开新会话");
      await rp.click(panel, "#conversation-new");
      await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${settled} && !document.querySelector("#messages .msg.user")`) || undefined, 30_000, "新会话建好");
      await rp.click(panel, "#input");
      await rp.typeText(panel, ASK);
      askAt = Date.now();
      await rp.pressEnter(panel);
      await until(async () => (await messages()).includes(ASK_REPLY) || await errorCard() || undefined, 60_000, "第二句的回答或错误卡出现");
    } else if (c === "reading") {
      // 记忆判断正占着名额：在网页上划词点「解释」，阅读回答只能排队。
      await until(async () => served.some(r => r.kind === "side" && !r.reading && r.end === undefined) || undefined, 10_000, "记忆判断已在仿 Kimi 服务上");
      await rp.cdp.send("Target.activateTarget", { targetId: workTargetId }).catch(() => {});
      await rp.cdp.send("Page.bringToFront", {}, work);
      await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);
      const answer = await askReading(rp, work);
      evidence.explainClickedAtMs = answer.clickedAt - sentAt;
      evidence.readingAnswerSeen = await until(async () => (await answer.text()).includes("几十年") || undefined, 30_000, "阅读卡里出现解释").catch(() => false);
      await rp.screenshot(work, join(artifacts, "reading.png"));
      // 再在侧栏问一句：闸门没卡死，就照常回答。
      await rp.click(panel, "#input");
      await rp.typeText(panel, ASK);
      askAt = Date.now();
      await rp.pressEnter(panel);
      await until(async () => (await messages()).includes(ASK_REPLY) || await errorCard() || undefined, 30_000, "第二句的回答或错误卡出现").catch(() => undefined);
    } else {
      await until(async () => (await receipts()).find(r => /已记住.*北京/.test(r)) ?? (await errorCard() || undefined), 30_000, "「已记住…北京」回执");
    }

    // 回答出来后再等 3 秒，让这一轮剩下的后台判断也发完，再看仿 Kimi 服务有没有回过 403。
    await new Promise(resolve => setTimeout(resolve, 3_000));
    watching = false;
    await watch;
    await rp.screenshot(panel, join(artifacts, "sidebar.png"));

    const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
    // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
    const lines = traces.split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; data?: JsonRecord });
    const text = await messages();
    const mainServed = served.filter(r => r.kind === "main" && !r.ask && r.status === 200);
    const sideServed = served.filter(r => r.kind === "side" && !r.reading && r.status === 200);
    const readingServed = served.filter(r => r.reading && r.status === 200);
    const askServed = served.filter(r => r.ask && r.status === 200);

    Object.assign(evidence, {
      requests: served.map(r => ({ kind: r.ask ? "main(second question)" : r.reading ? "reading" : r.kind, atMs: r.at - sentAt, endMs: r.end === undefined ? null : r.end - sentAt, status: r.status })),
      ...(askAt === undefined ? {} : { askSentAtMs: askAt - sentAt }),
      maxInFlight, glimpsed: [...glimpsed], receipts: await receipts(), errorCard: await errorCard(), sidebarTail: text.slice(-400),
      // 只打印，不作判定。
      modelQueue: lines.filter(l => l.type === "model_queue").map(l => l.data ?? {}),
    });

    assert.equal(evidence.errorCard, false, "没有错误卡");
    assert.equal(served.filter(r => r.status === 403).length, 0, "仿 Kimi 服务一次 403 都没回");
    assert.equal(maxInFlight, 1, "任意时刻在途请求不超过 1 个");
    assert.equal(evidence.firstAnswerSeen, true, "侧栏出现第一句的回答");
    assert.ok(mainServed.length >= 1 && sideServed.length >= 1, "主任务请求和记忆判断都得到了回答");
    assert.ok(mainServed[0]!.at - sentAt <= MAIN_SENT_WITHIN_MS, `主任务请求在任务开始后 ${MAIN_SENT_WITHIN_MS} ms 内发出，没被后台判断挡住（${mainServed[0]!.at - sentAt} ms）`);
    assert.ok(sideServed[0]!.end! >= mainServed[0]!.end!, "记忆判断在主任务请求结束之后才完成");

    if (c === "start") assert.ok((evidence.receipts as string[]).some(r => /已记住.*北京/.test(r)), "侧栏出现「已记住…北京」");
    else if (c === "reading") {
      assert.equal(evidence.readingAnswerSeen, true, "阅读卡里出现解释");
      assert.ok(text.includes(ASK_REPLY), "侧栏出现第二句的回答，闸门没有卡死");
      assert.ok(readingServed.length >= 1, "解释请求发到了仿 Kimi 服务");
      assert.ok((evidence.explainClickedAtMs as number) < sideServed[0]!.end! - sentAt, "点「解释」时记忆判断还占着名额");
      assert.ok(readingServed[0]!.at >= sideServed[0]!.end!, "解释请求在记忆判断结束之后才到达（排过队）");
    } else {
      assert.ok(text.includes(ASK_REPLY), "侧栏出现第二句的回答");
      assert.deepEqual([...glimpsed], [], "侧栏从没出现「正在重试」或「first response timeout」");
      assert.equal(askServed.length, 1, "第二句的主任务请求只发出一次");
      assert.ok(askServed[0]!.at >= sideServed[0]!.end!, "第二句的主任务请求在记忆判断结束之后才到达");
      assert.ok(askServed[0]!.at - askAt! > FIRST_EVENT_TIMEOUT_MS, `第二句排队超过首字超时（${askServed[0]!.at - askAt!} ms）`);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    const status = error ? "FAIL" : "PASS";
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ status, evidence, error }, null, 2));
    await rp.close();
    await rp.remove();
    kimi.closeAllConnections();
    kimi.close();
    site.close();
  }

  return { name: c, status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null, evidence };
}

/** 在练习页上划选标记句，点阅读卡的「解释」；返回点击时间和读阅读卡回答的函数（写法同 reading-card-gloss.mts）。 */
async function askReading(rp: Awaited<ReturnType<typeof launchRealPath>>, work: string) {
  const findShadow = (node: DomNode): DomNode | null => {
    if ((node.attributes ?? []).includes("data-sideagent-ask") && node.shadowRoots?.length) return node.shadowRoots[0]!;

    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const hit = findShadow(child);

      if (hit) return hit;
    }

    return null;
  };

  const inCard = async <T,>(fn: string): Promise<T> => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
    const shadow = findShadow(root);

    if (!shadow) throw new Error("找不到阅读卡");
    const objectId = String((await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work)).object.objectId);
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true }, work);

    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);

    // SAFETY: returnByValue 交回的是 fn 返回的 JSON 值，形状由调用处的 fn 决定。
    return reply.result.value as T;
  };

  const span = await rp.evaluate(work, `(() => { const node = document.querySelector("#para-text"); node.scrollIntoView({block:"center"}); const r = node.getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 2, y1: a.top + a.height / 2, x2: Math.max(a.left + 24, b.right - 2), y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, work);

  for (let i = 1; i <= 8; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 8, y: span.y1 + ((span.y2 - span.y1) * i) / 8, button: "left", buttons: 1 }, work);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, work);
  const explain = await until(() => inCard<{ x: number; y: number } | null>(`function(){const e=this.querySelector('[data-act="explain"]');if(!e||e.closest("[hidden]"))return null;const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+Math.min(r.height/2,18)}:null}`), 10_000, "解释");
  await sleep(200);

  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...explain }, work);
  const clickedAt = Date.now();
  // 摘要和完整回答都算：默认只露出摘要。
  const text = () => inCard<string>(`function(){return [...this.querySelectorAll(".answer, .answer-summary")].map(a=>a.textContent??"").join("\\n")}`);

  return { clickedAt, text };
}
