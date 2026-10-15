/**
 * 模型请求卡住不出第一个字时，到对冲时间点再发一份相同的请求，先出字的那份胜出（对冲请求）。
 * 只装扩展、隔离构建、本机脚本模型：主模型是自定义地址（能力表没登记，对冲时间点取默认 8 秒、首个事件上限 15 秒），指向本机服务。
 *   npx tsx scripts/acceptance/real-path/hedged-first-event.mts --headless [--case=wins|throttled]
 * wins：第一份任务请求一直不出事件，第二份照常回答。用户在对冲时间点后不久就看到回答（远早于 15 秒超时），
 *   侧栏只有一份回答、没有错误；卡住的那份被取消；两份请求体相同；诊断记录有 model_hedge 和胜出记录。
 * throttled：第一份 10 秒后才回答，对冲那份被拒（Kimi 的并发上限 403）。对冲失败被静默丢掉：用户照常看到第一份的回答，
 *   没有错误、没有重试。
 * 失败方式：旧代码要等 15 秒超时再重试才出字；或两份的回答都进了侧栏；或对冲被拒让整次调用报错。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, until, type JsonRecord } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const MARK = "你好，对冲验收";

const ANSWER = "你好！这是先出字的那一份。";

/** 产品默认对冲时间点（能力表没登记的模型）。 */
const HEDGE_MS = 8_000;

/** 回答必须在对冲时间点后这么久内出现；旧代码要等 15 秒超时、0.5 秒重试间隔，再等重试出字。 */
const WINS_BOUND_MS = HEDGE_MS + 3_000;

/** throttled：第一份这么久后才回答（早于 15 秒上限，晚于对冲时间点）。 */
const SLOW_FIRST_MS = 10_000;

const THROTTLE_BODY = JSON.stringify({ error: { type: "permission_error", message: "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again." }, type: "error" });

type Case = { name: "wins" | "throttled" };

const only = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const summary: Array<{ name: string; status: string; artifacts: string; error: string | null }> = [];

for (const c of ([{ name: "wins" }, { name: "throttled" }] as Case[]).filter(c => !only || c.name === only)) summary.push(await runCase(c));

console.log(JSON.stringify(summary, null, 2));

if (summary.some(s => s.status !== "PASS")) process.exitCode = 1;

async function runCase(c: Case) {
  const artifacts = join(REPO, "out/acceptance/real-path", `${stamp}-hedged-first-event-${c.name}`);

  await mkdir(artifacts, { recursive: true });
  const scripted = await startScriptedModel([{ match: MARK, steps: [{ text: ANSWER }] }]);
  const forward = async (url: string | undefined, method: string | undefined, body: string) =>
    fetch(`${scripted.baseUrl.replace(/\/$/, "")}${(url ?? "").replace(/^\/v1/, "")}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? body : undefined });
  /** 带工具表的任务请求：发出时间、请求体指纹、连接何时被关、回了什么。 */
  const asked: Array<{ at: number; sha256: string; closedAt?: number; reply: string }> = [];

  const main = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) body += String(chunk);

    if (req.method !== "POST" || !/"tools"\s*:\s*\[\s*\{/.test(body)) {
      const upstream = await forward(req.url, req.method, body);
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));

      return;
    }

    const entry: (typeof asked)[number] = { at: Date.now(), sha256: createHash("sha256").update(body).digest("hex"), reply: "" };
    const index = asked.push(entry) - 1;
    res.on("close", () => { entry.closedAt = Date.now(); });

    if (index === 0 && c.name === "wins") {
      // 连上、回了响应头，之后一个事件也不发。
      entry.reply = "hang";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();

      return;
    }

    if (index === 1 && c.name === "throttled") {
      entry.reply = "403 concurrent limit";
      res.writeHead(403, { "content-type": "application/json" }).end(THROTTLE_BODY);

      return;
    }

    if (index === 0) {
      entry.reply = `answer after ${SLOW_FIRST_MS} ms`;
      await new Promise(resolve => setTimeout(resolve, SLOW_FIRST_MS));
    } else entry.reply = "answer";

    if (res.destroyed) return;
    const upstream = await forward(req.url, req.method, body);
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });

    for await (const part of upstream.body ?? []) res.write(part);
    res.end();
  });

  await new Promise<void>(resolve => main.listen(0, "127.0.0.1", resolve));
  const rp = await launchRealPath();
  let error: string | null = null;
  const evidence: Record<string, unknown> = { case: c.name };

  try {
    const panel = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
    const items = {
      inproc_model_config: { provider: "custom", modelId: "primary-model", baseUrl: `http://127.0.0.1:${siteAddress(main).port}/v1` },
      "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
    };
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);

    evidence.stage = "send";
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
    await rp.click(panel, "#input");
    await rp.typeText(panel, MARK);
    const sentAt = Date.now();
    await rp.pressEnter(panel);

    const messages = () => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""').then(String);
    await until(async () => (await messages()).includes(ANSWER) || undefined, 40_000, "answer visible");
    const visibleMs = Date.now() - sentAt;
    // 回答出来后再等 3 秒，看输掉的那份有没有晚到的字进侧栏。
    await until(async () => await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping")') || undefined, 30_000, "sidebar idle");
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await rp.screenshot(panel, join(artifacts, "sidebar.png"));
    const text = await messages();
    const answers = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].filter(x => x.textContent.includes(${JSON.stringify(ANSWER)})).length`);
    const errorCards = await rp.evaluate(panel, 'document.querySelectorAll("#messages .error-card").length');

    const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
    // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
    const lines = traces.split("\n").filter(Boolean).map(line => JSON.parse(line) as { runId: string | null; type: string; data?: JsonRecord });
    const runId = lines.find(l => l.type === "run_start" && String(l.data?.text ?? "").includes(MARK))?.runId;
    const hedgeRecords = lines.filter(l => l.runId === runId && l.type.startsWith("model_hedge")).map(l => ({ type: l.type, ...l.data }));

    Object.assign(evidence, {
      stage: "done",
      visibleMs,
      requests: asked.map(r => ({ atMs: r.at - sentAt, closedAtMs: r.closedAt === undefined ? null : r.closedAt - sentAt, reply: r.reply, sha256: r.sha256.slice(0, 12) })),
      answersInSidebar: answers,
      answerTextCount: text.split(ANSWER).length - 1,
      errorCards,
      hedgeRecords,
      sidebarTail: text.slice(-300),
    });

    assert.equal(asked.length, 2, "任务请求发了两份：原请求和对冲那份，没有超时后的重试");
    const hedgeAtMs = asked[1]!.at - asked[0]!.at;
    assert.ok(hedgeAtMs >= HEDGE_MS - 500 && hedgeAtMs <= HEDGE_MS + 1_500, `对冲那份在对冲时间点发出（${hedgeAtMs} ms）`);
    assert.equal(asked[1]!.sha256, asked[0]!.sha256, "两份请求体完全相同");
    assert.equal(answers, 1, "侧栏只有一份回答");
    assert.equal(evidence.answerTextCount, 1, "回答正文在侧栏只出现一次");
    assert.equal(errorCards, 0, "侧栏没有错误卡");
    assert.ok(hedgeRecords.some(r => r.type === "model_hedge" && r.model === "custom/primary-model" && r.hedgeMs === HEDGE_MS), "诊断记录有发出对冲的那条");

    if (c.name === "wins") {
      assert.ok(visibleMs <= WINS_BOUND_MS, `回答在对冲时间点后不久出现（${visibleMs} ms，上限 ${WINS_BOUND_MS} ms）`);
      assert.ok(asked[0]!.closedAt !== undefined && asked[0]!.closedAt - asked[1]!.at < 3_000, "卡住的那份在对冲那份出字后被取消");
      assert.ok(hedgeRecords.some(r => r.type === "model_hedge_winner" && r.winner === "hedge"), "诊断记录写明对冲那份胜出");
    } else {
      assert.ok(visibleMs >= SLOW_FIRST_MS && visibleMs <= SLOW_FIRST_MS + 3_000, `回答来自第一份（${visibleMs} ms）`);
      assert.ok(!/并发|concurrent|繁忙|忙/.test(text), "侧栏没有提到并发上限或服务繁忙");
      assert.ok(hedgeRecords.some(r => r.type === "model_hedge_winner" && r.winner === "first" && /concurrent request limit/.test(String(r.hedgeError))), "诊断记录写明第一份胜出、对冲那份被拒");
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    const status = error ? "FAIL" : "PASS";
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ status, evidence, error }, null, 2));
    await rp.close();
    await rp.remove();
    await scripted.close();
    main.closeAllConnections();
    main.close();
  }

  return { name: c.name, status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null };
}
