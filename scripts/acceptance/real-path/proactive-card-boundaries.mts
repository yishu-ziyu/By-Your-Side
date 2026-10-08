/** YIS-106 未跑边界：忙时、agent 离线、后台重启后按同一张卡。
 * npx tsx scripts/acceptance/real-path/proactive-card-boundaries.mts --headless
 * 真读页生成卡，真 CDP 点击；只替换模型。关闭 offscreen/回收 worker 是真实故障，不伪造连接或 UI 事件。
 * 裁判：卡 ID、session 存储、用户轮次、模型请求及练习站请求计数。产物 summary.json + 截图。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-proactive-card-boundaries`);
await mkdir(out, { recursive: true });
let actions = 0;
const title = "边界验收订单确认邮件";
const body = "全季酒店 北京国贸店，入住已确认，退房时间 12:00，可向前台申请晚退房。".repeat(12);
const site = createServer((req, res) => {
  if (req.url === "/act") actions++;
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>${title}</title><article>${body}</article><div style="height:3000px"></div>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const BUSY = "边界验收慢任务";
const TASK = "边界验收办理晚退房";
const DONE = "已完成边界验收办理晚退房。退房时间已核对为 12:00。需要再改时间可以告诉我。";
const model = await startScriptedModel([
  { match: '"lastReply":', steps: [{ text: JSON.stringify({ status: "done" }) }] },
  { match: TASK, steps: [
    { tool: { name: "tabs", args: { action: "open", url: `${origin}/act` } } },
    { text: DONE },
  ] },
  { match: BUSY, steps: [{ text: "边界验收慢任务已完成。", delayMs: 12_000 }] },
  { match: title, steps: [{ text: JSON.stringify({ offer: true, actionLabel: "申请", sentence: "晚退房到 14:00", party: "全季酒店 北京国贸店", evidence: [{ text: "退房时间 12:00", url: `${origin}/offer` }], prompt: TASK }) }] },
]);
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;
let crashing = false;
let crashLoop: Promise<void> | undefined;
const STATE = `chrome.storage.session.get('sideagent_nudge_panel').then(s => ({
  connected: !!document.querySelector('#status-dot.on'), running: !!document.querySelector('#send-btn.stopping'),
  cardId: document.querySelector('#messages .pc')?.dataset.nudgeId ?? null,
  failure: document.querySelector('#messages .pc .pc-fail')?.textContent ?? '',
  storedId: s.sideagent_nudge_panel?.card.id ?? null,
  turns: document.querySelectorAll('#messages .card-turn').length,
  users: document.querySelectorAll('#messages .msg.user').length,
  pressed: !!document.querySelector('#messages .pc .pc-verb.pressed'),
  transcript: document.querySelector('#messages')?.textContent ?? ''
}))`;
try {
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { sideagent_nudge: true, inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector('#app')?.classList.contains('starter-ready') && !!document.querySelector('#status-dot.on')") || undefined, 60_000, "侧栏就绪");
  const tab = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "练习站标签页");
  const work = await rp.attach(tab.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/offer` }, work);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await sleep(2000);
  await rp.evaluate(work, "window.scrollBy(0,400), true");
  const before = await until(async () => { const s = await rp.evaluate(panel, STATE); return s.cardId ? s : undefined; }, 60_000, "真实停留后出卡", 500);
  const cardId = before.cardId;
  evidence.before = before;
  await rp.screenshot(panel, join(out, "1-card.png"));

  // 忙时：按两次都不成为当前任务的补充，不产生办理请求，卡和意图保留。
  await rp.click(panel, "#input");
  await rp.typeText(panel, BUSY);
  await rp.pressEnter(panel);
  await until(async () => { const s = await rp.evaluate(panel, STATE); return s.running && model.requests.some(r => r.rule === BUSY && r.tools) ? s : undefined; }, 10_000, "慢任务已交给模型");
  for (let i = 0; i < 2; i++) {
    await rp.click(panel, "#messages .pc .pc-verb");
    const busy = await until(async () => { const s = await rp.evaluate(panel, STATE); return s.failure.includes("助手正在做别的事，做完再按") && !s.pressed ? s : undefined; }, 3000, "忙时说明");
    assert.equal(busy.cardId, cardId); assert.equal(busy.storedId, cardId);
    assert.equal(busy.turns, 0); assert.equal(busy.users, 1);
    evidence[`busy-${i + 1}`] = busy;
  }
  assert.equal(actions, 0);
  assert.equal(model.requests.filter(r => r.rule === TASK && r.tools).length, 0, "按忙时卡不发出办理任务");
  await rp.screenshot(panel, join(out, "2-busy.png"));
  await until(async () => { const s = await rp.evaluate(panel, STATE); return !s.running && s.transcript.includes("慢任务已完成") ? s : undefined; }, 30_000, "慢任务结束");

  // 离线：反复关闭真实 offscreen 文档，维持故障窗口；后台和侧栏仍使用真实连接。
  crashing = true;
  let crashes = 0;
  crashLoop = (async () => {
    while (crashing) {
      const doc = (await rp.targets()).find(t => t.url === `chrome-extension://${rp.extensionId}/inproc.html`);
      if (doc) { await rp.cdp.send("Target.closeTarget", { targetId: doc.targetId }); crashes++; }
      await sleep(80);
    }
  })();
  await until(async () => { const s = await rp.evaluate(panel, STATE); return crashes > 0 && !s.connected ? s : undefined; }, 15_000, "真实 agent 断开", 50);
  await rp.click(panel, "#messages .pc .pc-verb");
  const offline = await until(async () => { const s = await rp.evaluate(panel, STATE); return s.failure.includes("助手没连上") && !s.pressed ? s : undefined; }, 5000, "未连接失败说明", 50);
  evidence.offline = { ...offline, crashes };
  assert.equal(offline.cardId, cardId); assert.equal(offline.storedId, cardId);
  assert.equal(offline.turns, 0); assert.equal(offline.users, 1); assert.equal(actions, 0);
  assert.equal(model.requests.filter(r => r.rule === TASK && r.tools).length, 0);
  await rp.screenshot(panel, join(out, "3-offline.png"));
  crashing = false;
  await crashLoop;
  await until(async () => { const s = await rp.evaluate(panel, STATE); return s.connected ? s : undefined; }, 45_000, "真实 agent 恢复");

  // 只重启后台，不重启浏览器（session 存储的契约不包括整个浏览器退出）。
  const oldWorker = await rp.serviceWorker();
  assert.ok(oldWorker, "后台重启前存在真实 worker");
  await rp.cdp.send("ServiceWorker.enable", {}, work);
  await rp.cdp.send("ServiceWorker.stopAllWorkers", {}, work);
  const newWorker = await until(async () => { const w = await rp.serviceWorker(); return w && w.targetId !== oldWorker.targetId ? w : undefined; }, 30_000, "真实后台目标已更换", 100);
  const restarted = await until(async () => { const s = await rp.evaluate(panel, STATE); return s.connected && s.cardId === cardId && s.storedId === cardId ? s : undefined; }, 30_000, "旧卡跨后台重启保留");
  evidence.restart = { oldWorker: oldWorker.targetId, newWorker: newWorker.targetId, state: restarted };
  await rp.click(panel, "#messages .pc .pc-verb");
  const done = await until(async () => { const s = await rp.evaluate(panel, STATE); return !s.running && s.turns === 1 && s.transcript.includes(DONE) ? s : undefined; }, 45_000, "旧卡办理完成");
  assert.equal(actions, 1, "旧卡办理的真实站点请求恰好一次");
  assert.equal(done.users, 2); assert.equal(done.cardId, null); assert.equal(done.storedId, null);
  const turnId = await rp.evaluate(panel, "document.querySelector('#messages .card-turn .pc-obj')?.textContent");
  assert.ok(String(turnId).includes("晚退房到 14:00"), "办理仍回应旧卡意图");
  evidence.done = done;
  await rp.screenshot(panel, join(out, "4-restarted-done.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  crashing = false;
  await crashLoop?.catch(e => { error ??= String(e); });
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", error, actions, evidence, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
  site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
