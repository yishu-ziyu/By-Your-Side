/**
 * 长会话分章节：只装扩展的隔离无头 Chrome、真侧栏、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/conversation-chapters.mts --headless
 * 路径：空闲时发第一件事 → 追问一句（只读一次页面再回答）→ 让它记住邮箱（只写记忆）→ 发第二件（模型慢慢答）→
 *   第二件还在做时插一句补充 → 发第三件 → 发第四件，第一次请求模型回 429，点「立即重试」后接着点按钮 →
 *   点顶部的「1」→ 重新打开侧栏。四件事每件都在练习页上点一下按钮再回答。
 * 判据只看侧栏里用户看得到的东西：分隔线的编号和名字；追问、记忆、插话上方没有分隔线；第四件出错时还没有分隔线、
 *   重试后点了按钮才有；满 3 章才有顶部一排、不压住消息；点「1」后第一章的分隔线在对话区里看得见、过一会儿也没被拉回底部；
 *   重新打开后章节一样。
 * 失败方式：只读页面也算动了页面（不按写操作过滤），追问上方就多出一条分隔线。
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
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>练习页</title></head><body><main><h1>练习页</h1><p>耳机、摘要和天气。</p><button id="ok" onclick="this.textContent='已看过'">看一下</button></main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

/** 回答写长一点，让对话区要滚动才看得到第一章。 */
const long = (tag: string) => Array.from({ length: 8 }, (_, i) => `${tag}第 ${i + 1} 条：这里是一段足够长的说明文字，用来把对话撑高。`).join("\n\n");

const TASKS = [
  { ask: "第一件：比较三家耳机的价格并整理成表格", name: "第一件：比较三家耳机的价格…", answer: `${long("耳机")}\n\n【一完成】` },
  { ask: "第二件：把这页的要点写成三条摘要发给我", name: "第二件：把这页的要点写成三…", answer: `${long("摘要")}\n\n【二完成】` },
  { ask: "第三件：查明天上海天气", name: "第三件：查明天上海天气", answer: `${long("天气")}\n\n【三完成】` },
  { ask: "第四件：点一下练习页的按钮", name: "第四件：点一下练习页的按钮", answer: "按钮点过了。【四完成】" },
];

const FOLLOW_UP = { ask: "追问：刚才第二家多少钱？", answer: "第二家 399 元。【追问完成】" };

const MEMORY = { ask: "记住：我常用的邮箱是 demo@example.com", answer: "记下了。【记忆完成】" };

const STEER = { ask: "补充一句：摘要语气轻松一点", answer: "好的，摘要语气放轻松。【插话完成】" };

/** 每件事先在练习页上点一下按钮，再回答。 */
const tool = { tool: { name: "click", args: { target: "#ok" } } };

const model = await startScriptedModel([
  { match: TASKS[0]!.ask, steps: [tool, { text: TASKS[0]!.answer }] },
  // 追问只读页面、记忆只写记忆：都不动页面。
  { match: FOLLOW_UP.ask, steps: [{ tool: { name: "snapshot", args: {} } }, { text: FOLLOW_UP.answer }] },
  { match: MEMORY.ask, steps: [{ tool: { name: "user_memory", args: { action: "change" } } }, { text: MEMORY.answer }] },
  // 第二件慢慢答，留出插话的时间。
  { match: TASKS[1]!.ask, steps: [tool, { text: TASKS[1]!.answer, delayMs: 6_000 }] },
  { match: STEER.ask, steps: [{ text: STEER.answer }] },
  { match: TASKS[2]!.ask, steps: [tool, { text: TASKS[2]!.answer }] },
  { match: TASKS[3]!.ask, steps: [tool, { text: TASKS[3]!.answer }] },
]);

/** 挡在模型前面：接下来几次任务请求（带工具表）回 429。循环自己会先快速重试两次，所以卡上失败一次 = 连回 3 次。 */
let failNext = 0;

const front = createServer(async (req, res) => {
  let body = "";

  req.setEncoding('utf8'); for await (const chunk of req) body += chunk;

  if (failNext > 0 && /"tools"\s*:\s*\[\s*\{/.test(body)) {
    failNext -= 1;
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Rate limit reached, please retry later" } }));

    return;
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));

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
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(front).port}/v1` },
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

  // 追问：读一次页面再回答，不动页面。
  await say(FOLLOW_UP.ask);
  await answered("【追问完成】");
  await settled();
  const followUp = await read();
  evidence.afterFollowUp = followUp;

  // 只写记忆。
  await say(MEMORY.ask);
  await answered("【记忆完成】");
  await settled();
  const memory = await read();
  evidence.afterMemory = memory;

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

  // 第四件：第一次请求出错，重试后才点按钮。
  failNext = 3;
  await say(TASKS[3]!.ask);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector('.error-card [data-act="retry-now"]')?.getClientRects().length`) || undefined, 60_000, "429 error card", 100);
  const errored = await read();
  evidence.afterError = errored;
  await rp.screenshot(panel, join(artifacts, "fourth-error.png"));
  await rp.click(panel, '.error-card [data-act="retry-now"]');
  await answered("【四完成】");
  await settled();
  await sleep(500);
  const four = await read();
  evidence.afterFour = four;
  // 鼠标还停在刚才「立即重试」的位置，会让上一条回答的长短手柄浮出来：挪开再截图。
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }, panel);
  await sleep(400);
  await rp.screenshot(panel, join(artifacts, "four-chapters-bottom.png"));

  const divider = (i: number) => `${i + 1} · ${TASKS[i]!.name}`;
  const button = (i: number) => `${i + 1} ${TASKS[i]!.name}`;

  assert.deepEqual(one.dividers, [null], `one chapter: its divider is not drawn: ${JSON.stringify(one)}`);
  assert.equal(one.row, null, `one chapter: no top row: ${JSON.stringify(one)}`);
  assert.deepEqual(followUp.dividers, [null], `a follow-up that only reads the page joins chapter 1: ${JSON.stringify(followUp)}`);
  assert.deepEqual(memory.dividers, [null], `a turn that only writes memory joins chapter 1: ${JSON.stringify(memory)}`);
  for (const ask of [FOLLOW_UP.ask, MEMORY.ask]) {
    const turn = four.usersWithDivider.find(u => u.text.includes(ask));
    assert.ok(turn && !turn.divider, `no divider above ${ask}: ${JSON.stringify(four.usersWithDivider)}`);
  }
  assert.deepEqual(two.dividers, [divider(0), divider(1)], `two chapters: both dividers show number and name: ${JSON.stringify(two)}`);
  const steerTurn = two.usersWithDivider.find(u => u.text.includes(STEER.ask));
  assert.ok(steerTurn && !steerTurn.divider, `the steer sent during a running task has no divider: ${JSON.stringify(two.usersWithDivider)}`);
  assert.equal(two.row, null, `two chapters: no top row: ${JSON.stringify(two)}`);
  assert.deepEqual(three.dividers, [divider(0), divider(1), divider(2)], `three chapters: dividers: ${JSON.stringify(three)}`);
  assert.deepEqual(three.row, [button(0), button(1), button(2)], `three chapters: top row: ${JSON.stringify(three)}`);
  assert.ok(!three.rowCoversMessages, `the top row does not cover the message list: ${JSON.stringify(three)}`);
  assert.ok(three.scrollable, `precondition — the conversation is long enough to scroll: ${JSON.stringify(three)}`);
  assert.deepEqual(errored.dividers, three.dividers, `the fourth task has no divider while its first request failed: ${JSON.stringify(errored)}`);
  assert.deepEqual(four.dividers, [divider(0), divider(1), divider(2), divider(3)], `the retried fourth task that clicks opens chapter 4: ${JSON.stringify(four)}`);
  assert.deepEqual(four.row, [button(0), button(1), button(2), button(3)], `four chapters: top row: ${JSON.stringify(four)}`);

  const checkDrag = async (label: string) => {
    const position = () => rp.evaluate(panel, `(() => {
      const r = document.querySelector('.chapter-row');
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width - 30, y: b.y + b.height / 2, left: r.scrollLeft,
        overflow: r.scrollWidth - r.clientWidth, top: document.querySelector('#messages').scrollTop };
    })()`) as Promise<{ x: number; y: number; left: number; overflow: number; top: number }>;
    const before = await position();
    assert.ok(before.overflow > 80, 'precondition: chapters overflow the real sidebar');
    assert.equal(await rp.evaluate(panel, `(() => {
      const m = document.querySelector('#messages').getBoundingClientRect();
      const d = document.querySelector('#messages > .chapter-divider').getBoundingClientRect();
      return d.top >= m.top && d.bottom <= m.bottom;
    })()`), false, 'precondition: accidentally opening chapter 1 must visibly move the conversation');
    await rp.screenshot(panel, join(artifacts, `${label}-before-drag.png`));
    await rp.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', buttons: 1, clickCount: 1 }, panel);
    for (let i = 1; i <= 10; i++) {
      await rp.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x - i * 12, y: before.y, button: 'left', buttons: 1 }, panel);
    }
    await rp.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x - 120, y: before.y, button: 'left', buttons: 0, clickCount: 1 }, panel);
    await sleep(400);
    const after = await position();
    assert.ok(after.left > before.left + 60, `${label}: dragging reveals later chapters`);
    assert.ok(Math.abs(after.top - before.top) < 2, `${label}: releasing drag must not jump the conversation`);
    await rp.screenshot(panel, join(artifacts, `${label}-after-drag.png`));
    evidence[label] = { before, after };
    await rp.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x - 160, y: before.y, button: 'left', buttons: 1, clickCount: 1 }, panel);
    for (let i = 1; i <= 10; i++) {
      await rp.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x - 160 + i * 15, y: before.y, button: 'left', buttons: 1 }, panel);
    }
    await rp.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x - 10, y: before.y, button: 'left', buttons: 0, clickCount: 1 }, panel);
    await sleep(400);
    const returned = await position();
    assert.ok(returned.left < 2, `${label}: reverse drag returns to the first chapter`);
    assert.ok(Math.abs(returned.top - before.top) < 2, `${label}: reverse drag must not jump`);
  };
  await checkDrag('live');

  // 点「1」：第一章的分隔线在对话区里看得见。
  const firstInView = `(() => { const m = document.querySelector("#messages").getBoundingClientRect(); const d = document.querySelector("#messages > .chapter-divider").getBoundingClientRect(); return d.top >= m.top - 0.5 && d.bottom <= m.bottom + 0.5; })()`;
  assert.equal(await rp.evaluate(panel, firstInView), false, "precondition — chapter 1 is out of view at the bottom of the conversation");
  await rp.click(panel, ".chapter-row button:first-child");
  await until(async () => await rp.evaluate(panel, firstInView) || undefined, 3_000, "chapter 1 divider scrolled into view", 100);
  await sleep(1_500);
  evidence.afterJump = await rp.evaluate(panel, firstInView);
  assert.equal(evidence.afterJump, true, "chapter 1 stays in view after the jump (not pulled back to the bottom)");
  await rp.screenshot(panel, join(artifacts, "jumped-to-chapter-1.png"));

  // 当场开的章节线带展开动画；重开侧栏从记录重画的不带。
  const freshDividers = `[...document.querySelectorAll("#messages > .chapter-divider")].map((d) => d.classList.contains("fresh"))`;
  evidence.liveFresh = await rp.evaluate(panel, freshDividers);
  assert.ok(evidence.liveFresh.length > 0 && evidence.liveFresh.every(Boolean), `live dividers unfold: ${JSON.stringify(evidence.liveFresh)}`);

  // 重新打开侧栏：同样的章节。
  await rp.evaluate(panel, "location.reload()").catch(() => {});
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.includes("【四完成】")`).catch(() => false)) || undefined, 30_000, "history restored", 200);
  await sleep(1_000);
  const restored = await read();
  evidence.restored = restored;
  await rp.screenshot(panel, join(artifacts, "after-reopen.png"));
  await checkDrag("reopened");
  evidence.replayFresh = await rp.evaluate(panel, freshDividers);
  assert.ok(evidence.replayFresh.every((f: boolean) => !f), `replayed dividers do not animate: ${JSON.stringify(evidence.replayFresh)}`);
  assert.deepEqual({ dividers: restored.dividers, row: restored.row, users: restored.usersWithDivider }, { dividers: four.dividers, row: four.row, users: four.usersWithDivider }, `reopened: same chapters: ${JSON.stringify(restored)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (panelForDump) await writeFile(join(artifacts, "messages.html"), String(await rp.evaluate(panelForDump, 'document.querySelector("#messages")?.outerHTML ?? ""').catch(() => ""))).catch(() => {});
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", evidence, requests: model.requests, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  front.closeAllConnections();
  front.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
