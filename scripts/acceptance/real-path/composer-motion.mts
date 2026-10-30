/**
 * 发送 / 停止按钮的状态切换：真实侧栏、真实点击与键盘，本机脚本模型只控制加载、完成和失败。
 *   npx tsx scripts/acceptance/real-path/composer-motion.mts --headless
 *
 * 判据：按钮原地切换、连点只停一次、运行中能插话、错误后恢复、焦点可读、减少动态效果时不做过渡。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-composer-motion`);
await mkdir(out, { recursive: true });

const steerPayloads: string[] = [];
const model = await startScriptedModel([
  { match: "[GOAL CHECK]", steps: [{ text: JSON.stringify({ items: [{ text: "完成按钮场景", done: true }], status: "done", remaining: "" }) }] },
  { match: "按钮加载", steps: [{ text: "加载中的回答", delayMs: 5_000, chunkDelayMs: 30_000 }] },
  { match: "键盘加载", steps: [{ text: "键盘加载中的回答", delayMs: 5_000, chunkDelayMs: 30_000 }] },
  { match: "按钮失败", steps: [{ status: 500, body: JSON.stringify({ error: { message: "controlled failure" } }) }] },
  { match: "按钮插话", steps: [{ text: "插话已收到", delayMs: 200 }] },
], undefined, (payload) => {
  const text = JSON.stringify(payload.messages ?? []);
  if (text.includes("按钮插话")) steerPayloads.push(text);
});
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>按钮验收</title><h1>同一条对话路径</h1>"));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const snapshot = `(() => {
  const b = document.querySelector("#send-btn");
  const box = b.getBoundingClientRect();
  const icon = (selector) => {
    const s = getComputedStyle(document.querySelector(selector));
    return { opacity: +s.opacity, transform: s.transform, filter: s.filter, duration: s.transitionDuration };
  };
  const { root } = { root: document.documentElement };
  return { rect: [box.x, box.y, box.width, box.height], send: icon(".morph-icon-send"), stop: icon(".morph-icon-stop"), title: b.title, focus: document.activeElement?.id, steering: !document.querySelector("#steer-send-btn").hidden, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, overflow: root.scrollWidth - root.clientWidth };
})()`;
const visibleFilter = (value: string) => value === "none" || value === "blur(0px)";

const rp = await launchRealPath();
let panel = "";
try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "练习页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await until(async () => await rp.evaluate(work, `document.querySelector("h1")?.textContent === "同一条对话路径"`), 10_000, "练习页加载");
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const idle = async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#send-btn").classList.contains("stopping")`);
  await until(idle, 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "按钮加载");
  await rp.click(panel, "#send-btn");
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn").classList.contains("stopping")`), 10_000, "运行状态");
  const entered = await rp.evaluate(panel, snapshot);
  await sleep(260);
  const stopped = await rp.evaluate(panel, snapshot);
  await rp.screenshot(panel, join(out, "01-running.png"));
  check("发送后原位置变成停止，图标清晰且按钮不移位", entered.rect.join() === stopped.rect.join() && stopped.send.opacity === 0 && stopped.stop.opacity === 1 && visibleFilter(stopped.stop.filter) && stopped.stop.transform === "matrix(1, 0, 0, 1, 0, 0)", { entered, stopped });

  await rp.click(panel, "#send-btn");
  await until(idle, 15_000, "首次停止生效");
  await sleep(260);
  const afterStop = await rp.evaluate(panel, snapshot);
  check("快速连续点击停止后能恢复发送，不卡在中间态", afterStop.send.opacity === 1 && afterStop.stop.opacity === 0, afterStop);

  await rp.click(panel, "#input");
  await rp.typeText(panel, "按钮加载");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn").classList.contains("stopping")`), 10_000, "动画尚未结束时的运行");
  await rp.click(panel, "#send-btn");
  await until(idle, 15_000, "动画中点击停止");
  const interrupted = await rp.evaluate(panel, snapshot);
  check("动画尚未结束就停止：最终图标和状态一致", interrupted.title === "发送" && interrupted.send.opacity === 1 && interrupted.stop.opacity === 0, interrupted);

  await rp.click(panel, "#input");
  await rp.typeText(panel, "按钮加载");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn").classList.contains("stopping")`), 10_000, "再次运行");
  await rp.typeText(panel, "按钮插话");
  await sleep(260);
  const steering = await rp.evaluate(panel, snapshot);
  check("加载中插话不改变停止按钮，也不引起横向溢出", steering.steering && steering.stop.opacity === 1 && steering.overflow === 0, steering);
  await rp.pressEnter(panel);
  await until(() => steerPayloads.length > 0, 10_000, "插话抵达模型");
  check("插话实际交给当前任务", steerPayloads.length > 0, { count: steerPayloads.length });

  if (!await idle()) {
    await rp.click(panel, "#send-btn");
    await until(idle, 15_000, "插话后停止恢复");
  }

  await rp.click(panel, "#input");
  await rp.typeText(panel, "键盘加载");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn").classList.contains("stopping")`), 10_000, "键盘运行");
  await rp.cdp.send("Page.bringToFront", {}, panel);
  const tab = (shift = false) => rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }, panel).then(() => rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }, panel));
  let focused = false;
  for (let i = 0; i < 18; i += 1) {
    await tab();
    focused = await rp.evaluate(panel, `document.activeElement?.id === "send-btn"`);
    if (focused) break;
  }
  const focus = await rp.evaluate(panel, `(() => { const b = document.activeElement; const s = getComputedStyle(b); return { id: b.id, title: b.title, outline: s.outlineStyle, width: s.outlineWidth }; })()`);
  check("Tab 可以聚焦停止按钮，名称和焦点环都清楚", focused && focus.title === "中止" && focus.outline !== "none" && focus.width === "2px", focus);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, panel);
  await until(idle, 15_000, "键盘停止恢复");

  await rp.click(panel, "#input");
  await rp.typeText(panel, "按钮失败");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector(".error-card")`), 30_000, "失败状态");
  await sleep(260);
  const failed = await rp.evaluate(panel, snapshot);
  await rp.screenshot(panel, join(out, "03-failed.png"));
  check("失败后停止图标退出，发送按钮恢复可用", failed.send.opacity === 1 && failed.stop.opacity === 0 && failed.title === "发送", failed);

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  await sleep(100);
  const reduced = await rp.evaluate(panel, snapshot);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "减少动态效果加载");
  const reducedBefore = await rp.evaluate(panel, snapshot);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn").title === "中止"`), 10_000, "减少动态效果下进入运行");
  const reducedInstant = await rp.evaluate(panel, snapshot);
  check("减少动态效果时发送后立即显示停止，没有过渡", reducedBefore.reduced && reducedBefore.send.duration === "0s" && reducedBefore.stop.duration === "0s" && reducedInstant.title === "中止" && reducedInstant.send.opacity === 0 && reducedInstant.stop.opacity === 1 && visibleFilter(reducedInstant.stop.filter), { reducedBefore, reducedInstant });
  await rp.evaluate(panel, `document.querySelector("#send-btn").focus(); true`);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, panel);
  await rp.screenshot(panel, join(out, "02-reduced-motion.png"));
  await until(idle, 15_000, "减少动态效果下键盘停止恢复");
  const reducedStopped = await rp.evaluate(panel, snapshot);
  check("减少动态效果下按 Enter 停止后立即显示发送", reducedStopped.send.opacity === 1 && reducedStopped.stop.opacity === 0 && visibleFilter(reducedStopped.send.filter), reducedStopped);
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, panel);

  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 720, deviceScaleFactor: 2, mobile: false }, panel);
  const narrow = await rp.evaluate(panel, snapshot);
  check("320 像素侧栏仍能看到并点中按钮", narrow.overflow === 0 && await rp.evaluate(panel, `(() => { const b = document.querySelector("#send-btn"); const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`), narrow);
} catch (error) {
  console.error("验收诊断", JSON.stringify({ modelRequests: model.requests, panel: panel ? await rp.evaluate(panel, `document.body.innerText`).catch(String) : "侧栏未打开" }));
  check("验收流程", false, error instanceof Error ? error.stack : String(error));
} finally {
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, browser: rp.browser, dependency: "real isolated Chrome extension; local scripted model" }, null, 2));
console.log(`证据：${out}`);
assert.ok(checks.length > 0 && checks.every(c => c.pass));
