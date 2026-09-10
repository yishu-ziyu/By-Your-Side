/**
 * 光标状态层无头自检：等待 / 读页面 / 完成 / 失败 / 跨页胶囊 / 与动作名牌和拿住双键互不打架。
 * 只加载 dist/content-cursor.js，不依赖真实扩展与伴随进程。
 */
import { chromium } from "/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cursorJs = path.join(root, "dist/content-cursor.js");
const outDir = "/tmp/sideagent-cursor-status";
const chrome =
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const HTML = `<!doctype html>
<meta charset="utf-8">
<title>cursor status check</title>
<style>
  html, body { margin: 0; padding: 0; background: #f7f8fa; }
  #box {
    position: absolute; left: 300px; top: 150px; width: 140px; height: 40px;
    background: #e2e8f0; border: 1px solid #94a3b8;
  }
</style>
<div id="box">target</div>
`;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
// 自检页没有扩展运行时：捕获胶囊点击，验证它确实发消息而不是只有样式
await page.setContent(HTML);
await page.evaluate(() => {
  window.__sent = [];
  window.chrome = window.chrome ?? {};
  window.chrome.runtime = { sendMessage: (msg) => window.__sent.push(msg), lastError: undefined };
});
await page.addScriptTag({ path: cursorJs });

const hasApi = await page.evaluate(() => Boolean(window.__sideagent?.cursor?.setStatus));
if (!hasApi) {
  fail("content-cursor.js 未暴露 setStatus");
  await browser.close();
  process.exit(1);
}

const setStatus = (state, id = "main") =>
  page.evaluate(
    ([s, i]) => window.__sideagent.cursor.for(i).setStatus({ state: s }),
    [state, id],
  );
const status = (id = "main") => page.evaluate((i) => window.__sideagent.cursorStatus?.(i) ?? null, id);

// ── 1. 等待：文案、秒数、字号、停在角落 ────────────────────────────────
await setStatus("waiting");
const waited = await status();
if (waited?.state !== "waiting") fail(`等待状态未挂上：${JSON.stringify(waited)}`);
if (waited?.text !== "正在等模型响应") fail(`等待主文案不对：${waited?.text}`);
if (waited?.detail !== "已等 0 秒") fail(`等待秒数初值不对：${waited?.detail}`);
if (waited?.fontSize !== "11px") fail(`状态主文案应为 11px，实际 ${waited?.fontSize}`);
if (waited?.nameFontSize !== "9.5px") fail(`名字应为 9.5px，实际 ${waited?.nameFontSize}`);
if (waited?.borderColor !== "rgb(245, 158, 11)") fail(`等待色条应为 #f59e0b，实际 ${waited?.borderColor}`);
if (waited?.opacity !== 1) fail(`等待名牌应可见，实际 opacity=${waited?.opacity}`);
if (waited && (waited.x !== 24 || waited.y !== 24)) fail(`等待时光标应停在角落：${waited.x},${waited.y}`);

await page.waitForTimeout(1250);
const ticked = await status();
if (ticked?.detail !== "已等 1 秒") fail(`等待秒数未走动：${ticked?.detail}`);
await page.screenshot({ path: path.join(outDir, "1-waiting-light.png") });

// ── 2. 读页面 ──────────────────────────────────────────────────────────
await setStatus("reading");
const reading = await status();
if (reading?.text !== "正在读这个页面") fail(`读页面文案不对：${reading?.text}`);
if (reading?.detail !== "By Your Side") fail(`读页面第二行应为成员名：${reading?.detail}`);
if (reading?.borderColor !== "rgb(47, 111, 237)") fail(`读页面色条应为 #2f6fed，实际 ${reading?.borderColor}`);

// ── 3. 完成：约 1.5 秒后自动消失、光标回角落 ──────────────────────────
await page.evaluate(() => window.__sideagent.cursor.move(370, 170));
await page.waitForTimeout(520);
await setStatus("done");
const done = await status();
if (done?.text !== "完成") fail(`完成文案不对：${done?.text}`);
if (done?.borderColor !== "rgb(22, 163, 74)") fail(`完成色条应为 #16a34a，实际 ${done?.borderColor}`);
await page.screenshot({ path: path.join(outDir, "2-done.png") });
await page.waitForTimeout(1750);
const afterDone = await status();
if (afterDone?.state !== null) fail(`完成应在约 1.5 秒后自动收起，实际 ${afterDone?.state}`);
if (afterDone?.opacity !== 0) fail(`收起后名牌应不可见，实际 opacity=${afterDone?.opacity}`);
await page
  .waitForFunction(() => {
    const s = window.__sideagent.cursorStatus?.();
    return Boolean(s && s.x === 24 && s.y === 24);
  }, undefined, { timeout: 2000 })
  .catch(() => {
    fail(`完成后光标应回角落：${JSON.stringify(afterDone && { x: afterDone.x, y: afterDone.y })}`);
  });

// ── 4. 失败：留在原地，不自动消失 ─────────────────────────────────────
await page.evaluate(() => window.__sideagent.cursor.move(370, 170));
await page.waitForTimeout(520);
await setStatus("failed");
const failed = await status();
if (failed?.text !== "这一步没做成") fail(`失败文案不对：${failed?.text}`);
if (failed?.detail !== "可以让我重试") fail(`失败第二行不对：${failed?.detail}`);
await page.waitForTimeout(2600);
const stillFailed = await status();
if (stillFailed?.state !== "failed") fail(`失败状态应保持，实际 ${stillFailed?.state}`);
if (stillFailed && (stillFailed.x !== 370 || stillFailed.y !== 170)) {
  fail(`失败应停在出错位置：${stillFailed.x},${stillFailed.y}`);
}
await page.screenshot({ path: path.join(outDir, "3-failed.png") });

// ── 5. 跨页胶囊：右上角、可点、点了发跳转消息 ─────────────────────────
await page.evaluate(() => window.__sideagent.cursor.hideCrossPage?.());
await page.evaluate(() =>
  window.__sideagent.cursor.showCrossPage({ sessionId: "main", title: "BOSS直聘 · 招聘页", state: "waiting" }),
);
const pill = await page.evaluate(() => window.__sideagent.crossPageState?.() ?? null);
if (!pill) fail("跨页胶囊未显示");
if (pill?.main !== "正在另一个标签页工作") fail(`胶囊主文案不对：${pill?.main}`);
if (pill?.sub !== "BOSS直聘 · 招聘页 ↗") fail(`胶囊副文案不对：${pill?.sub}`);
if (pill && Math.abs(pill.rect.x + pill.rect.width - (pill.viewport.width - 20)) > 1) {
  fail(`胶囊应贴右上角：right=${pill.rect.x + pill.rect.width} viewport=${pill.viewport.width}`);
}
if (pill && pill.rect.y !== 20) fail(`胶囊应距顶 20px，实际 ${pill.rect.y}`);
if (pill && pill.rect.y < pill.viewport.height / 2) {
  // 明确不是右下角
} else {
  fail("胶囊不应在页面下半部");
}
await page.screenshot({ path: path.join(outDir, "4-cross-page.png") });
const clicked = await page.evaluate(() => window.__sideagent.clickCrossPage?.() ?? false);
if (!clicked) fail("胶囊不可点");
const sent = await page.evaluate(() => window.__sent ?? []);
if (sent[0]?.type !== "cross_page_click" || sent[0]?.sessionId !== "main") {
  fail(`点胶囊应发 cross_page_click：${JSON.stringify(sent)}`);
}
await page.evaluate(() => window.__sideagent.cursor.hideCrossPage?.());
if (await page.evaluate(() => window.__sideagent.crossPageState?.() ?? null)) fail("hideCrossPage 后胶囊仍显示");

// ── 6. 与动作名牌 / 拿住双键互不打架 ──────────────────────────────────
await setStatus("waiting");
await page.evaluate(() => {
  const box = document.getElementById("box");
  const r = box.getBoundingClientRect();
  window.__sideagent.cursor.beginAction("a1", "click", { x: r.x, y: r.y, width: r.width, height: r.height }, box, "投递简历");
});
const acting = await status();
if (!acting?.text.startsWith("正在点击")) fail(`动作进行中应显示动作名牌：${acting?.text}`);
if (acting?.opacity !== 1) fail("动作名牌应可见");
await page.evaluate(() => window.__sideagent.cursor.endAction("a1", "done", [370, 170]));
await page.waitForTimeout(1400);
const backToStatus = await status();
if (backToStatus?.state !== "waiting") fail(`动作结束后应回到等待状态：${backToStatus?.state}`);
if (backToStatus?.text !== "正在等模型响应") fail(`动作结束后文案应回到等待：${backToStatus?.text}`);

await page.evaluate(() => {
  const box = document.getElementById("box");
  const r = box.getBoundingClientRect();
  window.__sideagent.cursor.hold(
    Math.round(r.x + r.width / 2),
    Math.round(r.y + r.height / 2),
    [{ id: "confirm", label: "删除" }, { id: "cancel", label: "取消" }],
    "#box",
  );
});
await page.waitForTimeout(520);
const holdLabels = await page.evaluate(() => window.__sideagent.holdActionLabels?.() ?? []);
if (holdLabels.length !== 2) fail(`拿住应保留双键：${JSON.stringify(holdLabels)}`);
await page.evaluate(() => window.__sideagent.cursor.clearStatus?.());
await setStatus("done");
const holdingDone = await page.evaluate(() => window.__sideagent.holdActionLabels?.() ?? []);
if (holdingDone.length !== 2) fail(`拿住期间状态更新不得覆盖双键：${JSON.stringify(holdingDone)}`);
const holdState = await page.evaluate(() => window.__sideagent.holdState?.() ?? null);
if (!holdState?.holding) fail("拿住态丢失");
await page.screenshot({ path: path.join(outDir, "5-hold-vs-status.png") });
await page.evaluate(() => {
  window.__sideagent.cursor.releaseHold?.();
  window.__sideagent.cursor.hide();
});

// ── 7. 深色页面可辨认 + 减少动态效果下仍静态可见 ───────────────────────
await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
await page.evaluate(() => {
  document.documentElement.style.background = "#0f172a";
  document.body.style.background = "#0f172a";
});
await setStatus("reading");
await page.waitForTimeout(120);
const dark = await status();
if (dark?.state !== "reading" || dark?.opacity !== 1) fail(`深色页面状态应可见：${JSON.stringify(dark)}`);
await page.screenshot({ path: path.join(outDir, "6-dark-reduced.png") });

await browser.close();

if (process.exitCode) {
  console.error("cursor-status-check FAILED");
  process.exit(1);
}
console.log(`PASS cursor-status-check 截图 ${outDir}`);
