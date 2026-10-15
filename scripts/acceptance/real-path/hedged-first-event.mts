/**
 * 模型请求卡住不出第一个字时，到对冲时间点再发一份相同的请求，先出字的那份胜出（对冲请求）。
 * 只装扩展、隔离构建、本机脚本模型：主模型是自定义地址（能力表没登记，对冲时间点取默认 8 秒、首个事件上限 15 秒），指向本机服务。
 *   npx tsx scripts/acceptance/real-path/hedged-first-event.mts --headless [--case=wins|throttled|unaccepted|accepted|accepted-error|late-loser]
 * wins：第一份任务请求一直不出事件，第二份照常回答。用户在对冲时间点后不久就看到回答（远早于 15 秒超时），
 *   侧栏只有一份回答、没有错误；卡住的那份被取消；两份请求体相同；诊断记录有 model_hedge 和胜出记录。
 * throttled：第一份 10 秒后才回答，对冲那份被拒（Kimi 的并发上限 403）。对冲失败被静默丢掉：用户照常看到第一份的回答，
 *   没有错误、没有重试。
 * unaccepted：两份都只回响应头、一个事件也不发（服务整段挂住）。在原上限 15 秒放弃并重试，不因为有对冲多等。
 * accepted：第一份挂住；对冲那份先发一个空的流事件（服务端已受理），再过一会儿才出字，晚于原上限 15 秒。
 *   对冲那份被受理后可再等 10 秒，所以这次不放弃，用户看到对冲那份的回答，没有重试。
 * accepted-error：第一份挂住；对冲那份先被受理，随后连接断开（流内出错）。它不再证明服务活着，仍在原上限 15 秒放弃并重试。
 * late-loser：第一份 10 秒开始分段写「甲」、约 11 秒写完；对冲那份 10.3 秒写出「乙」，正落在「甲」还在写的时候。
 *   侧栏只出现「甲」，「乙」一次也不出现。
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

/** accepted：对冲那份受理后到出字的间隔；对冲时间点加上它晚于 15 秒上限，早于受理后 10 秒的期限。 */
const ACCEPTED_SLOW_MS = 8_500;

const LATE_A = "甲份回答：先到的这一份。";

const LATE_B = "乙份回答：晚到的这一份。";

/** late-loser：两份各自从第一份发出起多久开始写字；「甲」分段写，每段之间停 LATE_A_GAP_MS。 */
const LATE_A_MS = 10_000;

const LATE_B_MS = 10_300;

const LATE_A_GAP_MS = 250;

const sseChunk = (delta: JsonRecord, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-hedge", object: "chat.completion.chunk", created: 0, model: "demo-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const THROTTLE_BODY = JSON.stringify({ error: { type: "permission_error", message: "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again." }, type: "error" });

type Case = { name: "wins" | "throttled" | "unaccepted" | "accepted" | "accepted-error" | "late-loser" };

const only = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const summary: Array<{ name: string; status: string; artifacts: string; error: string | null }> = [];

for (const c of ([{ name: "wins" }, { name: "throttled" }, { name: "unaccepted" }, { name: "accepted" }, { name: "accepted-error" }, { name: "late-loser" }] as Case[]).filter(c => !only || c.name === only)) summary.push(await runCase(c));

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

    if (c.name === "late-loser") {
      // 两份都在约定时刻直接写出各自的回答；输掉的那份若已被取消，连接已关，写不出去。
      const text = index === 0 ? LATE_A : LATE_B;
      entry.reply = index === 0 ? `${LATE_A} at ${LATE_A_MS} ms` : `${LATE_B} at ${LATE_B_MS} ms`;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, asked[0]!.at + (index === 0 ? LATE_A_MS : LATE_B_MS) - Date.now())));

      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseChunk({ role: "assistant", content: "" }));

      for (const [i, piece] of (index === 0 ? text.match(/[\s\S]{1,3}/g)! : [text]).entries()) {
        if (i) await new Promise(resolve => setTimeout(resolve, LATE_A_GAP_MS));

        if (res.destroyed) return;
        res.write(sseChunk({ content: piece }));
      }

      res.write(sseChunk({}, "stop"));
      res.end("data: [DONE]\n\n");

      return;
    }

    if (c.name === "accepted-error" && index === 1) {
      // 先被受理（一个不带正文的流事件），1 秒后连接断开。
      entry.reply = "accepted, then connection reset";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseChunk({ role: "assistant", content: "" }));
      setTimeout(() => res.destroy(), 1_000);

      return;
    }

    if ((index === 0 && (c.name === "wins" || c.name === "accepted")) || c.name === "unaccepted" || c.name === "accepted-error") {
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

    if (c.name === "accepted") {
      // 先发一个不带正文的流事件：适配层把它当作服务端已受理，但不算第一个内容事件。
      entry.reply = `accepted, answer after ${ACCEPTED_SLOW_MS} ms`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseChunk({ role: "assistant", content: "" }));
      await new Promise(resolve => setTimeout(resolve, ACCEPTED_SLOW_MS));
    } else if (index === 0) {
      entry.reply = `answer after ${SLOW_FIRST_MS} ms`;
      await new Promise(resolve => setTimeout(resolve, SLOW_FIRST_MS));
    } else entry.reply = "answer";

    if (res.destroyed) return;
    const upstream = await forward(req.url, req.method, body);

    if (!res.headersSent) res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });

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
    // 侧栏里只要出现过「乙」就记下，哪怕随后被替换掉。
    await rp.evaluate(panel, `(() => { globalThis.__sawLateB = false; const root = document.querySelector("#messages"); new MutationObserver(() => { if (root.textContent.includes(${JSON.stringify(LATE_B)})) globalThis.__sawLateB = true; }).observe(root, { childList: true, subtree: true, characterData: true }); return true; })()`);
    const sentAt = Date.now();
    await rp.pressEnter(panel);

    const messages = () => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""').then(String);

    if (c.name === "unaccepted" || c.name === "accepted-error") {
      // 等到放弃后的第一次重试发出，就够判断放弃时间；之后的重试不看。
      await until(async () => asked.length >= 3 || undefined, 40_000, "retry after giving up");
      evidence.retryAtMs = asked[2]!.at - asked[0]!.at;
      await rp.screenshot(panel, join(artifacts, "sidebar.png"));
      const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
      // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
      const lines = traces.split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; data?: JsonRecord });
      evidence.hedgeRecords = lines.filter(l => l.type.startsWith("model_hedge")).map(l => ({ type: l.type, ...l.data }));
      evidence.requests = asked.map(r => ({ atMs: r.at - sentAt, closedAtMs: r.closedAt === undefined ? null : r.closedAt - sentAt, reply: r.reply }));
      const hedgeAtMs = asked[1]!.at - asked[0]!.at;
      assert.ok(hedgeAtMs >= HEDGE_MS - 500 && hedgeAtMs <= HEDGE_MS + 1_500, `对冲那份在对冲时间点发出（${hedgeAtMs} ms）`);
      // 原上限 15 秒，加重试前的 0.5 秒间隔；对冲那份没被受理（或受理后又断开），不放宽。
      assert.ok((evidence.retryAtMs as number) >= 15_000 && (evidence.retryAtMs as number) <= 16_800, `两份都没被受理时在原上限放弃并重试（${evidence.retryAtMs} ms）`);
      assert.ok(asked[0]!.closedAt !== undefined && asked[1]!.closedAt !== undefined && asked[1]!.closedAt <= asked[2]!.at + 500, "放弃时两份都被取消");
      assert.ok((evidence.hedgeRecords as Array<Record<string, unknown>>).some(r => r.type === "model_hedge_winner" && r.winner === "none"), "诊断记录写明两份都没出字");

      // 走到这里说明判据全过；finally 照常写 result.json、关浏览器。
      return { name: c.name, status: "PASS", artifacts, error: null };
    }

    const expected = c.name === "late-loser" ? LATE_A : ANSWER;
    await until(async () => (await messages()).includes(expected) || undefined, 40_000, "answer visible");
    const visibleMs = Date.now() - sentAt;
    // 回答出来后再等 3 秒，看输掉的那份有没有晚到的字进侧栏。
    await until(async () => await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping")') || undefined, 30_000, "sidebar idle");
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await rp.screenshot(panel, join(artifacts, "sidebar.png"));
    const text = await messages();
    const answers = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].filter(x => x.textContent.includes(${JSON.stringify(expected)})).length`);
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
      answerTextCount: text.split(expected).length - 1,
      sawLateB: await rp.evaluate(panel, "globalThis.__sawLateB"),
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
    } else if (c.name === "accepted") {
      const winnerRecord = hedgeRecords.find(r => r.type === "model_hedge_winner");
      assert.ok(visibleMs > 15_500 && visibleMs <= HEDGE_MS + ACCEPTED_SLOW_MS + 2_500, `对冲那份被受理后，过了原上限仍等它出字（${visibleMs} ms）`);
      assert.ok(winnerRecord?.winner === "hedge" && Number(winnerRecord.firstEventMs) > 15_000, `对冲那份在原上限之后胜出（${JSON.stringify(winnerRecord)}）`);
    } else if (c.name === "late-loser") {
      assert.equal(evidence.sawLateB, false, "侧栏从没出现过晚到那份的「乙」");
      assert.ok(!text.includes(LATE_B), "侧栏最后也没有「乙」");
      assert.ok(hedgeRecords.some(r => r.type === "model_hedge_winner" && r.winner === "first"), "诊断记录写明第一份胜出");
    } else {
      assert.ok(visibleMs >= SLOW_FIRST_MS && visibleMs <= SLOW_FIRST_MS + 3_000, `回答来自第一份（${visibleMs} ms）`);
      assert.ok(!/并发|concurrent|繁忙|忙/.test(text), "侧栏没有提到并发上限或服务繁忙");
      assert.ok(hedgeRecords.some(r => r.type === "model_hedge_winner" && r.winner === "first" && /concurrent request limit/.test(String(r.hedgeError))), "诊断记录写明第一份胜出、对冲那份被拒");
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    // 失败时也留下侧栏现场，看清是没出字还是混进了另一份。
    const panelTarget = (await rp.targets().catch(() => [])).find(t => t.url.includes("sidepanel"));

    if (panelTarget) {
      const panel = await rp.attach(panelTarget.targetId).catch(() => null);

      if (panel) {
        evidence.sawLateB ??= await rp.evaluate(panel, "globalThis.__sawLateB ?? null").catch(() => null);
        evidence.sidebarTail ??= String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""').catch(() => "")).slice(-300);
      }
    }
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
