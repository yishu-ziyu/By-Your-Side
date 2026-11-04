import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-stop-during-prep`);

await mkdir(artifacts, { recursive: true });

const SWEEP = 36;

const sentence = (i: number) => `停止测试第${i}句`;

const answer = (i: number) => `第${i}句的回答。`;

const CALIBRATE = ["停止测试校准甲", "停止测试校准乙"];

const LAST = "停止测试收尾";

const rules: Rule[] = [
  ...CALIBRATE.map(match => ({ match, steps: [{ text: `${match}的回答。` }] })),
  { match: LAST, steps: [{ text: "收尾的回答。" }] },
  ...Array.from({ length: SWEEP }, (_, i) => ({ match: sentence(i), steps: [{ text: answer(i), delayMs: 1_500 }] })),
];

const modelOrigin = Date.now();

const model = await startScriptedModel(rules);

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>一页短文</title><h1>一页短文</h1><p>只有一段话。</p>");
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

type Round = { i: number; delayMs: number; stopAt: number; answered: boolean; requested: boolean; finishedAfterStop: boolean; leaked: boolean; inPrep?: boolean };

const evidence: { latencyMs?: number[]; rounds?: Round[]; notices?: string[]; lastAnswered?: boolean; prepStops?: number; panelOnFailure?: string } = {};

let panelForFailure: string | undefined;

const PREP_STOPS = `new Promise((ok, fail) => {
  const open = indexedDB.open("sideagent-diagnostics");
  open.onerror = () => fail(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("trace-lines")) { db.close(); ok("[]"); return; }
    const all = db.transaction("trace-lines").objectStore("trace-lines").getAll();
    all.onerror = () => fail(all.error);
    all.onsuccess = () => {
      db.close();
      ok(JSON.stringify(all.result.map(row => JSON.parse(row.line)).filter(t => t.type === "session_error" && t.data?.error?.name === "RunNotStarted").map(t => Date.parse(t.time))));
    };
  };
})`;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/short` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  panelForFailure = panel;

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏可发送");

  const panelText = 'JSON.stringify({ answers: [...document.querySelectorAll("#messages .msg.assistant")].map(el => el.innerText.trim()), notices: [...document.querySelectorAll("#messages .msg.notice")].map(el => el.innerText.trim()) })';
  // SAFETY: panelText 只返回两个字符串数组。
  const read = async () => JSON.parse(String(await rp.evaluate(panel, panelText))) as { answers: string[]; notices: string[] };
  const stopping = async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping") === true') === true;
  const idle = async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#send-btn").classList.contains("stopping")') === true;

  const send = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
  };

  const waitStopping = async (label: string) => {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      if (await stopping()) return Date.now();
    }

    throw new Error(`${label}：停止键没出现`);
  };

  const requestOf = (match: string) => model.requests.find(r => r.rule === match && r.tools);

  for (const match of CALIBRATE) {
    await send(match);
    const shownAt = await waitStopping(match);
    await until(async () => (await read()).answers.some(t => t.includes(`${match}的回答`)) || undefined, 20_000, `${match}：回答`);
    const request = requestOf(match);
    assert.ok(request, `${match}：模型收到了请求`);
    (evidence.latencyMs ??= []).push(modelOrigin + request.atMs - shownAt);
    await until(async () => (await idle()) || undefined, 10_000, `${match}：回到空闲`);
  }

  const span = Math.max(40, ...evidence.latencyMs!);
  evidence.rounds = [];

  for (let i = 0; i < SWEEP; i += 1) {
    const delayMs = Math.round((span * i) / (SWEEP - 1));
    await send(sentence(i));
    await waitStopping(sentence(i));
    await sleep(delayMs);
    const stopAt = Date.now();
    await rp.click(panel, "#send-btn");
    await sleep(3_000);
    const request = requestOf(sentence(i));
    const answered = (await read()).answers.some(t => t.includes(answer(i)));
    const finishedAt = request?.finished ? request.closedAt : undefined;
    const finishedAfterStop = finishedAt !== undefined && finishedAt > stopAt;
    const leaked = finishedAfterStop || (answered && !(finishedAt !== undefined && finishedAt <= stopAt));
    evidence.rounds.push({ i, delayMs, stopAt, answered, requested: !!request, finishedAfterStop, leaked });
    await until(async () => (await idle()) || undefined, 10_000, `${sentence(i)}：停下后回到空闲`);
  }

  await rp.screenshot(panel, join(artifacts, "after-sweep.png"));
  await send(LAST);
  await until(async () => (await read()).answers.some(t => t.includes("收尾的回答")) || undefined, 20_000, "收尾：不停的一句照常回答");
  evidence.lastAnswered = true;
  evidence.notices = (await read()).notices;
  await rp.screenshot(panel, join(artifacts, "last.png"));

  // SAFETY: PREP_STOPS 只返回毫秒数数组。
  const prepStops = JSON.parse(String(await rp.evaluate(panel, PREP_STOPS))) as number[];
  evidence.prepStops = prepStops.length;
  const rounds = evidence.rounds;

  for (const at of prepStops) {
    const round = rounds.findLast(r => r.stopAt <= at);

    if (round) round.inPrep = true;
  }

  assert.deepEqual(rounds.filter(r => r.leaked), [], "点了停止之后，模型没有再答完这一句，侧栏也不出现它的回答");
  assert.ok(prepStops.length > 0, "至少有一次停在了开工准备里；一次都没有说明这次没测到");
  assert.deepEqual(rounds.filter(r => r.inPrep && r.requested), [], "停在准备里的那几次，模型一个请求都没收到");
  assert.ok(!evidence.notices.some(t => /还在执行|正在执行/.test(t)), `没有因为上一轮还在跑而拒绝新消息（${JSON.stringify(evidence.notices)}）`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panelForFailure) {
    await rp.screenshot(panelForFailure, join(artifacts, "failure.png")).catch(() => {});
    evidence.panelOnFailure = String(await rp.evaluate(panelForFailure, 'document.querySelector("#messages")?.innerText.slice(-1500) ?? ""').catch(() => ""));
  }
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

const leakedRounds = evidence.rounds?.filter(r => r.leaked).map(r => `${r.i}@${r.delayMs}ms`) ?? [];

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, latencyMs: evidence.latencyMs, requested: evidence.rounds?.filter(r => r.requested).length, prepStops: evidence.prepStops ?? null, leaked: leakedRounds, lastAnswered: evidence.lastAnswered ?? false, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
