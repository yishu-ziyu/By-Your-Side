// #69 光标弹簧：用构建好的 content-cursor.js 量飞行。每帧采样光标位置，报告过冲、点击时刻（move 返回的 ms）离目标多远、多久停稳。
// node scripts/probes/motion/cursor-spring.mjs [label]   （先 cd extension && npm run build）
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.setContent('<meta charset="utf-8"><button id="b" style="position:absolute;left:0;top:0;width:10px;height:10px">x</button>');

await page.evaluate(() => { window.chrome = { runtime: { getURL: () => '', sendMessage: (_m, done) => done?.({ ok: true }) } }; const attach = Element.prototype.attachShadow; Element.prototype.attachShadow = function (o) { const s = attach.call(this, o); (window.roots ??= []).push(s);

  return s; }; });

await page.addScriptTag({ path: 'extension/dist/content-cursor.js' });

const rows = [];

for (const d of [120, 400, 900]) {
  const r = await page.evaluate(async (d) => {
    const c = window.__sideagent.cursor;
    const el = () => window.roots.map((s) => s.querySelector('.cursor')).find(Boolean);
    const at = () => Number(/translate\(([-\d.]+)px/.exec(el().style.transform)?.[1]);
    const settle = () => new Promise((ok) => setTimeout(ok, 1500));
    c.move(100, 300); await settle();
    const x0 = at();
    const t0 = performance.now(), ms = c.move(100 + d, 300), samples = [];
    await new Promise((ok) => { const f = () => { samples.push([performance.now() - t0, at() - x0]);

 if (performance.now() - t0 < 1200) requestAnimationFrame(f); else ok(); };

 requestAnimationFrame(f); });
    const peak = Math.max(...samples.map((s) => s[1]));
    const atClick = samples.find((s) => s[0] >= ms)?.[1];
    const settled = samples.findLast((s) => Math.abs(s[1] - d) > 0.5)?.[0];

    return { distance: d, start_x: x0, flight_ms: ms, overshoot_px: +(peak - d).toFixed(1), off_at_click_px: +(atClick - d).toFixed(1), settled_ms: Math.round(settled ?? 0) };
  }, d);

  rows.push(r);
}

console.log(process.argv[2] ?? '', JSON.stringify(rows));

await browser.close();
