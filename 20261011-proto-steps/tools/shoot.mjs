import { createRequire } from "module";
const require = createRequire("/workspace/By-Your-Side/package.json");
const { chromium } = require("playwright");
const base = "file:///workspace/bys-proto-steps/index.html";
const [, , what = "check", ...rest] = process.argv;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--font-render-hinting=none"] });
const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 2600, height: 1400 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE", m.text()); });
async function grid(qs, out) {
  await page.goto(`${base}?${qs}`);
  await page.waitForFunction(() => window.__gridDone === true, null, { timeout: 30000 });
  const box = await page.evaluate(() => { const r = document.body.getBoundingClientRect(); return { w: Math.ceil(document.body.scrollWidth), h: Math.ceil(document.body.scrollHeight) }; });
  await page.setViewportSize({ width: Math.max(400, box.w), height: Math.max(300, box.h) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out, fullPage: true });
  console.log("wrote", out);
}
if (what === "stills") for (const v of (rest.length ? rest : ["A", "B", "C"])) await grid(`grid=stills&v=${v}`, `stills/${v}.png`);
if (what === "compare") await grid(`grid=compare&h=400`, `stills/compare.png`);
if (what === "page") { await page.setViewportSize({ width: 1100, height: 900 }); await page.goto(`${base}?v=${rest[0] || "A"}&t=${rest[1] || 30}`); await page.waitForTimeout(800); await page.screenshot({ path: `/tmp/page.png` }); console.log("wrote /tmp/page.png"); }
if (what === "compare-ac") await grid(`grid=compare&h=400&rows=cur,AC&run=err`, `stills/compare-AC.png`);
await browser.close();
