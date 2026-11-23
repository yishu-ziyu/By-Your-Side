import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, REPO, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-starter-empty-state`);
await mkdir(out, { recursive: true });
const model = await startScriptedModel([{ match: "你好", steps: [{ text: "你好，已就绪。" }] }]);
const rp = await launchRealPath();
let error: string | null = null;
const evidence: Record<string, unknown> = {};

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 820, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-fixture" },
  })}).then(() => true)`);

  await until(
    async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled === false && document.querySelector("#send-btn")?.disabled === false') || undefined,
    60_000,
    "侧栏就绪",
  );
  await sleep(400);

  const readLayout = () => rp.evaluate(panel, `(() => {
    const app = document.querySelector("#app");
    const orb = document.querySelector("#starter-orb")?.getBoundingClientRect();
    const title = document.querySelector("#starter-title");
    const titleBox = title?.getBoundingClientRect();
    const composer = document.querySelector("#composer")?.getBoundingClientRect();
    const slot = document.querySelector("#open-threads-slot")?.getBoundingClientRect();
    const threads = document.querySelector("#open-threads");
    const demo = document.querySelector("#starter-demo");
    return {
      starterReady: !!app?.classList.contains("starter-ready"),
      hasDemoVideo: !!demo,
      titleText: (title?.textContent ?? "").trim(),
      titleHeight: Math.round(titleBox?.height ?? 0),
      orbTop: Math.round(orb?.top ?? 0),
      orbCenterY: Math.round((orb?.top ?? 0) + (orb?.height ?? 0) / 2),
      orbHeight: Math.round(orb?.height ?? 0),
      composerTop: Math.round(composer?.top ?? 0),
      composerBottom: Math.round(composer?.bottom ?? 0),
      slotTop: Math.round(slot?.top ?? 0),
      slotHeight: Math.round(slot?.height ?? 0),
      threadsHidden: threads ? threads.hidden : true,
      viewportHeight: window.innerHeight,
      overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
    };
  })()`) as Promise<{
    starterReady: boolean;
    hasDemoVideo: boolean;
    titleText: string;
    titleHeight: number;
    orbTop: number;
    orbCenterY: number;
    orbHeight: number;
    composerTop: number;
    composerBottom: number;
    slotTop: number;
    slotHeight: number;
    threadsHidden: boolean;
    viewportHeight: number;
    overflowX: number;
  }>;

  const emptyLight = await readLayout();
  evidence.emptyLight = emptyLight;
  assert.equal(emptyLight.starterReady, true, "空会话已就绪");
  assert.equal(emptyLight.hasDemoVideo, false, "不再存在循环演示视频");
  assert.equal(emptyLight.titleText, "", "已连模型时不再重复显示「说说你想完成什么」");
  assert.equal(emptyLight.titleHeight, 0, "空标题不占额外高度");
  assert.ok(emptyLight.orbHeight >= 48, "光球可见");
  assert.ok(emptyLight.orbCenterY / emptyLight.viewportHeight < 0.44, `光球视觉重心略偏上：${emptyLight.orbCenterY}/${emptyLight.viewportHeight}`);
  assert.ok(emptyLight.slotTop >= emptyLight.composerBottom - 2, "继续上次的事容器位于输入框下方");
  assert.ok(emptyLight.overflowX <= 0, "浅色空态无横向溢出");
  await rp.screenshot(panel, join(out, "1-empty-light.png"));

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
  await sleep(200);
  const emptyDark = await readLayout();
  evidence.emptyDark = emptyDark;
  assert.equal(emptyDark.hasDemoVideo, false, "深色模式下无演示视频");
  assert.ok(emptyDark.overflowX <= 0, "深色空态无横向溢出");
  await rp.screenshot(panel, join(out, "2-empty-dark.png"));

  await rp.cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  }, panel);
  await sleep(200);
  await rp.screenshot(panel, join(out, "3-reduced-motion.png"));

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, panel);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "你好");
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText ?? ""') as string).includes("已就绪") || undefined, 30_000, "能直接发消息");
  await sleep(300);

  const afterSend = await rp.evaluate(panel, `(() => ({
    starterVisible: getComputedStyle(document.querySelector("#starter")).display !== "none",
    slotVisible: getComputedStyle(document.querySelector("#open-threads-slot")).display !== "none",
  }))()`) as { starterVisible: boolean; slotVisible: boolean };
  evidence.afterSend = afterSend;
  assert.equal(afterSend.starterVisible, false, "发出消息后空态收起");
  assert.equal(afterSend.slotVisible, false, "发出消息后未完任务槽位收起");
  await rp.screenshot(panel, join(out, "4-after-send.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
}

await writeFile(join(out, "result.json"), JSON.stringify({
  status: error ? "FAIL" : "PASS",
  error,
  evidence,
  dependency: "real isolated extension and side panel; scripted model",
}, null, 2));
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", error, evidence, out }));
await rp.close();
await rp.remove();
await model.close();
process.exit(error ? 1 : 0);
