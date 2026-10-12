// 用 CDP 截屏流录侧栏（2x DPR，PNG 帧，按真实时间戳拼成 30fps H.264）。
import { createRequire } from "module";
import fs from "fs";
import { execFileSync } from "child_process";
const require = createRequire("/workspace/By-Your-Side/package.json");
const { chromium } = require("playwright");
const v = process.argv[2] || "A"; const run = process.argv[3] || "ok";
const dir = `/tmp/rec-${v}-${run}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 380, height: 720 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));
await page.goto(`file:///workspace/bys-proto-steps/index.html?rec=1&v=${v}&run=${run}`);
await page.waitForTimeout(500);
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async (f) => {
  const i = frames.length; const file = `${dir}/f${String(i).padStart(5, "0")}.png`;
  fs.writeFileSync(file, Buffer.from(f.data, "base64"));
  frames.push({ file, ts: f.metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 760, maxHeight: 1440 });
// 静止时 Chrome 不发帧：开一个 1px 看不见的动画逼它一直出帧
await page.addStyleTag({ content: "body::after{content:'';position:fixed;right:0;bottom:0;width:1px;height:1px;animation:tick 1s linear infinite}@keyframes tick{to{opacity:.99}}" });
await page.evaluate(() => window.__start());
await page.waitForFunction(() => window.__recDone === true, null, { timeout: 60000, polling: 100 });
await cdp.send("Page.stopScreencast");
await browser.close();
const end = frames[frames.length - 1].ts + 0.04;
let list = "";
frames.forEach((f, i) => { const d = (i + 1 < frames.length ? frames[i + 1].ts : end) - f.ts; list += `file '${f.file}'\nduration ${Math.max(0.001, d).toFixed(4)}\n`; });
list += `file '${frames[frames.length - 1].file}'\n`;
fs.writeFileSync(`${dir}/list.txt`, list);
fs.mkdirSync("videos", { recursive: true });
const out = run === "ok" ? `videos/${v}.mp4` : `videos/${v}-${run}.mp4`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}/list.txt`, "-vf", "fps=30,scale=760:-2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-movflags", "+faststart", out]);
console.log(out, frames.length, "frames", (end - frames[0].ts).toFixed(1), "s");
