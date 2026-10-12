// 冒烟：播一遍，按时间截图，检查报错、星号外露、结束后残留 span。
import { createRequire } from "module";
const require = createRequire("/workspace/By-Your-Side/package.json");
const { chromium } = require("playwright");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 824, height: 860 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));
page.on("console", (m) => m.type() === "error" && console.error("CONSOLE", m.text()));
await page.goto("file:///workspace/bys-stream-proto/index.html?rec=1");
await page.waitForTimeout(800);
await page.evaluate(() => window.__start());
const t0 = Date.now(); const stars = { cur: 0, new: 0 }; let maxSpans = { cur: 0, new: 0 };
const shots = [3500, 6500, 8200, 10500, 14000];
while (Date.now() - t0 < 15800) {
  for (const v of ["cur", "new"]) {
    const f = page.frame({ url: new RegExp(`v=${v}`) });
    const r = await f.evaluate(() => { const a = document.querySelectorAll(".msg.assistant")[1]; return a ? { stars: a.textContent.includes("*") && !a.textContent.includes("A*") ? 1 : (a.textContent.match(/\*/g) || []).length > 1 ? 1 : 0, spans: a.querySelectorAll(".reveal-fade,.chunk-fade").length } : null; });
    if (r) { stars[v] += r.stars; maxSpans[v] = Math.max(maxSpans[v], r.spans); }
  }
  const el = Date.now() - t0;
  if (shots.length && el >= shots[0]) { await page.screenshot({ path: `/tmp/chk-${shots.shift()}.png` }); }
  await page.waitForTimeout(40);
}
for (const v of ["cur", "new"]) {
  const f = page.frame({ url: new RegExp(`v=${v}`) });
  console.log(v, await f.evaluate(() => { const a = document.querySelectorAll(".msg.assistant")[1]; return { spansEnd: a.querySelectorAll("span").length, html: a.innerHTML.slice(0, 160), text: a.textContent.length, stats: window.__streamer?.stats, paints: window.__paints }; }));
}
console.log("star-samples", stars, "maxSpans", maxSpans);
await browser.close();
