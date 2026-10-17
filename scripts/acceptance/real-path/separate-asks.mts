/**
 * 做 A 时打一句另一件事 B：B 另开一条线去做，回答带回当前会话，A 照常做完；补充 A 的话照旧插进 A。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页。判断「补充还是另一件」的快速模型也是脚本，只证明程序这一层。
 *   npx tsx scripts/acceptance/real-path/separate-asks.mts --headless
 * 判据：
 *   a) A 在跑时说 B：B 下面写「另开一件」，出现 B 的卡片，A 仍在跑。
 *   b) B 的回答以「任务名 + 回答」出现在当前会话；A 之后交出自己的回答，两份都在。
 *   c) 重开侧栏后重放：A 的回答和 B 的卡片（含回答）都在，不重复。
 *   d) 再开一件 A2，说补充 C：C 下面仍是「接在当前任务里处理」，不出新卡片，A2 的模型收到 C。
 *   e) A2 在跑时说另一件 D，点「改成补充上一件」：卡片写「已并回上一件」，D 只有一个气泡，A2 的模型收到 D，D 没有交出回答，没有出错。
 * 失败方式：判断一律当补充，a 里看不到「另开一件」和卡片。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-separate-asks`);

await mkdir(artifacts, { recursive: true });

const A = "把这页的论文标题整理成清单";
const B = "顺便帮我查一下明天北京的天气";
const A2 = "把这页的作者整理成名单";
const C = "也加上每位作者的单位";
const D = "另外帮我打开 YouTube";

const slow = (n: number) => Array.from({ length: n }, () => ({ tool: { name: "snapshot", args: {} }, delayMs: 2_000 }));

/** 主模型收到的每次请求里，最后一条用户消息之后、本轮插进来的话（看插话有没有送到 A）。 */
const seen: string[] = [];

const model = await startScriptedModel([
  // 判断「补充还是另一件」：内容里 message 是哪句就回哪种。
  { match: `"message":"${B}"`, steps: [{ text: JSON.stringify({ kind: "separate" }) }] },
  { match: `"message":"${D}"`, steps: [{ text: JSON.stringify({ kind: "separate" }) }] },
  { match: `"message":"${C}"`, steps: [{ text: JSON.stringify({ kind: "supplement" }) }] },
  { match: B, steps: [{ text: "明天北京晴，12–21 度。", delayMs: 1_000 }] },
  { match: D, steps: [{ text: "已打开 YouTube。", delayMs: 15_000 }] },
  { match: C, steps: [...slow(2), { text: "作者名单（含单位）：张三 · 北大。" }] },
  { match: A2, steps: [...slow(12), { text: "作者名单：张三。" }] },
  { match: A, steps: [...slow(5), { text: "论文清单：1. 甲 2. 乙 3. 丙" }] },
], undefined, payload => seen.push(JSON.stringify(payload.messages ?? [])));

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>论文</title><h1>论文列表</h1><p>甲 乙 丙 张三</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

const STATE = `(() => {
  const m = document.querySelector("#messages");
  return {
    notes: [...m.querySelectorAll(".steer-received")].map(e => e.textContent.trim()),
    cards: [...m.querySelectorAll(".separate-ask")].map(e => ({ tag: e.querySelector(".separate-ask-tag")?.textContent ?? "", state: e.querySelector(".separate-ask-state")?.textContent ?? "", answer: e.querySelector(".separate-ask-answer")?.textContent?.trim() ?? "" })),
    answers: [...m.querySelectorAll(".msg.assistant[data-delivery-id]")].map(e => e.innerText.trim().split("\\n")[0]),
    running: !!document.querySelector("#status-pill.running"),
    bubbles: [...m.querySelectorAll(".msg.user")].map(e => e.innerText.trim()),
    errors: [...m.querySelectorAll(".msg.error, .error-card")].map(e => e.innerText.trim()).concat(m.innerText.includes("已自动重试") ? ["已自动重试"] : []),
    banner: (() => { const b = document.querySelector("#conversation-background"); return b && !b.hidden ? b.textContent : ""; })(),
  };
})()`;

type State = { notes: string[]; cards: Array<{ tag: string; state: string; answer: string }>; answers: string[]; bubbles: string[]; errors: string[]; running: boolean; banner: string };

let panel: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/papers` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel!, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  const send = async (text: string) => { await rp.click(panel!, "#input"); await rp.typeText(panel!, text); await rp.pressEnter(panel!); };
  const state = async () => await rp.evaluate(panel!, STATE) as State;

  // a
  await send(A);
  await until(async () => (await state()).running || undefined, 15_000, "A 开始");
  await sleep(2_500);
  await send(B);
  const a = await until(async () => { const s = await state(); return s.cards.length && s.notes.some(n => n.startsWith("另开一件")) ? s : undefined; }, 10_000, "B 另开");
  evidence.a = a;
  assert.ok(a.running, "A is still running after B is split off");

  // b
  const b = await until(async () => { const s = await state(); return s.cards[0]?.answer.includes("明天北京晴") ? s : undefined; }, 30_000, "B 的回答带回");
  evidence.bFirst = { aRunning: b.running, answers: b.answers };
  await rp.screenshot(panel, join(artifacts, "b-answer.png"));
  const done = await until(async () => { const s = await state(); return s.answers.some(t => t.startsWith("论文清单")) && !s.running ? s : undefined; }, 60_000, "A 做完");
  evidence.b = done;
  await rp.screenshot(panel, join(artifacts, "a-done.png"));
  assert.equal(done.cards.length, 1, "one card for B");
  assert.ok(done.cards[0]!.tag.includes("顺便帮我查"), `the card is labelled with B: ${done.cards[0]!.tag}`);
  assert.equal(done.banner, "", `no top banner for B: ${done.banner}`);

  // c
  await rp.evaluate(panel, "location.reload()").catch(() => undefined);
  const c = await until(async () => { const s = await rp.evaluate(panel!, STATE).catch(() => null) as State | null; return s && s.answers.some(t => t.startsWith("论文清单")) && s.cards.length ? s : undefined; }, 30_000, "重开侧栏后重放");
  evidence.c = c;
  assert.equal(c.cards.length, 1, "replay shows B's card once");
  assert.ok(c.cards[0]!.answer.includes("明天北京晴"), "replay keeps B's answer");

  // d
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel!, `document.querySelectorAll('.msg.user').length === 0 && !document.querySelector('#conversation-new').disabled`)) || undefined, 15_000, "新会话");
  await send(A2);
  await until(async () => (await state()).running || undefined, 15_000, "A2 开始");
  await sleep(2_500);
  await send(C);
  await sleep(4_000);
  const d = await state();
  evidence.d = d;
  assert.equal(d.cards.length, 0, "a supplement opens no card");
  assert.ok(d.notes.some(n => n.includes("接在当前任务里处理")), `the supplement stays in the task: ${JSON.stringify(d.notes)}`);

  // e
  await send(D);
  await until(async () => { const s = await state(); return s.cards.length ? s : undefined; }, 10_000, "D 另开");
  assert.ok((await state()).running, "A2 is still running when merging");
  await rp.evaluate(panel, `[...document.querySelectorAll(".separate-ask-actions button")].find(b => b.textContent === "改成补充上一件")?.click()`);
  const merged = await until(async () => { const s = await state(); return s.cards[0]?.state === "已并回上一件" ? s : undefined; }, 8_000, "已并回");
  assert.equal(merged.bubbles.filter(text => text.includes(D)).length, 1, `merging adds no second bubble: ${JSON.stringify(merged.bubbles)}`);
  assert.ok(merged.notes.includes("已收到 · 并回上一件处理"), `D's note says it was merged: ${JSON.stringify(merged.notes)}`);
  const e = await until(async () => { const s = await state(); return s.answers.length >= 1 && !s.running ? s : undefined; }, 60_000, "A2 做完");
  await sleep(17_000);
  const after = await state();
  evidence.e = { ...e, cardsLater: after.cards, dReachedA2: seen.some(text => text.includes(A2) && text.includes(D)) };
  await rp.screenshot(panel, join(artifacts, "merged.png"));
  assert.ok(seen.some(text => text.includes(A2) && text.includes(D)), "A2's model receives D after merging");
  assert.ok(!after.cards.some(card => card.answer.includes("已打开 YouTube")), "the merged-back D does not deliver its own answer");
  assert.equal(after.cards[0]?.state, "已并回上一件", `the merged card keeps its label: ${JSON.stringify(after.cards)}`);
  assert.deepEqual(after.errors, [], `no error after merging: ${JSON.stringify(after.errors)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) evidence.last = await rp.evaluate(panel, STATE).catch(() => null);
} finally {
  if (error) await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "diagnostics")).catch(() => undefined);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }).slice(0, 3000));

if (error) process.exitCode = 1;
