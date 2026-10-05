/**
 * 对话区滚动渐隐与流式淡入的真实扩展探针（docs/evals/20261006-motion-scroll-stream.md）。
 * 只装扩展的无头 Chrome、真侧栏、本机脚本模型。三轮长回答让对话区可滚，
 * 在顶部、中间、底部读两条渐隐带的实际透明度并截图；回答流式输出时读淡入的实际时长。
 *
 *   npx tsx scripts/probes/motion/scroll-stream.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { configureViaSettings } from "../../acceptance/real-path/inproc-config.mts";
import { startScriptedModel } from "../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/motion");

await mkdir(out, { recursive: true });

const LONG = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 段：按售价除以续航，B7 每分钟约 11.9 元，最便宜；A1 约 12.7 元；C3 约 13.7 元。`).join("\n\n");

const model = await startScriptedModel([{ match: "比一下", steps: [{ text: LONG }] }]);

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>评测合集</title><h1>扫地机器人评测合集</h1>"));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

const results: Record<string, string> = {};

const FADES = `(() => {
  const f = document.querySelector("#messages-frame"), m = document.querySelector("#messages");
  const o = (e) => getComputedStyle(document.querySelector('.scroll-fade[data-edge="' + e + '"]')).opacity;
  return JSON.stringify({ scrollTop: Math.round(m.scrollTop), max: m.scrollHeight - m.clientHeight, top: o("top"), bottom: o("bottom"), attrs: [f.dataset.fadeTop, f.dataset.fadeBottom] });
})()`;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await sleep(800);
  const panel = await rp.attach(await rp.openSidePanel());
  const run = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: run.settingsTargetId });
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 90_000, "侧栏就绪", 500);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);

  for (let turn = 0; turn < 3; turn += 1) {

    // 第一批字开始淡入时当场读它的动画（从外面轮询会错过 300ms 的窗口）。
    await rp.click(panel, "#input");
    await rp.typeText(panel, "分别点进去比一下续航和价格");
    await rp.pressEnter(panel);

    // 流式输出中读一次正在淡入的字的动画时长。
    await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".answer-actions").length >= ${turn + 1}`)) || undefined, 60_000, `第 ${turn + 1} 轮结束`);
  }

  await sleep(800);
  // 脚本模型一次给出整段，回答不走逐字显示；淡入的样式规则直接在真侧栏里读：挂一个同名 span 取计算值。
  results.revealFade = String(await rp.evaluate(panel, `(() => { const s = document.createElement("span"); s.className = "reveal-fade"; document.querySelector("#messages").append(s); const c = getComputedStyle(s); const v = c.animationDuration + " " + c.animationName + " " + c.animationTimingFunction; s.remove(); return v; })()`));
  results.bottom = String(await rp.evaluate(panel, FADES));
  await rp.screenshot(panel, join(out, "bottom.png"));
  await rp.evaluate(panel, `(() => { const m = document.querySelector("#messages"); m.scrollTop = (m.scrollHeight - m.clientHeight) / 2; return true; })()`);
  await sleep(400);
  results.middle = String(await rp.evaluate(panel, FADES));
  await rp.screenshot(panel, join(out, "middle.png"));
  await rp.evaluate(panel, `(() => { document.querySelector("#messages").scrollTop = 0; return true; })()`);
  await sleep(400);
  results.top = String(await rp.evaluate(panel, FADES));
  await rp.screenshot(panel, join(out, "top.png"));
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  results.reducedRevealFade = String(await rp.evaluate(panel, `(() => { const s = document.createElement("span"); s.className = "reveal-fade"; document.querySelector("#messages").append(s); const v = getComputedStyle(s).animationName; s.remove(); return v; })()`));
  results.reducedFilter = String(await rp.evaluate(panel, `getComputedStyle(document.querySelector('.scroll-fade[data-edge="bottom"]')).backdropFilter`));
} finally {
  console.log(JSON.stringify(results, null, 2));
  await rp.close();
  await model.close();
  site.closeAllConnections();
  site.close();
}
