/**
 * 模型忙或限流时，错误卡自己倒计时、到点自动重试（docs/evals/20261015-auto-retry-countdown.md R1–R4）。
 * 只装扩展、隔离构建、本机脚本模型；前面挡一个本机服务，按场景回 Kimi 的 403 同时请求数超限、429 限流或 429 额度用完。
 * 循环自己会先快速重试两次，所以卡上每失败一次 = 门口连回 3 次错误。等待没有测试开关，按真实的 8、16 秒等。
 *   npx tsx scripts/acceptance/real-path/auto-retry-countdown.mts --headless
 * 判据只看侧栏里用户看得到的内容和门口收到的请求：
 *   甲 Kimi 403：不点任何按钮，卡上出现「第 1 次」倒计时，到点自己重试；再失败写「第 2 次」且等得更久；之后答案出现，用户只发过一次。
 *   乙 429：点「立即重试」，2 秒内门口收到重试，答案出现。
 *   丙 倒计时中发新消息：新消息答完后等过原来的到点时间，门口没有旧任务的重试，旧卡写「不再自动重试」。
 *   丁 一直 429：连点 3 次「立即重试」都失败后，卡上只剩手动按钮，没有倒计时；点「稍后重试」，倒计时后接着做，答案出现。
 *   戊 429 额度用完：卡上没有倒计时，12 秒内门口没有新的请求。
 *   己 倒计时中重开侧栏（重载侧栏页）：回放出来的卡只有手动按钮、没有倒计时，15 秒内门口没有新的请求。
 *   庚 第二个窗口里再开一个侧栏页：同一次出错只有一个侧栏倒计时，另一个只给手动按钮；答案出来后两边都没有「没有要接着做的出错任务」。
 * 读屏：倒计时那行不设 aria-live，每秒变的数字 aria-hidden，只有一句不变的话给读屏。
 * 失败方式：倒计时要点了才出现、403 被当成 key 无效、额度用完也自动重试、第 4 次还在倒计时、新消息之后旧任务自己重跑、
 *   重开侧栏后旧卡又倒计时并重试。
 * 产物：out/acceptance/real-path/<时间>-auto-retry-countdown/*.png、countdown.mp4、result.json。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = process.env.OUT ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-auto-retry-countdown`);

await mkdir(artifacts, { recursive: true });

// 庚排第一：第二个侧栏开在标签页里，任务请求带上这个标签页的标题（会话名「自动重试验收甲」），脚本模型按规则顺序挑第一条匹配的。
const CASES = {
  twin: { ask: "自动重试验收庚", answer: "庚：只重试了一次。" },
  kimi: { ask: "自动重试验收甲", answer: "甲：等忙过去后答完了。" },
  now: { ask: "自动重试验收乙", answer: "乙：立即重试后答完了。" },
  old: { ask: "自动重试验收丙旧", answer: "丙旧：不该出现。" },
  fresh: { ask: "自动重试验收丙新", answer: "丙新：新消息答完了。" },
  exhaust: { ask: "自动重试验收丁", answer: "丁：稍后重试后答完了。" },
  quota: { ask: "自动重试验收戊", answer: "戊：不该出现。" },
  replay: { ask: "自动重试验收己", answer: "己：不该出现。" },
};

const model = await startScriptedModel(Object.values(CASES).map(c => ({ match: c.ask, steps: [{ text: c.answer }] })));

const KIMI_403 = { status: 403, body: JSON.stringify({ error: { type: "permission_error", message: "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again." }, type: "error" }) };
const RATE_429 = { status: 429, body: JSON.stringify({ error: { message: "Rate limit reached, please retry later" } }) };
const QUOTA_429 = { status: 429, body: JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }) };

// 挡在模型前面：接下来几次任务请求（带工具表）回给定的错误；count 为 Infinity 时一直回。
let failNext: { reply: { status: number; body: string }; count: number } | null = null;

const gate: Array<{ at: number; result: string }> = [];

const front = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  const task = /"tools"\s*:\s*\[\s*\{/.test(body);

  if (failNext && failNext.count > 0 && task) {
    failNext.count -= 1;
    gate.push({ at: Date.now(), result: String(failNext.reply.status) });
    res.writeHead(failNext.reply.status, { "content-type": "application/json" }).end(failNext.reply.body);

    return;
  }

  if (task) gate.push({ at: Date.now(), result: "ok" });
  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let panel = "";

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(front).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "good-key" },
  })}).then(() => true)`);

  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const text = async () => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'));
  const visible = (selector: string) => rp.evaluate(panel, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.getClientRects().length > 0; })()`) as Promise<boolean>;
  const waitFor = (selector: string, label: string, ms = 60_000) => until(async () => await visible(selector) || undefined, ms, label);
  const countdown = async () => String(await rp.evaluate(panel, 'document.querySelector(".error-card:not(.is-retired) .error-card-countdown [aria-hidden]")?.textContent ?? ""'));
  const userBubbles = (ask: string) => rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].filter(el => el.textContent.includes(${JSON.stringify(ask)})).length`);
  const lastReceipt = async () => String(await rp.evaluate(panel, '[...document.querySelectorAll(".error-receipt")].at(-1)?.textContent ?? ""'));
  const idle = () => until(async () => await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping") && !document.querySelector(".error-card.is-recovering")') || undefined, 60_000, "sidebar idle");
  const requestsSince = (at: number) => gate.filter(g => g.at > at).length;

  const send = async (ask: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
  };

  // 甲：Kimi 403 同时请求数超限 → 不点按钮，倒计时自己走、自己重试两次后成功。
  evidence.stage = "kimi";
  const stopRecording = await recordScreen(rp.cdp, panel, join(artifacts, "countdown.mp4"));
  failNext = { reply: KIMI_403, count: 6 };
  await send(CASES.kimi.ask);
  await until(async () => /第 1 次，共 3 次/.test(await countdown()) || undefined, 60_000, "甲：第 1 次倒计时自己出现");
  const firstCardAt = Date.now();
  const first = await countdown();
  evidence.kimiFirst = first;
  assert.match(first, /^\d+ 秒后自动重试（第 1 次，共 3 次）$/, "甲：倒计时写明秒数和第几次");
  assert.equal(await visible(".error-card .error-card-wait"), true, "甲：有细进度条");
  evidence.kimiA11y = await rp.evaluate(panel, `(() => { const line = document.querySelector(".error-card .error-card-countdown"); return { live: line?.getAttribute("aria-live") ?? null, alertLive: line?.closest("[aria-live]") ? true : false, spoken: line?.querySelector(".error-card-announce")?.textContent ?? null }; })()`);
  assert.deepEqual(evidence.kimiA11y, { live: null, alertLive: false, spoken: "稍后自动重试，第 1 次，共 3 次。" }, "甲：读屏只念一句不变的话");
  assert.equal(await visible('.error-card [data-act="retry-now"]'), true, "甲：有「立即重试」");
  assert.equal(await visible('.error-card [data-act="pick-model"]'), true, "甲：有「换一个模型」");
  assert.equal(await visible('.error-card [data-act="fix-key"]'), false, "甲：Kimi 403 不被当成 key 无效");
  assert.equal(await visible('.error-card [data-act="later"]'), false, "甲：不要用户点「稍后重试」");
  await sleep(1_500);
  await rp.screenshot(panel, join(artifacts, "kimi-countdown.png"));
  await until(async () => requestsSince(firstCardAt) > 0 || undefined, 15_000, "甲：到点自己重试");
  evidence.kimiFirstWaitMs = gate.find(g => g.at > firstCardAt)!.at - firstCardAt;
  assert.ok((evidence.kimiFirstWaitMs as number) >= 5_000, `甲：第 1 次等了约 8 秒（${evidence.kimiFirstWaitMs} ms）`);
  await until(async () => /第 2 次，共 3 次/.test(await countdown()) || undefined, 20_000, "甲：再失败后同一张卡写第 2 次");
  const second = await countdown();
  evidence.kimiSecond = second;
  assert.ok(Number(second.match(/^\d+/)?.[0]) >= 12, `甲：第 2 次等得更久（${second}）`);
  assert.equal(await rp.evaluate(panel, 'document.querySelectorAll(".error-card").length'), 1, "甲：再失败不叠第二张卡");
  await rp.screenshot(panel, join(artifacts, "kimi-second.png"));
  await until(async () => (await text()).includes(CASES.kimi.answer) || undefined, 40_000, "甲：答案自己出现");
  await until(async () => /出过错.*自动重试.*从出错处继续/.test(await lastReceipt()) || undefined, 10_000, "甲：回执");
  assert.equal(await userBubbles(CASES.kimi.ask), 1, "甲：用户只发过一次");
  assert.equal(await visible(".error-card"), false, "甲：恢复后错误卡不再可见");
  await sleep(800);
  await rp.screenshot(panel, join(artifacts, "kimi-final.png"));
  await stopRecording();
  await idle();

  // 乙：429 → 点「立即重试」，不等倒计时。
  evidence.stage = "now";
  failNext = { reply: RATE_429, count: 3 };
  await send(CASES.now.ask);
  await until(async () => /第 1 次/.test(await countdown()) || undefined, 60_000, "乙：倒计时");
  const clickedAt = Date.now();
  await rp.click(panel, '.error-card [data-act="retry-now"]');
  await until(async () => requestsSince(clickedAt) > 0 || undefined, 2_000, "乙：2 秒内门口收到重试");
  await until(async () => (await text()).includes(CASES.now.answer) || undefined, 30_000, "乙：答案出现");
  await until(async () => /出过错.*重试.*从出错处继续/.test(await lastReceipt()) || undefined, 10_000, "乙：回执");
  await idle();

  // 丙：倒计时中发新消息 → 旧卡停下，不替旧任务重试。
  evidence.stage = "supersede";
  failNext = { reply: RATE_429, count: 3 };
  await send(CASES.old.ask);
  await until(async () => /第 1 次/.test(await countdown()) || undefined, 60_000, "丙：倒计时");
  const oldDueAt = Date.now() + Number((await countdown()).match(/^\d+/)?.[0]) * 1000;
  failNext = null;
  await send(CASES.fresh.ask);
  await until(async () => (await text()).includes(CASES.fresh.answer) || undefined, 30_000, "丙：新消息答完");
  await idle();
  const afterFresh = Date.now();
  await sleep(Math.max(0, oldDueAt - afterFresh) + 3_000);
  evidence.supersedeLateRequests = requestsSince(afterFresh);
  assert.equal(evidence.supersedeLateRequests, 0, "丙：过了原来的到点时间，旧任务没有自己重试");
  assert.ok(!(await text()).includes(CASES.old.answer), "丙：旧任务的答案没有出现");
  assert.match(String(await rp.evaluate(panel, '[...document.querySelectorAll(".error-card.is-retired .error-card-countdown")].at(-1)?.textContent ?? ""')), /不再自动重试/, "丙：旧卡写明不再自动重试");
  assert.equal(await visible(".error-card.is-retired .error-card-wait"), false, "丙：旧卡没有进度条");

  // 丁：一直 429 → 连点 3 次「立即重试」都失败，卡回到手动按钮。
  evidence.stage = "exhaust";
  failNext = { reply: RATE_429, count: Infinity };
  await send(CASES.exhaust.ask);

  for (const k of [1, 2, 3]) {
    await until(async () => new RegExp(`第 ${k} 次，共 3 次`).test(await countdown()) || undefined, 60_000, `丁：第 ${k} 次倒计时`);
    await rp.click(panel, '.error-card:not(.is-retired) [data-act="retry-now"]');
    await until(async () => !(await countdown()) || undefined, 5_000, `丁：第 ${k} 次立即重试`);
  }

  await waitFor('.error-card:not(.is-retired) [data-act="later"]', "丁：3 次后回到手动按钮");
  await sleep(600);
  assert.equal(await visible(".error-card:not(.is-retired) .error-card-wait"), false, "丁：3 次后没有进度条");
  assert.equal(await countdown(), "", "丁：3 次后没有倒计时");
  assert.equal(await visible('.error-card:not(.is-retired) [data-act="pick-model"]'), true, "丁：仍能换模型");
  await rp.screenshot(panel, join(artifacts, "exhausted.png"));
  failNext = null;
  const laterAt = Date.now();
  await rp.click(panel, '.error-card:not(.is-retired) [data-act="later"]');
  await until(async () => /秒后自动重试/.test(String(await rp.evaluate(panel, `document.querySelector('.error-card:not(.is-retired) [data-act="later"]')?.textContent ?? ""`))) || undefined, 3_000, "丁：「稍后重试」开始倒计时");
  await until(async () => (await text()).includes(CASES.exhaust.answer) || undefined, 40_000, "丁：稍后重试后答案出现");
  evidence.laterWaitMs = gate.find(g => g.at > laterAt)!.at - laterAt;
  assert.ok((evidence.laterWaitMs as number) >= 6_000, `丁：「稍后重试」等了约 8 秒（${evidence.laterWaitMs} ms）`);
  await until(async () => /出过错.*重试.*从出错处继续/.test(await lastReceipt()) || undefined, 10_000, "丁：回执");
  await idle();

  // 戊：429 额度用完 → 没有倒计时，不自己重试。
  evidence.stage = "quota";
  failNext = { reply: QUOTA_429, count: Infinity };
  await send(CASES.quota.ask);
  // 丁的手动卡要等新一轮开始才作废，所以按标题认出额度卡，而不是只看「稍后重试」。
  await until(async () => /额度/.test(String(await rp.evaluate(panel, 'document.querySelector(".error-card:not(.is-retired) strong")?.textContent ?? ""'))) || undefined, 60_000, "戊：额度卡");
  const quotaAt = Date.now();
  assert.equal(await countdown(), "", "戊：额度用完没有倒计时");
  assert.equal(await visible(".error-card:not(.is-retired) .error-card-wait"), false, "戊：额度用完没有进度条");
  assert.equal(await visible('.error-card:not(.is-retired) [data-act="later"]'), true, "戊：保留手动的「稍后重试」");
  assert.equal(await visible('.error-card:not(.is-retired) [data-act="pick-model"]'), true, "戊：保留「换一个模型」");
  await rp.screenshot(panel, join(artifacts, "quota-card.png"));
  await sleep(12_000);
  evidence.quotaLateRequests = requestsSince(quotaAt);
  assert.equal(evidence.quotaLateRequests, 0, "戊：12 秒内没有自己重试");

  // 己：倒计时中重开侧栏 → 回放出来的卡不倒计时，不替用户重试。
  evidence.stage = "replay";
  failNext = { reply: RATE_429, count: Infinity };
  await send(CASES.replay.ask);
  await until(async () => /第 1 次/.test(await countdown()) || undefined, 60_000, "己：重开前在倒计时");
  await rp.cdp.send("Page.reload", {}, panel);
  const reloadAt = Date.now();
  await until(async () => await rp.evaluate(panel, `(() => { const card = [...document.querySelectorAll(".error-card:not(.is-retired)")].at(-1); return !!card && !!card.querySelector('[data-act="later"]') && (document.querySelector("#messages")?.textContent ?? "").includes(${JSON.stringify(CASES.replay.ask)}); })()`) || undefined, 30_000, "己：重开后回放出手动卡");
  await sleep(600);
  assert.equal(await countdown(), "", "己：回放的卡没有倒计时");
  assert.equal(await visible(".error-card .error-card-wait"), false, "己：回放的卡没有进度条");
  assert.ok(!(await text()).includes("不再自动重试"), "己：回放的卡不写「不再自动重试」");
  await rp.screenshot(panel, join(artifacts, "replay-card.png"));
  await sleep(Math.max(0, reloadAt + 15_000 - Date.now()));
  evidence.replayLateRequests = requestsSince(reloadAt);
  assert.equal(evidence.replayLateRequests, 0, "己：重开后 15 秒内没有自己重试");

  // 庚：第二个窗口再开一个侧栏页，两个侧栏都收到同一次出错。
  evidence.stage = "twin";
  failNext = null;
  const extensionId = String(await rp.evaluate(panel, "chrome.runtime.id"));
  const twinTarget = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/sidepanel.html`, newWindow: true })).targetId;
  const twin = await rp.attach(twinTarget);
  await until(async () => await rp.evaluate(twin, `(document.querySelector("#messages")?.textContent ?? "").includes(${JSON.stringify(CASES.replay.ask)})`) || undefined, 30_000, "庚：第二个侧栏显示同一会话");
  const twinCountdown = async () => String(await rp.evaluate(twin, 'document.querySelector(".error-card:not(.is-retired) .error-card-countdown [aria-hidden]")?.textContent ?? ""'));
  failNext = { reply: RATE_429, count: 3 };
  await send(CASES.twin.ask);
  await until(async () => /第 1 次/.test(await countdown()) || undefined, 60_000, "庚：第一个侧栏倒计时");
  await until(async () => await rp.evaluate(twin, `(() => { const card = [...document.querySelectorAll(".error-card:not(.is-retired)")].at(-1); return !!card?.querySelector('[data-act="later"]') && (document.querySelector("#messages")?.textContent ?? "").includes(${JSON.stringify(CASES.twin.ask)}); })()`) || undefined, 10_000, "庚：第二个侧栏只给手动按钮");
  assert.equal(await twinCountdown(), "", "庚：第二个侧栏没有倒计时");
  await rp.screenshot(twin, join(artifacts, "twin-manual.png"));
  await until(async () => (await text()).includes(CASES.twin.answer) || undefined, 40_000, "庚：答案出现");
  await until(async () => String(await rp.evaluate(twin, 'document.querySelector("#messages")?.textContent ?? ""')).includes(CASES.twin.answer) || undefined, 10_000, "庚：第二个侧栏也看到答案");
  await sleep(12_000);
  evidence.twinGate = gate.slice(-4).map(g => g.result);
  const notices = `${await text()}${String(await rp.evaluate(twin, 'document.querySelector("#messages")?.textContent ?? ""'))}`;
  assert.ok(!notices.includes("没有要接着做的出错任务"), "庚：两边都没有「没有要接着做的出错任务」");
  await rp.cdp.send("Target.closeTarget", { targetId: twinTarget }).catch(() => {});

  evidence.stage = "done";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) {
    evidence.messages = await rp.evaluate(panel, '[...document.querySelectorAll("#messages > *")].map(el => `${el.className}: ${el.textContent.slice(0, 80)}`)').catch(() => null);
    await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
  }
} finally {
  evidence.gate = gate.map(g => g.result);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  front.closeAllConnections();
  front.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
