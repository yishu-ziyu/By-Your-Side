/**
 * 界面底色色阶切换：只保留「淡蓝」和「暖纸」两种颜色。
 * 用户在设置页点一下，设置页、侧栏和已打开网页上的划词解释卡立即同步切换，无需重开侧栏或刷新网页。
 *
 *   npx tsx scripts/acceptance/real-path/color-tone-switch.mts --headless
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-color-tone-switch`);
await mkdir(out, { recursive: true });

const MARKER = "The lighthouse keeper logged every storm in violet ink so that later sailors could trust the record.";
const HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>灯塔日志</title>
<style>html,body{margin:0;background:#fff}article{max-width:36rem;margin:56px 0 80px 72px;font:17px/1.75 Georgia,serif;color:#222}</style></head>
<body><article><h1>灯塔日志</h1><p id="para"><span id="para-text">${MARKER}</span> 紫色是因为普通黑墨在盐雾里几个冬天就褪了。</p></article></body></html>`;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const model = await startScriptedModel([
  { match: "解释这段选中的文字", steps: [{ text: "## 要点\n\n---\n\n紫色染料能保存几十年，普通黑墨在盐雾里几年就褪了。" }] },
]);

const rp = await launchRealPath();

try {
  const tab = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(tab.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => (await rp.evaluate(work, `document.title === "灯塔日志"`)) || undefined, 10_000, "article loaded");

  const panel = await rp.attach(await rp.openSidePanel());
  const config = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "fixture", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  const settings = await rp.attach(config.settingsTargetId);

  // 打开网页上的划词解释卡
  await rp.evaluate(work, `(() => {
    const el = document.getElementById("para-text");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);

  const readColors = async () => ({
    settingsTone: await rp.evaluate(settings, `document.documentElement.dataset.tone`),
    settingsBg: await rp.evaluate(settings, `getComputedStyle(document.body).backgroundColor`),
    panelTone: await rp.evaluate(panel, `document.documentElement.dataset.tone`),
    panelBg: await rp.evaluate(panel, `getComputedStyle(document.body).backgroundColor`),
    askTone: await rp.evaluate(work, `document.querySelector("[data-sideagent-ask]")?.getAttribute("data-tone")`),
    options: await rp.evaluate(settings, `[...document.querySelectorAll(".tone-option")].map(b => ({ id: b.getAttribute("data-tone-option"), checked: b.getAttribute("aria-checked"), text: b.textContent }))`),
  });

  await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".tone-option").length === 2`)) || undefined, 5_000, "2 tone options rendered");
  const initial = await readColors();
  assert.equal(initial.options.length, 2, "只保留两种颜色选项");
  assert.equal(initial.settingsTone, "blue", "默认是淡蓝");
  assert.equal(initial.panelTone, "blue", "侧栏默认是淡蓝");
  assert.equal(initial.askTone, "blue", "网页浮层默认是淡蓝");

  await rp.evaluate(settings, `document.getElementById("tone-list")?.scrollIntoView({ block: "center" })`);
  await sleep(200);
  await rp.screenshot(settings, join(out, "1-settings-blue.png"));
  await rp.screenshot(panel, join(out, "1-panel-blue.png"));

  // 用户在设置页点击「暖纸」
  await rp.click(settings, `.tone-option[data-tone-option="warm"]`);
  await until(async () => (await rp.evaluate(panel, `document.documentElement.dataset.tone === "warm"`)) || undefined, 5_000, "panel switched to warm");
  await until(async () => (await rp.evaluate(work, `document.querySelector("[data-sideagent-ask]")?.getAttribute("data-tone") === "warm"`)) || undefined, 5_000, "ask host switched to warm");
  await sleep(250);

  const afterWarm = await readColors();
  assert.equal(afterWarm.settingsTone, "warm", "设置页切到暖纸");
  assert.equal(afterWarm.panelTone, "warm", "侧栏实时切到暖纸");
  assert.equal(afterWarm.askTone, "warm", "网页浮层实时切到暖纸");
  assert.notEqual(afterWarm.panelBg, initial.panelBg, "侧栏背景色随切换改变");

  await rp.screenshot(settings, join(out, "2-settings-warm.png"));
  await rp.screenshot(panel, join(out, "2-panel-warm.png"));

  // 深色模式下暖纸的分隔线仍保持浅色半透明（不被浅色暖纸覆盖）
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, settings);
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
  await sleep(150);
  const darkWarm = await rp.evaluate(settings, `({
    hair: getComputedStyle(document.documentElement).getPropertyValue("--hair").trim(),
    bg: getComputedStyle(document.body).backgroundColor,
  })`);
  assert.match(darkWarm.hair, /255/, "深色模式暖纸分隔线使用白色半透明");
  await rp.screenshot(settings, join(out, "3-settings-warm-dark.png"));
  await rp.screenshot(panel, join(out, "3-panel-warm-dark.png"));
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, settings);
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, panel);
  await sleep(100);

  // 重载侧栏后保持「暖纸」且同步缓存立即生效
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => (await rp.evaluate(panel, `document.documentElement.dataset.tone === "warm"`)) || undefined, 5_000, "reloaded panel keeps warm tone");

  // 再点回「淡蓝」
  await rp.click(settings, `.tone-option[data-tone-option="blue"]`);
  await until(async () => (await rp.evaluate(panel, `document.documentElement.dataset.tone === "blue"`)) || undefined, 5_000, "panel switched back to blue");
  const backBlue = await readColors();
  assert.equal(backBlue.panelBg, initial.panelBg, "切回淡蓝后恢复原背景色");

  await writeFile(join(out, "result.json"), JSON.stringify({ status: "PASS", out, initial, afterWarm, darkWarm, backBlue }, null, 2));
  console.log(JSON.stringify({ status: "PASS", out }));
} finally {
  await rp.close();
  await model.close();
  site.close();
}
