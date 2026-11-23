import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withGuidePage, waitForGuide } from "./guide-multi-interaction.mts";
import { REPO, until } from "./harness.mts";
import { INPROC_PORT_NAME } from "../../../extension/src/inproc/shared.ts";

const id = randomUUID();
const label = "点一下练习按钮";
const html = `<!doctype html><meta charset="utf-8"><title>打断教学练习</title>
  <button id="target">练习按钮</button><output id="count">0</output>
  <script>target.onclick = event => { if (event.isTrusted) count.value = Number(count.value) + 1; };</script>`;

await withGuidePage(html, [], undefined, async ({ rp, page, panel, tabId, readUI }) => {
  const host = (await rp.targets()).find(target => target.url === `chrome-extension://${rp.extensionId}/inproc.html`);
  assert.ok(host, "扩展的工具通道没有启动");
  const offscreen = await rp.attach(host.targetId);
  // WHY: the background opens this port. Reconnect once to drive the voice tool protocol over its real transport while the chat is idle.
  await rp.evaluate(offscreen, `chrome.runtime.onConnect.addListener(port => {
    if (port.name !== ${JSON.stringify(INPROC_PORT_NAME)}) return;
    window.sendGuideFrame = frame => port.postMessage(frame);
    port.onMessage.addListener(frame => {
      if (frame.id !== ${JSON.stringify(id)}) return;
      if (frame.type === "tool_waiting_user" && frame.waiting) window.guideWaiting = true;
      if (frame.type === "tool_result") window.guideResult = frame;
    });
  })`);
  await rp.evaluate(panel, `chrome.runtime.connect({ name: "sideagent-panel" }).postMessage({ kind: "retry" })`);
  await until(async () => await rp.evaluate(offscreen, "typeof window.sendGuideFrame === 'function'"), 15_000, "工具通道连接");
  const send = (frame: object) => rp.evaluate(offscreen, `window.sendGuideFrame(${JSON.stringify({ ...frame, id, conversationId: "default" })})`);
  await rp.cdp.send("Page.bringToFront", {}, page);
  const initial = await readUI();
  assert.equal(initial.pointers.some(p => p.guiding), false, "开始前没有教学光标");
  await send({ type: "tool_call", name: "guide_step", params: { tabId, target: "#target", say: label, step: 1 } });
  await until(async () => {
    const state = await rp.evaluate(offscreen, "window.guideResult || window.guideWaiting");
    if (state && state !== true) throw new Error(`教学提前结束：${JSON.stringify(state)}`);
    return state;
  }, 10_000, "工具等待用户操作");
  await waitForGuide(readUI, label);
  const corner = await rp.evaluate(page, `(() => { const r = document.querySelector("#target").getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 6 }; })()`);
  const shown = await until(async () => {
    const ui = await readUI();
    return ui.pointers.some(p => p.guiding && Math.abs(p.x - corner.x) <= 3 && Math.abs(p.y - corner.y) <= 3) ? ui : null;
  }, 3_000, "教学光标到达按钮", 25);
  const clicks = () => rp.evaluate(page, "document.querySelector('#count').value");
  assert.equal(await clicks(), "0");

  const start = performance.now();
  await send({ type: "tool_cancel" });
  let last = await readUI();
  const clean = () => last.marks === 0 && last.strokes === 0 && last.spotlights === 0 && last.pointers.length === 0;
  while (!clean() && performance.now() - start < 1000) {
    await new Promise(resolve => setTimeout(resolve, 20));
    last = await readUI();
  }
  const elapsed = Math.ceil(performance.now() - start);
  const receipt = await until(async () => await rp.evaluate(offscreen, "window.guideResult"), 3_000, "工具确认中止");
  assert.equal(receipt.ok, false);
  assert.equal(receipt.data?.heldReason, "guide_stopped");
  assert.equal(receipt.executionFact, "not_executed");
  if (!clean() || elapsed > 1000) {
    const dir = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-voice-guide-cancel`);
    await mkdir(dir, { recursive: true });
    await rp.screenshot(page, join(dir, "after-cancel.png"));
    console.log(`取消后的网页截图：${dir}/after-cancel.png`);
  }
  assert.equal(await clicks(), "0", "中止没有替用户点击");
  await rp.click(page, "#target");
  assert.equal(await clicks(), "1", "取消后原按钮只收到一次用户点击");
  console.log(`教学前 ${JSON.stringify(initial)}，等待时 ${JSON.stringify(shown)}，tool_cancel 后 ${elapsed}ms ${JSON.stringify(last)}，工具已确认中止，网页收到一次用户点击`);
  assert.ok(clean() && elapsed <= 1000, "tool_cancel 后 1 秒内必须清除圈、聚光灯和光标");
  console.log("PASS 实时语音工具取消后教学消失，用户能自己点击页面");
});
