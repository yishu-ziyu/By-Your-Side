/**
 * 长会话分章节（docs/evals/20261015-conversation-chapters.md）：只装扩展的隔离无头 Chrome、真侧栏、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/conversation-chapters.mts --headless
 * 路径：空闲时发第一件事 → 做完发第二件（模型慢慢答）→ 第二件还在做时插一句补充 → 做完发第三件 →
 *   点顶部的「1」→ 重新打开侧栏。
 * 判据只看侧栏里用户看得到的东西：分隔线的编号和名字、插话上方没有分隔线、满 3 章才有顶部一排、
 *   顶部一排不压住消息、点「1」后第一章的分隔线在对话区里看得见、重新打开后章节一样。
 * 失败方式：章节不画（noteUserTurn 直接返回），第一件做完时就判失败：找不到第一章的分隔线。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-conversation-chapters`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>练习页</title></head><body><main><h1>练习页</h1><p>耳机、摘要和天气。</p></main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

/** 回答写长一点，让对话区要滚动才看得到第一章。 */
const long = (tag: string) => Array.from({ length: 8 }, (_, i) => `${tag}第 ${i + 1} 条：这里是一段足够长的说明文字，用来把对话撑高。`).join("\n\n");

const TASKS = [
  { ask: "第一件：比较三家耳机的价格并整理成表格", name: "第一件：比较三家耳机的价格…", answer: `${long("耳机")}\n\n【一完成】` },
  { ask: "第二件：把这页的要点写成三条摘要发给我", name: "第二件：把这页的要点写成三…", answer: `${long("摘要")}\n\n【二完成】` },
  { ask: "第三件：查明天上海天气", name: "第三件：查明天上海天气", answer: `${long("天气")}\n\n【三完成】` },
];

const STEER = { ask: "补充一句：摘要语气轻松一点", answer: "好的，摘要语气放轻松。【插话完成】" };

const model = await startScriptedModel([
  { match: TASKS[0]!.ask, steps: [{ text: TASKS[0]!.answer }] },
  // 第二件慢慢答，留出插话的时间。
  { match: TASKS[1]!.ask, steps: [{ text: TASKS[1]!.answer, delayMs: 6_000 }] },
  { match: STEER.ask, steps: [{ text: STEER.answer }] },
  { match: TASKS[2]!.ask, steps: [{ text: TASKS[2]!.answer }] },
]);

/** 用户看得到的章节：分隔线文字（看不见的记 null）、哪条用户消息上方有分隔线、顶部一排的按钮、它和对话区的位置。 */
const CHAPTERS_JS = `(() => {
  const vis = el => !!el && el.getClientRects().length > 0;
  const msgs = document.querySelector("#messages");
  const dividers = [...msgs.querySelectorAll(":scope > .chapter-divider")];
  const users = [...msgs.querySelectorAll(":scope > .msg.user")];
  const row = document.querySelector(".chapter-row");
  const rowRect = vis(row) ? row.getBoundingClientRect() : null;
  const msgRect = msgs.getBoundingClientRect();
  return {
    dividers: dividers.map(d => vis(d) ? d.innerText.trim() : null),
    usersWithDivider: users.map(u => ({ text: u.innerText.trim().slice(0, 30), divider: !!u.previousElementSibling?.matches(".chapter-divider") })),
    row: vis(row) ? [...row.querySelectorAll("button")].filter(vis).map(b => b.innerText.trim()) : null,
    rowCoversMessages: rowRect ? rowRect.bottom > msgRect.top + 0.5 : false,
    scrollable: msgs.scrollHeight > msgs.clientHeight + 40,
  };
})()`;

type Chapters = { dividers: Array<string | null>; usersWithDivider: Array<{ text: string; divider: boolean }>; row: string[] | null; rowCoversMessages: boolean; scrollable: boolean };

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
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const idle = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector("#send-btn")?.classList.contains("stopping")';
  const settled = () => until(async () => await rp.evaluate(panel, idle) || undefined, 60_000, "turn settled", 100);
  const read = async () => await rp.evaluate(panel, CHAPTERS_JS) as Chapters;
  const say = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const answered = (mark: string) => until(async () => (await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.includes(${JSON.stringify(mark)})`)) || undefined, 60_000, `answer ${mark}`, 100);

  // 第一件。
  await say(TASKS[0]!.ask);
  await answered("【一完成】");
  await settled();
  const one = await read();
  evidence.afterOne = one;

  // 第二件，做到一半插一句。
  await say(TASKS[1]!.ask);
  await until(async () => await rp.evaluate(panel, `!(${idle})`) || undefined, 15_000, "second task running", 100);
  await sleep(800);
  await say(STEER.ask);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(u => u.innerText.includes(${JSON.stringify(STEER.ask)}))`)) || undefined, 15_000, "steer bubble shown", 100);
  await settled();
  await sleep(500);
  const two = await read();
  evidence.afterTwo = two;
  await rp.screenshot(panel, join(artifacts, "two-chapters.png"));

  // 第三件。
  await say(TASKS[2]!.ask);
  await answered("【三完成】");
  await settled();
  await sleep(500);
  const three = await read();
  evidence.afterThree = three;
  await rp.screenshot(panel, join(artifacts, "three-chapters-bottom.png"));

  const divider = (i: number) => `${i + 1} · ${TASKS[i]!.name}`;
  const button = (i: number) => `${i + 1} ${TASKS[i]!.name}`;

  assert.deepEqual(one.dividers, [null], `one chapter: its divider is not drawn: ${JSON.stringify(one)}`);
  assert.equal(one.row, null, `one chapter: no top row: ${JSON.stringify(one)}`);
  assert.deepEqual(two.dividers, [divider(0), divider(1)], `two chapters: both dividers show number and name: ${JSON.stringify(two)}`);
  const steerTurn = two.usersWithDivider.find(u => u.text.includes(STEER.ask));
  assert.ok(steerTurn && !steerTurn.divider, `the steer sent during a running task has no divider: ${JSON.stringify(two.usersWithDivider)}`);
  assert.equal(two.row, null, `two chapters: no top row: ${JSON.stringify(two)}`);
  assert.deepEqual(three.dividers, [divider(0), divider(1), divider(2)], `three chapters: dividers: ${JSON.stringify(three)}`);
  assert.deepEqual(three.row, [button(0), button(1), button(2)], `three chapters: top row: ${JSON.stringify(three)}`);
  assert.ok(!three.rowCoversMessages, `the top row does not cover the message list: ${JSON.stringify(three)}`);
  assert.ok(three.scrollable, `precondition — the conversation is long enough to scroll: ${JSON.stringify(three)}`);

  // 点「1」：第一章的分隔线在对话区里看得见。
  const firstInView = `(() => { const m = document.querySelector("#messages").getBoundingClientRect(); const d = document.querySelector("#messages > .chapter-divider").getBoundingClientRect(); return d.top >= m.top - 0.5 && d.bottom <= m.bottom + 0.5; })()`;
  assert.equal(await rp.evaluate(panel, firstInView), false, "precondition — chapter 1 is out of view at the bottom of the conversation");
  await rp.click(panel, ".chapter-row button:first-child");
  await until(async () => await rp.evaluate(panel, firstInView) || undefined, 3_000, "chapter 1 divider scrolled into view", 100);
  await sleep(600);
  evidence.afterJump = await rp.evaluate(panel, firstInView);
  await rp.screenshot(panel, join(artifacts, "jumped-to-chapter-1.png"));

  // 重新打开侧栏：同样的章节。
  await rp.evaluate(panel, "location.reload()").catch(() => {});
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.includes("【三完成】")`).catch(() => false)) || undefined, 30_000, "history restored", 200);
  await sleep(1_000);
  const restored = await read();
  evidence.restored = restored;
  await rp.screenshot(panel, join(artifacts, "after-reopen.png"));
  assert.deepEqual({ dividers: restored.dividers, row: restored.row, users: restored.usersWithDivider }, { dividers: three.dividers, row: three.row, users: three.usersWithDivider }, `reopened: same chapters: ${JSON.stringify(restored)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (panelForDump) await writeFile(join(artifacts, "messages.html"), String(await rp.evaluate(panelForDump, 'document.querySelector("#messages")?.outerHTML ?? ""').catch(() => ""))).catch(() => {});
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", evidence, requests: model.requests, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
