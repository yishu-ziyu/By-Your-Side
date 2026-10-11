// 静图：播放中按时刻截两张（2x）。用法：node tools/still.mjs [serif]
import { createRequire } from "module";
const require = createRequire("/workspace/By-Your-Side/package.json");
const { chromium } = require("playwright");
const serif = process.argv[2] === "serif";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 824, height: 904 } });
const page = await ctx.newPage();
await page.goto(`file:///workspace/bys-stream-proto/index.html?rec=1${serif ? "&serif=1" : ""}`);
await page.waitForTimeout(1000);
await page.evaluate(() => window.__start());
const t0 = Date.now();
const plan = serif ? [[7000, "stills/still-serif-mid.png"], [15000, "stills/still-serif-end.png"]] : [[6950, "stills/still-mid.png"], [15000, "stills/still-end.png"]];
for (const [ms, file] of plan) { await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0))); await page.screenshot({ path: file }); console.log(file, Date.now() - t0); }
await browser.close();
