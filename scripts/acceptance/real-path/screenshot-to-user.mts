/**
 * 「把这页截个图给我」验收（docs/evals/20261002-tier1-product-gaps.md 标准 1，评测 BYS-049）。
 *
 * 只装扩展的隔离无头 Chrome、真侧栏；模型换成本机脚本模型（设置页「自定义地址」），按脚本调用产品的 screenshot 工具。
 * 练习页整页是一种少见的绿色，截图对不对用像素颜色和尺寸判，不看模型说了什么。
 *
 *   npx tsx scripts/acceptance/real-path/screenshot-to-user.mts --headless
 *
 * 先列失败方式，判据逐条对应：
 *   imageShown     用户要截图的那一轮结束后，侧栏回答区没有一张解码出来的图片（旧代码在这里失败：只有一句「这是当前页面的截图」）。
 *   isThePage      图片不是这页：尺寸不等于工作页视口的 CSS 尺寸，或图中取样点不是练习页的绿色（拿到的是空白、别的页或占位图）。
 *   inAnswerArea   图片在用户消息之前、折叠的执行过程里，或排在回答之前（用户读完回答看不到）。
 *   noLeak         侧栏文字里出现图片的 base64 正文或工具名 screenshot。
 *   enlarge        点图片不开新标签页，或新标签页里的图不是同一尺寸、不是同一种绿色。
 *   download       点「下载」得不到 PNG 文件，或文件尺寸、颜色和图片不一致。
 *   selfUseHidden  模型为自己看页面而截的图（没说要给用户）也出现在侧栏里。
 *   replay         重新载入侧栏、从会话菜单切回这段（后台按历史回放），图片不见了或变成坏图。
 *
 * 产物：out/acceptance/real-path/<时间>-screenshot-to-user/ 下 summary.json、侧栏与查看页截图、下载的 PNG。
 */
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

/** 练习页底色：rgb(23, 151, 104)。取样容差 6，PNG 无损，只防色彩管理的细微偏差。 */
const GREEN = [23, 151, 104] as const;

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>截图练习页</title>
<style>html,body{margin:0;height:100%;background:rgb(${GREEN.join(",")})}h1{margin:0;padding:24px;color:#fff;font:600 28px sans-serif}</style>
</head><body><h1>截图练习页</h1></body></html>`;

const ASK = "把这页截个图给我";

const SELF = "这页主色是什么颜色";

const RULES: Rule[] = [
  { match: ASK, steps: [{ tool: { name: "screenshot", args: { forUser: true } } }, { text: "这是当前页面的截图。" }] },
  { match: SELF, steps: [{ tool: { name: "screenshot", args: {} } }, { text: "这页的主色是绿色。" }] },
];

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-screenshot-to-user`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const model = await startScriptedModel(RULES);

const rp = await launchRealPath();

const checks: Record<string, boolean> = {};

const evidence: JsonRecord = {};

let fatal: string | null = null;

let panel = "";

/** 侧栏里看得见的图片：解码尺寸、在消息流中相对最后一条回答的位置、是否在折叠区里、取样点颜色。 */
const PANEL_STATE = `(async () => {
  const messages = document.querySelector("#messages");
  const nodes = messages ? [...messages.querySelectorAll("*")] : [];
  const answers = [...document.querySelectorAll("#messages .msg.assistant")];
  const lastAnswer = answers.at(-1) ?? null;
  const users = [...document.querySelectorAll("#messages .msg.user")];
  const lastUser = users.at(-1) ?? null;
  const images = [];
  for (const img of messages ? messages.querySelectorAll("img") : []) {
    await img.decode().catch(() => {});
    if (!img.naturalWidth || img.getClientRects().length === 0) continue;
    let sample = null;
    try {
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      sample = [...g.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight * 0.75), 1, 1).data.slice(0, 3)];
    } catch {}
    const at = nodes.indexOf(img);
    images.push({ w: img.naturalWidth, h: img.naturalHeight, sample, inDetails: !!img.closest("details"),
      afterLastAnswer: !!lastAnswer && at > nodes.indexOf(lastAnswer), afterLastUser: !!lastUser && at > nodes.indexOf(lastUser),
      card: img.closest(".artifact-card")?.dataset.filename ?? null });
  }
  return {
    ready: document.querySelector("#send-btn")?.disabled === false,
    busy: !!(document.querySelector("#status-pill")?.classList.contains("running") || document.querySelector("#send-btn")?.classList.contains("stopping") || document.querySelector(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: users.length,
    images,
    text: messages?.innerText ?? "",
  };
})()`;

type PanelImage = { w: number; h: number; sample: number[] | null; inDetails: boolean; afterLastAnswer: boolean; afterLastUser: boolean; card: string | null };

type PanelState = { ready: boolean; busy: boolean; userMessages: number; images: PanelImage[]; text: string };

// SAFETY: PANEL_STATE 返回的字段与 PanelState 一一对应。
const readPanel = async () => (await rp.evaluate(panel, PANEL_STATE)) as PanelState;

const isGreen = (rgb: readonly number[] | null | undefined) => !!rgb && rgb.length >= 3 && rgb.every((v, i) => Math.abs(v - GREEN[i]!) <= 6);

async function send(text: string) {
  const before = await readPanel();
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(async () => (await readPanel()).userMessages > before.userMessages || undefined, 10_000, `发出「${text}」`);
  await until(async () => {
    const s = await readPanel();

    return !s.busy && s.text.includes(text === ASK ? "这是当前页面的截图" : "主色是绿色") ? s : undefined;
  }, 60_000, `「${text}」这一轮结束`, 300);
  await sleep(1200);

  return readPanel();
}

/** PNG 文件头里的宽高，以及按行解码后取样点的颜色（只支持 8 位 RGB/RGBA、无隔行，CDP 截图就是这种）。 */
function decodePng(buf: Buffer): { w: number; h: number; sample: number[] | null } | null {
  if (buf.length < 33 || buf.toString("latin1", 1, 4) !== "PNG") return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const depth = buf[24];
  const color = buf[25];
  const channels = color === 6 ? 4 : color === 2 ? 3 : 0;

  if (depth !== 8 || !channels || buf[28] !== 0) return { w, h, sample: null };
  const idat: Buffer[] = [];

  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);

    if (type === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  let prev = Buffer.alloc(stride);
  const row = Math.floor(h * 0.75);
  let line = prev;

  for (let y = 0; y <= row; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    line = Buffer.alloc(stride);

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[x] = (src[x]! + pred) & 0xff;
    }

    prev = line;
  }

  const x = Math.floor(w / 2) * channels;

  return { w, h, sample: [line[x]!, line[x + 1]!, line[x + 2]!] };
}

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
  await until(async () => (await readPanel()).ready || undefined, 90_000, "侧栏就绪", 500);

  // 1. 用户要截图。
  const asked = await send(ASK);
  // 侧栏打开后工作页变窄：按截图那一刻的视口比，不按打开侧栏前的。
  // SAFETY: 表达式返回 {w,h}。
  const viewport = (await rp.evaluate(work, `({ w: innerWidth, h: innerHeight })`)) as { w: number; h: number };
  evidence.workViewport = viewport;
  await rp.screenshot(panel, join(artifacts, "panel-after-ask.png"));
  const shown = asked.images.filter((i) => i.afterLastUser);
  evidence.askImages = shown;
  const img = shown[0];
  checks.imageShown = shown.length === 1;
  checks.isThePage = !!img && img.w === viewport.w && img.h === viewport.h && isGreen(img.sample);
  checks.inAnswerArea = !!img && !img.inDetails && img.afterLastAnswer;
  checks.noLeak = !/iVBORw0KGgo|screenshot/i.test(asked.text);
  evidence.panelText = asked.text.slice(-600);

  if (img) {
    // 2. 点图片看大图。
    const viewerPrefix = `chrome-extension://${rp.extensionId}/artifact-viewer.html`;
    const before = new Set((await rp.targets()).filter((t) => t.url.startsWith(viewerPrefix)).map((t) => t.targetId));
    const imgSel = "#messages .artifact-card img";
    await rp.evaluate(panel, `document.querySelector(${JSON.stringify(imgSel)})?.scrollIntoView({ block: "center" }); true`);
    await sleep(300);
    await rp.click(panel, imgSel);
    const target = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.startsWith(viewerPrefix) && !before.has(t.targetId)), 10_000, "点图片打开查看页").catch(() => null);

    if (target) {
      const viewer = await rp.attach(target.targetId);

      await until(async () => (await rp.evaluate(viewer, `document.readyState === "complete" && !!document.querySelector("#view img")`).catch(() => false)) || undefined, 10_000, "查看页加载");

      // SAFETY: 表达式返回 {title,w,h,sample}。
      const big = (await rp.evaluate(viewer, `(async () => { const i = document.querySelector("#view img"); await i.decode().catch(() => {});
        const c = document.createElement("canvas"); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext("2d"); g.drawImage(i, 0, 0);
        return { title: document.title, w: i.naturalWidth, h: i.naturalHeight, sample: [...g.getImageData(Math.floor(i.naturalWidth / 2), Math.floor(i.naturalHeight * 0.75), 1, 1).data.slice(0, 3)] }; })()`)) as { title: string; w: number; h: number; sample: number[] };

      evidence.viewer = big;
      checks.enlarge = big.w === img.w && big.h === img.h && isGreen(big.sample);
      await rp.cdp.send("Target.activateTarget", { targetId: target.targetId }).catch(() => undefined);
      await sleep(500);
      await rp.screenshot(viewer, join(artifacts, "viewer-screenshot.png")).catch(() => undefined);
    } else checks.enlarge = false;

    // 3. 卡片上的「下载」。
    const dir = join(rp.dirs.downloads, "panel");
    await mkdir(dir, { recursive: true });
    await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
    await rp.click(panel, "#messages .artifact-card .artifact-download");
    const name = await until(async () => (await readdir(dir)).find((f) => !f.endsWith(".crdownload")), 10_000, "侧栏下载").catch(() => null);

    if (name) {
      const bytes = await readFile(join(dir, name));
      await writeFile(join(artifacts, `downloaded-${name}`), bytes);
      const png = decodePng(bytes);
      evidence.download = { name, bytes: bytes.length, png };
      checks.download = name.endsWith(".png") && !!png && png.w === img.w && png.h === img.h && isGreen(png.sample);
    } else checks.download = false;
  } else {
    checks.enlarge = false;
    checks.download = false;
  }

  // 4. 模型为自己看页面截图：侧栏不多一张图。
  const self = await send(SELF);
  evidence.selfImages = self.images;
  checks.selfUseHidden = self.images.filter((i) => i.afterLastUser).length === 0 && self.images.length === asked.images.length;
  await rp.screenshot(panel, join(artifacts, "panel-after-self-use.png"));

  // 5. 重新载入侧栏：后台按历史回放，图还在。
  for (const t of (await rp.targets()).filter((t) => t.url.includes("/artifact-viewer.html"))) await rp.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId }).catch(() => undefined);
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(1500);
  // 侧栏每次打开都进一段新会话；像用户一样从会话菜单切回刚才那段。
  await until(async () => (await readPanel()).ready || undefined, 30_000, "重载后侧栏就绪", 500);
  await rp.click(panel, "#conversation-switcher");
  // SAFETY: 表达式返回会话 id 字符串或 null。
  const previous = await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll("[data-conversation-id]")].find((b) => b.textContent.includes(${JSON.stringify(ASK)}))?.dataset.conversationId ?? null`)) as string | null, 10_000, "会话菜单里有刚才那段");

  await rp.click(panel, `[data-conversation-id="${previous}"]`);

  const reopened = await until(async () => {
    const s = await readPanel();

    return s.text.includes("主色是绿色") ? s : undefined;
  }, 20_000, "切回刚才那段会话后历史回放").catch(() => null);

  await sleep(800);
  const replayed = reopened ? await readPanel() : null;
  evidence.replayImages = replayed?.images ?? null;
  checks.replay = !!replayed && replayed.images.length === 1 && replayed.images[0]!.w === viewport.w && isGreen(replayed.images[0]!.sample);
  await rp.screenshot(panel, join(artifacts, "panel-after-reopen.png"));
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(fatal);

  if (panel) await rp.screenshot(panel, join(artifacts, "error-panel.png")).catch(() => undefined);
} finally {
  evidence.modelRequests = model.requests.map((r) => ({ rule: r.rule, step: r.step, status: r.status }));
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  await model.close().catch(() => undefined);
  site.closeAllConnections();
  site.close();
}

const pass = !fatal && Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);

await writeFile(join(artifacts, "summary.json"), JSON.stringify({
  case: "screenshot-to-user", contract: "docs/evals/20261002-tier1-product-gaps.md#标准-1", startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  status: pass ? "pass" : "fail", checks, evidence, fatal,
}, null, 2));

console.log(`${pass ? "PASS" : "FAIL"} screenshot-to-user ${JSON.stringify(checks)} ${artifacts}`);

process.exit(pass ? 0 : 1);
