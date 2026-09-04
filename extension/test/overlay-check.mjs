/**
 * Overlay 无头自检：光标双底色可见性、多实例配色、reload 残留、resize 跟随。
 * 使用本机 Playwright Chromium 1234（与历史自检同一缓存）。
 */
import { chromium } from "/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cursorJs = path.join(root, "dist/content-cursor.js");
const domopsJs = path.join(root, "dist/content-domops.js");
const outDir = "/tmp/sideagent-overlay";
const chrome =
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const HTML = `<!doctype html>
<meta charset="utf-8">
<title>overlay check</title>
<style>
  html, body { margin: 0; padding: 0; }
  .row { display: flex; height: 220px; }
  .panel { flex: 1; position: relative; }
  #light { background: #f4f1ea; }
  #dark { background: #0f172a; }
  #busy {
    background:
      repeating-linear-gradient(45deg, #2f6fed 0 8px, #f59e0b 8px 16px, #e11d48 16px 24px, #111 24px 32px);
  }
  #box {
    position: absolute; left: 40px; top: 80px; width: 120px; height: 40px;
    background: #e2e8f0; border: 1px solid #94a3b8;
  }
</style>
<div class="row">
  <div class="panel" id="light"></div>
  <div class="panel" id="dark"></div>
  <div class="panel" id="busy"></div>
</div>
<div id="box">target</div>
`;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 900, height: 360 } });
await page.setContent(HTML);
await page.addScriptTag({ path: cursorJs });

const hasApi = await page.evaluate(() => Boolean(window.__sideagent?.cursor));
if (!hasApi) fail("content-cursor.js 未挂上 window.__sideagent.cursor");

await page.evaluate(() => {
  const c = window.__sideagent.cursor;
  c.move(80, 110);
  c.for("worker-red").move(380, 110);
  c.for("worker-green").move(680, 110);
});
await page.waitForTimeout(520);
await page.screenshot({ path: path.join(outDir, "cursors-three-bg.png") });

const palette = await page.evaluate(() => {
  const labels = [...document.querySelectorAll("[data-sideagent-overlay='cursor']")];
  return labels.length;
});
if (palette !== 1) fail(`光标 host 应为 1，实际 ${palette}`);

// 模拟扩展 reload：旧 world 已死，DOM host 还在 + 再塞两个假残留，然后重注
await page.evaluate(() => {
  const staleC = document.createElement("div");
  staleC.id = "stale-cursor";
  staleC.setAttribute("data-sideagent-overlay", "cursor");
  document.documentElement.appendChild(staleC);
  const staleM = document.createElement("div");
  staleM.id = "stale-marks";
  staleM.setAttribute("data-sideagent-overlay", "marks");
  document.documentElement.appendChild(staleM);
  if (window.__sideagent) window.__sideagent.cursor = undefined;
});
await page.addScriptTag({ path: cursorJs });
const residue = await page.evaluate(() => ({
  staleCursor: Boolean(document.getElementById("stale-cursor")),
  staleMarks: Boolean(document.getElementById("stale-marks")),
  hosts: document.querySelectorAll("[data-sideagent-overlay]").length,
  api: Boolean(window.__sideagent?.cursor),
}));
if (residue.staleCursor || residue.staleMarks) fail(`重注后仍有残留节点 ${JSON.stringify(residue)}`);
if (residue.hosts !== 0) fail(`重注后应清光 host（lazy create），实际 ${residue.hosts}`);
if (!residue.api) fail("重注后 API 未重建");

await page.evaluate(() => window.__sideagent.cursor.move(80, 110));
await page.waitForTimeout(520);
const afterReinject = await page.evaluate(
  () => document.querySelectorAll("[data-sideagent-overlay='cursor']").length,
);
if (afterReinject !== 1) fail(`重注后光标 host 应仅 1 个，实际 ${afterReinject}`);

// mark + resize：盒子右移后 dispatch resize，标注文档坐标应跟随
await page.evaluate(() => {
  const box = document.getElementById("box");
  const r = box.getBoundingClientRect();
  window.__sideagent.cursor.mark(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    "Step 1",
    "#box",
  );
});
const before = await page.evaluate(() => window.__sideagent.markLayout()[0]);
await page.evaluate(() => {
  const box = document.getElementById("box");
  box.style.left = "240px";
  window.dispatchEvent(new Event("resize"));
});
await page.waitForTimeout(40);
const after = await page.evaluate(() => window.__sideagent.markLayout()[0]);
if (!before || !after) fail("markLayout 为空");
if (after.x <= before.x) fail(`resize 后 mark 未右移 before=${before.x} after=${after.x}`);
const expectedShift = 200; // 40 → 240
if (Math.abs(after.x - before.x - expectedShift) > 2) {
  fail(`mark 位移 ${after.x - before.x}，期望 ${expectedShift}`);
}

await page.screenshot({ path: path.join(outDir, "mark-after-resize.png") });

// 就地确认：框外双键，点下去发 mark_action（不挡正文）
await page.evaluate(() => {
  window.__sideagent.cursor.clearMarks();
  const box = document.getElementById("box");
  const r = box.getBoundingClientRect();
  window.__sideagent.cursor.mark(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    "待删除",
    "#box",
    [
      { id: "confirm", label: "删除" },
      { id: "cancel", label: "取消" },
    ],
  );
});
const actionLabels = await page.evaluate(() => window.__sideagent.markActionLabels());
if (
  !actionLabels ||
  actionLabels.length !== 2 ||
  actionLabels[0].id !== "confirm" ||
  actionLabels[0].label !== "删除" ||
  actionLabels[1].id !== "cancel"
) {
  fail(`就地确认按钮不对 ${JSON.stringify(actionLabels)}`);
}
await page.screenshot({ path: path.join(outDir, "on-page-confirm.png") });
await page.evaluate(() => {
  window.__markMsgs = [];
  globalThis.chrome = {
    runtime: {
      sendMessage(msg) {
        window.__markMsgs.push(msg);
      },
    },
  };
});
const clicked = await page.evaluate(() => window.__sideagent.clickMarkAction("confirm"));
const msgs = await page.evaluate(() => window.__markMsgs);
if (!clicked) fail("clickMarkAction(confirm) 未点到按钮");
if (!msgs || msgs.length !== 1 || msgs[0].type !== "mark_action" || msgs[0].action !== "confirm") {
  fail(`点删除未发 mark_action ${JSON.stringify(msgs)}`);
}

// 内部滚动容器：window.scroll 不变，内容在 overflow:auto 里走。
// 不监听 scroll 的话，absolute 文档坐标会停在视口原处。
const nested = await browser.newPage({ viewport: { width: 720, height: 360 } });
await nested.setContent(`<!doctype html>
<meta charset="utf-8">
<title>nested scroll</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  #scroller { height: 100%; overflow: auto; }
  #spacer-top { height: 140px; }
  #box { width: 220px; height: 48px; margin: 0 48px; background: #e2e8f0; border: 1px solid #94a3b8; }
  #spacer-bottom { height: 900px; }
</style>
<div id="scroller">
  <div id="spacer-top"></div>
  <div id="box">target</div>
  <div id="spacer-bottom"></div>
</div>
`);
await nested.addScriptTag({ path: cursorJs });
await nested.addScriptTag({ path: domopsJs });

function markOffsetFromBox(layout, box, scrollX, scrollY, pad) {
  return {
    dx: layout.x - (box.x + scrollX - pad),
    dy: layout.y - (box.y + scrollY - pad),
    dw: layout.width - (box.width + pad * 2),
    dh: layout.height - (box.height + pad * 2),
  };
}

await nested.evaluate(() => {
  const box = document.getElementById("box");
  const r = box.getBoundingClientRect();
  window.__sideagent.cursor.mark(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    "第一条非置顶笔记",
    "#box",
  );
});
await nested.waitForTimeout(40);
const nestedBefore = await nested.evaluate(() => {
  const box = document.getElementById("box").getBoundingClientRect();
  return {
    layout: window.__sideagent.markLayout()[0],
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
});
await nested.screenshot({ path: path.join(outDir, "mark-nested-scroll-before.png") });
if (!nestedBefore.layout) fail("内部滚动前 markLayout 为空");
const nestedOff0 = markOffsetFromBox(
  nestedBefore.layout,
  nestedBefore.box,
  nestedBefore.scrollX,
  nestedBefore.scrollY,
  6,
);
if (Math.abs(nestedOff0.dx) > 2 || Math.abs(nestedOff0.dy) > 2) {
  fail(`标记初始就没箍住目标 dx=${nestedOff0.dx} dy=${nestedOff0.dy}`);
}

const NESTED_DELTA = 90;
await nested.evaluate((dy) => {
  document.getElementById("scroller").scrollTop = dy;
}, NESTED_DELTA);
await nested.waitForTimeout(40);
const nestedAfter = await nested.evaluate(() => {
  const box = document.getElementById("box").getBoundingClientRect();
  return {
    layout: window.__sideagent.markLayout()[0],
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
});
await nested.screenshot({ path: path.join(outDir, "mark-nested-scroll-after.png") });

if (nestedAfter.scrollY !== 0 || nestedBefore.scrollY !== 0) {
  fail(`内部滚动不应改变 window.scrollY before=${nestedBefore.scrollY} after=${nestedAfter.scrollY}`);
}
if (Math.abs(nestedBefore.box.y - nestedAfter.box.y - NESTED_DELTA) > 2) {
  fail(`目标未随内部滚动上移 before=${nestedBefore.box.y} after=${nestedAfter.box.y}`);
}
if (!nestedAfter.layout) fail("内部滚动后 markLayout 为空");
if (Math.abs(nestedBefore.layout.y - nestedAfter.layout.y - NESTED_DELTA) > 2) {
  fail(`内部滚动后 mark 文档 y 未跟随 before=${nestedBefore.layout.y} after=${nestedAfter.layout.y}`);
}
const nestedOff = markOffsetFromBox(
  nestedAfter.layout,
  nestedAfter.box,
  nestedAfter.scrollX,
  nestedAfter.scrollY,
  6,
);
if (Math.abs(nestedOff.dx) > 2 || Math.abs(nestedOff.dy) > 2) {
  fail(`内部滚动后 mark 未箍住目标 dx=${nestedOff.dx} dy=${nestedOff.dy} layout=${JSON.stringify(nestedAfter.layout)} box=${JSON.stringify(nestedAfter.box)}`);
}

// window 滚动：文档坐标应保持（absolute 跟随或重算后与 rect+scroll 一致）
const win = await browser.newPage({ viewport: { width: 720, height: 360 } });
await win.setContent(`<!doctype html>
<meta charset="utf-8">
<title>window scroll</title>
<style>
  html, body { margin: 0; }
  #box { width: 200px; height: 40px; margin: 80px 40px; background: #e2e8f0; }
  #tail { height: 1200px; }
</style>
<div id="box">target</div>
<div id="tail"></div>
`);
await win.addScriptTag({ path: cursorJs });
await win.addScriptTag({ path: domopsJs });
await win.evaluate(() => {
  const box = document.getElementById("box");
  const r = box.getBoundingClientRect();
  window.__sideagent.cursor.mark(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    "Step 1",
    "#box",
  );
});
const winBefore = await win.evaluate(() => window.__sideagent.markLayout()[0]);
await win.evaluate(() => window.scrollTo(0, 120));
await win.waitForTimeout(40);
const winAfter = await win.evaluate(() => {
  const box = document.getElementById("box").getBoundingClientRect();
  return {
    layout: window.__sideagent.markLayout()[0],
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
});
const winOff = markOffsetFromBox(winAfter.layout, winAfter.box, winAfter.scrollX, winAfter.scrollY, 6);
if (Math.abs(winOff.dx) > 2 || Math.abs(winOff.dy) > 2) {
  fail(`window 滚动后 mark 未箍住目标 dx=${winOff.dx} dy=${winOff.dy}`);
}
if (Math.abs(winAfter.layout.y - winBefore.y) > 2) {
  fail(`window 滚动后文档坐标不应漂 before=${winBefore.y} after=${winAfter.layout.y}`);
}

await nested.close();
await win.close();
await browser.close();

if (process.exitCode) {
  console.error("overlay-check FAILED");
  process.exit(1);
}
console.log(`PASS overlay-check 截图 ${outDir}`);
console.log(`  mark ${before.x},${before.y} → ${after.x},${after.y}`);
console.log(`  nested-scroll dy=${nestedBefore.box.y - nestedAfter.box.y} markOff=${JSON.stringify(nestedOff)}`);
console.log(`  window-scroll docY ${winBefore.y} → ${winAfter.layout.y}`);
