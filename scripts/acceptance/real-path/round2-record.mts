/**
 * 第二轮给人看的片子：三种心跳并排 + 修好的扇形/五路。只留 ≤8 个制品。
 *   npx tsx scripts/acceptance/real-path/round2-record.mts --headless
 */
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { capturePng, copyKeyedFrame, readProcess, recordClip, type ProcessRead } from "./record-clip.mts";

requireHeadless();

const dest = "/opt/cursor/artifacts/round2";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-round2`);
await mkdir(out, { recursive: true });
await mkdir(dest, { recursive: true });

const page = (title: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><main><h1>${title}</h1></main></body></html>`;
const seen = new Set<string>();
const site = createServer((req, res) => {
  const url = req.url ?? "/";
  const name = url === "/p2" ? "Tab B" : url === "/p3" ? "Tab C" : url === "/p4" ? "Tab D" : url === "/b" ? "Page B" : "Tab A";
  const delay = url === "/a" || url === "/b" || (url === "/p1" && !seen.has(url)) ? 0 : 5_200;
  seen.add(url);
  setTimeout(() => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(name)), delay);
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const port = siteAddress(site).port;

const ASK_THINK = "案例：打开作品页，点作品。";
const ASK_GRAPH = "案例：每个去查一下是否开源";
const ANSWER_THINK = "已经点开作品。";
const ANSWER_GRAPH = "查过了，三个开源，两个接口没回。";
const tab = (path: string) => ({ name: "tabs", args: { action: "open", url: `http://127.0.0.1:${port}${path}` } });
const grab = (purpose: string, fail?: string) => ({
  name: "js",
  args: {
    purpose,
    readonly: true,
    code: fail
      ? `(() => new Promise((_, reject) => setTimeout(() => reject(new Error(${JSON.stringify(fail)})), 3200)))()`
      : "(() => new Promise((resolve) => setTimeout(() => resolve('GPL-3.0'), 3600)))()",
  },
});

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK_THINK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${port}/b` } }, delayMs: 8_000 },
    { text: ANSWER_THINK },
  ] },
  { match: ASK_GRAPH, steps: [
    { tools: [tab("/p1"), tab("/p2"), tab("/p3"), tab("/p4")], delayMs: 280 },
    { text: "_" }, { text: "_" }, { text: "_" },
    { tools: [
      grab("抓取 api.github.com"),
      grab("抓取 gitlab.com"),
      grab("抓取 codeberg.org"),
      grab("抓取 huggingface.co", "接口没回（HTTP 0）"),
      grab("抓取 npmjs.com", "连不上这个地址"),
    ], delayMs: 360 },
    { text: "_" }, { text: "_" }, { text: "_" }, { text: "_" },
    { tool: grab("重试许可证"), delayMs: 400 },
    { text: ANSWER_GRAPH },
  ] },
]);

const liveOf = (read: ProcessRead, kind: string, lanes: number) =>
  (read.groups ?? []).some((g) => g.kind === kind && (g.state === "live" || g.state === "merging") && g.lanes >= lanes);
const deadOf = (read: ProcessRead) => /接口没回|连不上/.test(JSON.stringify(read.groups) + read.title + read.meta + read.text);

const rp = await launchRealPath();
const inventory: Record<string, unknown> = {};

const ready = async (panel: string) => {
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  let panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-fixture" },
  })}).then(() => true)`);
  await ready(panel);
  await rp.cdp.send("Page.bringToFront", {}, work);

  const clips: string[] = [];
  const stills: string[] = [];
  for (const variant of ["v1", "v2", "v3"] as const) {
    await rp.evaluate(panel, `document.documentElement.dataset.heartbeat=${JSON.stringify(variant)}; localStorage.setItem("sideagent.heartbeat", ${JSON.stringify(variant)}); true`);
    if (variant !== "v1") {
      await rp.click(panel, "#conversation-new");
      await ready(panel);
    }
    await rp.click(panel, "#input");
    await rp.typeText(panel, ASK_THINK);
    await rp.pressEnter(panel);
    await until(async () => (await readProcess(rp, panel))?.title ? true : undefined, 20_000, `${variant} 过程行`, 50);
    await sleep(400);
    const clip = await recordClip(rp, panel, out, variant, 7_000, 10);
    clips.push(clip.mp4);
    const mid = join(out, `${variant}-mid.png`);
    await copyFile(clip.frames[1]!, mid);
    stills.push(mid);
  }

  const stack = join(out, "heartbeat-variants.mp4");
  const stackPng = join(out, "heartbeat-variants.png");
  const scale = clips.map((_, i) => `[${i}:v]scale=380:140:force_original_aspect_ratio=decrease,pad=380:140:(ow-iw)/2:(oh-ih)/2:white,setsar=1,drawtext=text='V${i + 1}':x=8:y=8:fontsize=16:fontcolor=0x5f5e58:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf[v${i}]`).join(";");
  const stitch = spawnSync("ffmpeg", [
    "-y", "-i", clips[0]!, "-i", clips[1]!, "-i", clips[2]!,
    "-filter_complex", `${scale};[v0][v1][v2]hstack=inputs=3`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", stack,
  ], { encoding: "utf8" });
  if (stitch.status !== 0) throw new Error(`ffmpeg 并排失败：${stitch.stderr.slice(-400)}`);
  const stillsStack = spawnSync("ffmpeg", [
    "-y", "-i", stills[0]!, "-i", stills[1]!, "-i", stills[2]!,
    "-filter_complex", `[0:v]scale=380:140:force_original_aspect_ratio=decrease,pad=380:140:(ow-iw)/2:(oh-ih)/2:white[a];[1:v]scale=380:140:force_original_aspect_ratio=decrease,pad=380:140:(ow-iw)/2:(oh-ih)/2:white[b];[2:v]scale=380:140:force_original_aspect_ratio=decrease,pad=380:140:(ow-iw)/2:(oh-ih)/2:white[c];[a][b][c]hstack=inputs=3`,
    stackPng,
  ], { encoding: "utf8" });
  if (stillsStack.status !== 0) throw new Error(`ffmpeg 并排静帧失败：${stillsStack.stderr.slice(-400)}`);

  await rp.click(panel, "#conversation-new");
  await ready(panel);
  await rp.evaluate(panel, `document.documentElement.dataset.heartbeat="v3"; localStorage.setItem("sideagent.heartbeat","v3"); true`);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK_GRAPH);
  await rp.pressEnter(panel);
  const fan = await recordClip(rp, panel, out, "fan", 6_200, 10);
  const fanLive = await copyKeyedFrame(out, "fan", fan.reads, join(out, "fan-live.png"), (read) => liveOf(read, "b3", 4));
  await until(async () => {
    const read = await readProcess(rp, panel);
    return read && liveOf(read, "b1", 5) ? read : undefined;
  }, 20_000, "B1 五路", 50);
  const lanes = await recordClip(rp, panel, out, "lanes", 6_200, 10);
  const lanesLive = await copyKeyedFrame(out, "lanes", lanes.reads, join(out, "lanes-live.png"), (read) => liveOf(read, "b1", 5));
  const lanesDead = await copyKeyedFrame(out, "lanes", lanes.reads, join(out, "lanes-dead.png"), deadOf);
  await until(async () => (await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'))?.includes(ANSWER_GRAPH) ? true : undefined, 60_000, "回答", 100);
  await sleep(400);
  await capturePng(rp, panel, join(out, "folded.png"), (await readProcess(rp, panel))?.box);

  const files = [
    ["heartbeat-variants.mp4", stack],
    ["heartbeat-variants.png", stackPng],
    ["fan.mp4", fan.mp4],
    ["fan-live.png", fanLive ?? fan.frames[1]!],
    ["lanes.mp4", lanes.mp4],
    ["lanes-live.png", lanesLive ?? lanes.frames[1]!],
    ["lanes-dead.png", lanesDead ?? lanes.frames[2]!],
    ["folded.png", join(out, "folded.png")],
  ];
  const copied: string[] = [];
  for (const [name, src] of files) {
    const target = join(dest, name);
    await copyFile(src, target);
    copied.push(target);
  }
  inventory.out = out;
  inventory.artifacts = copied;
  inventory.fanLiveFrames = fan.reads.filter((read) => liveOf(read, "b3", 4)).length;
  inventory.lanesLiveFrames = lanes.reads.filter((read) => liveOf(read, "b1", 5)).length;
} catch (error) {
  inventory.error = String(error);
  throw error;
} finally {
  await writeFile(join(out, "inventory.json"), JSON.stringify(inventory, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
console.log(`制品：${dest}`);
