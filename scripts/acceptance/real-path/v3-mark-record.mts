/**
 * 给人看的 V3：两行过程块，16px 墨点收合。并排上一版 V3，再给一张放大的墨点。
 *   npx tsx scripts/acceptance/real-path/v3-mark-record.mts --headless
 */
import { mkdir, writeFile, copyFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { capturePng, copyArtifacts, readProcess, recordClip } from "./record-clip.mts";

requireHeadless();

const dest = "/opt/cursor/artifacts/v3-mark";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-v3-mark`);
const prev = join(REPO, "out/acceptance/real-path/2026-10-12T10-16-06-368Z-round2/v3.mp4");
await mkdir(out, { recursive: true });
await mkdir(dest, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main><p>Start here.</p></main></body></html>`;
const PAGE_B = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page B</title><body><main><h1>Works</h1><button id="ok">作品</button></main></body></html>`;
const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? PAGE_B : PAGE_A));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "案例：打开作品页，点作品。";
const ANSWER = "已经点开作品。";
const port = siteAddress(site).port;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${port}/b` } }, delayMs: 4_000 },
    { tool: { name: "js", args: { code: "(() => document.title)()", purpose: "读出标题", readonly: true } } },
    { tool: { name: "click", args: { target: "#gone", label: "不存在的按钮" } } },
    { tool: { name: "click", args: { target: "#ok", label: "作品" } }, delayMs: 8_000 },
    { text: ANSWER },
  ] },
]);

const READ_MARK = `(() => {
  const beat = [...document.querySelectorAll("#messages details.run-steps .run-beat")].at(-1);
  if (!beat) return null;
  const r = beat.getBoundingClientRect();
  const pad = 6;
  return {
    x: Math.max(0, r.x - pad),
    y: Math.max(0, r.y - pad),
    width: r.width + pad * 2,
    height: r.height + pad * 2,
    display: getComputedStyle(beat).display,
    widthPx: parseFloat(getComputedStyle(beat).width),
  };
})()`;

const FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc";
const inventory: Record<string, unknown> = { prev };
const rp = await launchRealPath();

try {
  await access(prev);
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-fixture" },
  })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);

  await until(async () => {
    const read = await readProcess(rp, panel);
    return read && read.phase === "thinking" && /已做 \d+ 步/.test(read.meta) ? read : undefined;
  }, 60_000, "两行过程块", 50);
  await sleep(200);
  const live = await readProcess(rp, panel);
  if (!live?.meta) throw new Error(`录屏时没有第二行：${JSON.stringify(live)}`);
  inventory.live = live;

  const clip = await recordClip(rp, panel, out, "v3-now", 6_000, 10);
  const twoLine = clip.reads.filter((read) => /已做 \d+ 步/.test(read.meta)).length;
  inventory.twoLineFrames = twoLine;
  if (twoLine < 8) throw new Error(`6 秒里只有 ${twoLine} 帧看得到第二行`);

  const markBox = await rp.evaluate(panel, READ_MARK) as { x: number; y: number; width: number; height: number; display: string; widthPx: number } | null;
  if (!markBox || markBox.display === "none" || markBox.widthPx < 14) throw new Error(`墨点没有按 16px 画出来：${JSON.stringify(markBox)}`);
  const markRaw = join(out, "mark-raw.png");
  await capturePng(rp, panel, markRaw, markBox);
  const { data } = await rp.cdp.send("Page.captureScreenshot", {
    format: "png", fromSurface: true,
    clip: { x: markBox.x, y: markBox.y, width: markBox.width, height: markBox.height, scale: 4 },
  }, panel);
  if (!data) throw new Error("墨点放大截图没有数据");
  await writeFile(markRaw, Buffer.from(data, "base64"));

  const mark = join(out, "mark-2x.png");
  const zoom = spawnSync("ffmpeg", [
    "-y", "-i", markRaw,
    "-vf", "scale=iw*2:ih*2:flags=neighbor,pad=160:160:(ow-iw)/2:(oh-ih)/2:white",
    mark,
  ], { encoding: "utf8" });
  if (zoom.status !== 0) throw new Error(`ffmpeg 放大墨点失败：${zoom.stderr.slice(-400)}`);

  const still = join(out, "v3-twoline.png");
  const mid = clip.reads.map((read, index) => ({ read, index })).filter((item) => /已做 \d+ 步/.test(item.read.meta));
  const pick = mid[Math.floor(mid.length / 2)] ?? { index: Math.floor((clip.reads.length - 1) / 2) };
  await copyFile(join(out, "v3-now-frames", `${String(pick.index).padStart(4, "0")}.png`), still);

  const compare = join(out, "v3-compare.mp4");
  const font = `fontfile=${FONT}:fontsize=18:fontcolor=0x5f5e58`;
  const stack = spawnSync("ffmpeg", [
    "-y", "-t", "6", "-i", prev, "-t", "6", "-i", clip.mp4,
    "-filter_complex",
    `[0:v]scale=380:180:force_original_aspect_ratio=decrease,pad=380:180:0:28:white,setsar=1,drawtext=text='之前 V3':x=10:y=6:${font}[a];` +
    `[1:v]scale=380:180:force_original_aspect_ratio=decrease,pad=380:180:0:28:white,setsar=1,drawtext=text='现在 V3':x=10:y=6:${font}[b];` +
    `[a][b]hstack=inputs=2`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", compare,
  ], { encoding: "utf8" });
  if (stack.status !== 0) throw new Error(`ffmpeg 并排失败：${stack.stderr.slice(-400)}`);

  inventory.artifacts = await copyArtifacts([compare, mark, still], dest);
} catch (error) {
  inventory.error = String(error);
  throw error;
} finally {
  await writeFile(join(out, "inventory.json"), JSON.stringify(inventory, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
console.log(`制品：${dest}`);
