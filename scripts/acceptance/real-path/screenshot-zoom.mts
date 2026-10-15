/**
 * 页面缩放不是 100% 时，「把这页截个图给我」仍然给出这页的图。
 *
 * 只装扩展的隔离无头 Chrome、真侧栏；模型换成本机脚本模型，按脚本调用产品的 screenshot 工具。
 * 练习页底色绿，底边一条红带、右边一条蓝带（都贴着视口边）；屏幕按 2 倍像素（Retina），工作页缩放设成 90%，再往下滚 800 CSS 像素。
 * 先要一张普通截图（CSS 像素），再要一张原始像素的（设备像素，宽高不是整数时要先取整再裁）。
 * 截图对不对用尺寸和色带位置判：区域或比例错了，色带会偏、变粗或不见。
 *
 *   npx tsx scripts/acceptance/real-path/screenshot-zoom.mts --headless
 *
 * 先列失败方式，判据逐条对应：
 *   imageShown  侧栏回答区没有一张解码出来的图片卡片（旧代码在这里失败：截图报「像素比例与捕获区域不符」，图被丢掉）。
 *   size        图片尺寸不等于工作页视口的 CSS 尺寸。
 *   bands       中心不是绿；底边红带、右边蓝带不在边上；离边 60 CSS 像素处不是绿（色带被放大或区域偏了）。
 *   rawShown / rawSize / rawBands  同上，原始像素那张；尺寸按视口 CSS 尺寸乘 devicePixelRatio 判。
 *
 * 产物：out/acceptance/real-path/<时间>-screenshot-zoom/ 下 summary.json 和侧栏截图。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const ZOOM = 0.9;

const GREEN = [23, 151, 104] as const;

const RED = [220, 30, 40] as const;

const BLUE = [30, 60, 220] as const;

/** 色带宽 40 CSS 像素；取样在色带中间（离边 20）和色带外（离边 60）。 */
const BAND = 40;

const rgb = (c: readonly number[]) => `rgb(${c.join(",")})`;

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>缩放截图练习页</title>
<style>html,body{margin:0;background:${rgb(GREEN)};overflow-x:hidden}body{height:3000px}
#bottom{position:fixed;left:0;right:${BAND}px;bottom:0;height:${BAND}px;background:${rgb(RED)}}
#right{position:fixed;top:0;right:0;bottom:0;width:${BAND}px;background:${rgb(BLUE)}}</style>
</head><body><div id="bottom"></div><div id="right"></div></body></html>`;

const ASK = "把这页截个图给我";

const RAW = "再截一张原始像素的";

const RULES: Rule[] = [
  { match: ASK, steps: [{ tool: { name: "screenshot", args: { forUser: true } } }, { text: "这是当前页面的截图。" }] },
  { match: RAW, steps: [{ tool: { name: "screenshot", args: { forUser: true, scale: "raw" } } }, { text: "这是原始像素的截图。" }] },
];

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-screenshot-zoom`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const model = await startScriptedModel(RULES);

const rp = await launchRealPath({ chromeArgs: ["--force-device-scale-factor=2"] });

const checks: Record<string, boolean> = {};

const evidence: JsonRecord = {};

let fatal: string | null = null;

let panel = "";

/** 侧栏里用户消息之后的图片：解码尺寸和几个 CSS 位置上的颜色（按图宽与视口宽之比换算成图像像素）。 */
const panelState = (cssW: number) => `(async () => {
  const users = [...document.querySelectorAll("#messages .msg.user")];
  const lastUser = users.at(-1) ?? null;
  const nodes = [...document.querySelectorAll("#messages *")];
  const images = [];
  for (const img of document.querySelectorAll("#messages .artifact-card img")) {
    await img.decode().catch(() => {});
    if (!img.naturalWidth || img.getClientRects().length === 0 || !lastUser || nodes.indexOf(img) < nodes.indexOf(lastUser)) continue;
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const k = img.naturalWidth / ${cssW};
    const at = (x, y) => [...g.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data.slice(0, 3)];
    const w = img.naturalWidth / k, h = img.naturalHeight / k;
    images.push({ w: img.naturalWidth, h: img.naturalHeight,
      center: at(w / 2, h / 2), inBottom: at(w / 2, h - ${BAND / 2}), aboveBottom: at(w / 2, h - ${BAND + 20}),
      inRight: at(w - ${BAND / 2}, h / 2), leftOfRight: at(w - ${BAND + 20}, h / 2) });
  }
  return {
    ready: document.querySelector("#send-btn")?.disabled === false,
    busy: !!(document.querySelector("#status-pill")?.classList.contains("running") || document.querySelector("#send-btn")?.classList.contains("stopping") || document.querySelector(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: users.length,
    images,
    text: document.querySelector("#messages")?.innerText ?? "",
  };
})()`;

type Rgb = number[];

type PanelImage = { w: number; h: number; center: Rgb; inBottom: Rgb; aboveBottom: Rgb; inRight: Rgb; leftOfRight: Rgb };

type PanelState = { ready: boolean; busy: boolean; userMessages: number; images: PanelImage[]; text: string };

const near = (got: Rgb | undefined, want: readonly number[]) => !!got && want.every((v, i) => Math.abs(v - got[i]!) <= 6);

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const url = `http://127.0.0.1:${siteAddress(site).port}/`;
  await rp.cdp.send("Page.navigate", { url }, work);
  await sleep(800);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });

  // 像用户在浏览器里按 Cmd- 一样设页面缩放（按站点记住的那种）。
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  evidence.zoom = await rp.evaluate(sw, `chrome.tabs.query({}).then(async (ts) => { const t = ts.find((t) => t.url === ${JSON.stringify(url)}); await chrome.tabs.setZoom(t.id, ${ZOOM}); return chrome.tabs.getZoom(t.id); })`);
  await rp.evaluate(work, "scrollTo(0, 800), true");
  await sleep(500);
  await until(async () => (await rp.evaluate(panel, panelState(1)) as PanelState).ready || undefined, 90_000, "侧栏就绪", 500);

  // SAFETY: 表达式返回 {w,h,dpr}。
  const viewport = (await rp.evaluate(work, `({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollY })`)) as { w: number; h: number; dpr: number; scrollY: number };
  evidence.workViewport = viewport;
  // SAFETY: panelState 返回的字段与 PanelState 一一对应。
  const read = async () => (await rp.evaluate(panel, panelState(viewport.w))) as PanelState;

  async function ask(text: string, reply: string) {
    const before = await read();
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => (await read()).userMessages > before.userMessages || undefined, 10_000, `发出「${text}」`);
    await until(async () => {
      const s = await read();

      return !s.busy && s.text.includes(reply) ? s : undefined;
    }, 60_000, `「${text}」这一轮结束`, 300);
    await sleep(1200);

    return read();
  }

  const bandsRight = (img: PanelImage | undefined) => !!img && near(img.center, GREEN) && near(img.inBottom, RED) && near(img.aboveBottom, GREEN) && near(img.inRight, BLUE) && near(img.leftOfRight, GREEN);

  const css = await ask(ASK, "这是当前页面的截图");
  await rp.screenshot(panel, join(artifacts, "panel-after-ask.png"));
  evidence.images = css.images;
  const img = css.images[0];
  checks.imageShown = css.images.length === 1;
  checks.size = !!img && Math.abs(img.w - viewport.w) <= 1 && Math.abs(img.h - viewport.h) <= 1;
  checks.bands = bandsRight(img);

  const raw = await ask(RAW, "这是原始像素的截图");
  await rp.screenshot(panel, join(artifacts, "panel-after-raw.png"));
  evidence.rawImages = raw.images;
  evidence.panelText = raw.text.slice(-600);
  const rawImg = raw.images[0];
  checks.rawShown = raw.images.length === 1;
  checks.rawSize = !!rawImg && Math.abs(rawImg.w - viewport.w * viewport.dpr) <= 1 && Math.abs(rawImg.h - viewport.h * viewport.dpr) <= 1;
  checks.rawBands = bandsRight(rawImg);
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
  case: "screenshot-zoom", startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  status: pass ? "pass" : "fail", checks, evidence, fatal,
}, null, 2));

console.log(`${pass ? "PASS" : "FAIL"} screenshot-zoom ${JSON.stringify(checks)} ${artifacts}`);

process.exit(pass ? 0 : 1);
