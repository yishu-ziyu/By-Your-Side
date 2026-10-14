/**
 * 页面右边缘的状态胶囊：只装扩展的隔离无头 Chrome、真侧栏、本机演示页（加入购物车）与本机脚本模型。
 *
 *   npx tsx scripts/acceptance/real-path/edge-tab.mts --headless
 *
 * 真实路径走：没有任务不显示 → 助手连续点两下（不缩回，做成变绿圈）→ 任务结束收起 → 用户接管时「现在归你」压过其他状态、
 * 点「继续」交还 → 别的标签页看到「在 〈那页〉 ↗」并能切回去 → 侧栏关着时点胶囊打开侧栏。
 * 等页面响应、结果不确定、没做成三种结果直接调页面脚本的入口（后台画它们用的是同一个入口），用来截图、比深浅色和减少动态效果。
 * 读数来自扩展隔离环境里的 __sideagent.edgeTab()；点击一律用真鼠标事件点在它报出的位置上。
 * 证据在 out/edge-tab/：每种状态浅色、深色各一张，拼成 sheet-light.png、sheet-dark.png；--record 时另录 run.mp4。
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/edge-tab");
const shots = join(out, "shots");
const record = process.argv.includes("--record");
/** 调试用：--from=others 跳过前面几段，直接从别的标签页那一段开始。 */
const fromOthers = process.argv.includes("--from=others");

await mkdir(shots, { recursive: true });

type Rect = { x: number; y: number; width: number; height: number };

type Tab = {
  shown: boolean; tone: string | null; a: string; b: string; end: string | null; endEnabled: boolean; width: number; rect: Rect | null; panel: string;
  bubble: { count: number; letter: string; rect: Rect } | null; list: { open: boolean; rows: Array<{ name: string; title: string; local: boolean; rect: Rect }> }; button: Rect | null;
};

const SHOP = `<!doctype html><meta charset="utf-8"><title>京东 · 降噪耳机</title><style>
body{margin:0;font:13px -apple-system,"PingFang SC",sans-serif;color:#333;background:#fff}
.nav{height:52px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:22px;padding:0 20px}.nav b{font-size:15px;color:#e1251b;margin-right:10px}
.hero{height:170px;background:linear-gradient(120deg,#ffd6c9 0%,#ffb199 35%,#9cc4ff 75%,#c9e6ff 100%);position:relative}
.hero p{position:absolute;left:28px;top:34px;margin:0;color:#fff;font-size:22px;font-weight:700;text-shadow:0 1px 8px #0003}
.items{display:flex;gap:14px;padding:22px 20px}.item{width:150px;border:1px solid #eee;border-radius:10px;padding:10px}
.item i{display:block;height:90px;border-radius:8px;background:#f3f3f5;margin-bottom:8px}
.item button{margin-top:10px;width:100%;height:28px;border:0;border-radius:14px;background:#e1251b;color:#fff;font:inherit;cursor:pointer}
#edge{position:fixed;right:0;top:220px;width:120px;height:28px}
</style><div class="nav"><b>京东</b><span>首页</span><span>手机</span><span>耳机</span><button id="cart" onclick="window.cartViews=(window.cartViews||0)+1">购物车 <span id="n">0</span></button></div>
<div class="hero"><p>降噪耳机 · 限时直降</p></div>
<div class="items">${["降噪耳机 Pro", "头戴耳机 Max", "运动耳机"].map((name, i) => `<div class="item"><i></i>${name}<button id="add${i + 1}" aria-label="加入购物车" onclick="document.querySelector('#n').textContent=++window.added">加入购物车</button></div>`).join("")}</div>
<button id="edge" onclick="window.edgeHits=(window.edgeHits||0)+1">贴边的网页按钮</button><script>window.added=0</script>`;

const OTHER = `<!doctype html><meta charset="utf-8"><title>资料 · 耳机评测</title><style>body{margin:40px;font:15px/1.8 -apple-system,"PingFang SC",sans-serif;max-width:560px}</style><h1>耳机评测</h1><p>用户在这一页阅读，助手在另一页加购物车。</p>`;

const CAPTIONS: Array<[string, string]> = [
  ["1-work", "1 · 在干活"], ["2-wait", "2 · 等页面响应"], ["3-unknown", "3 · 结果不确定"], ["4-failed", "4 · 没做成"], ["5-handoff", "5 · 现在归你（压过其他）"],
  ["6-others", "6 · 别页还有助手：小圆泡 +N"], ["7-done", "做成：绿圈画满再打勾"], ["8-away", "只有别页助手：在 〈那页〉 ↗"], ["9-list", "点小圆泡：向下展开列表"],
];

/** 把每种状态的截图拼成一页，再整页截图成 sheet-*.png。 */
const sheet = (scheme: string) => `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;width:1000px;background:${scheme === "dark" ? "#141310" : "#ecebf0"};font:13px -apple-system,"PingFang SC",sans-serif;color:${scheme === "dark" ? "#eee9df" : "#1d1d1f"}}
h1{font-size:18px;margin:0 0 14px}.g{display:grid;grid-template-columns:1fr 1fr;gap:14px}figure{margin:0;background:${scheme === "dark" ? "#1d1c18" : "#fff"};border-radius:10px;overflow:hidden}
figcaption{padding:8px 12px;font-weight:600}img{display:block;width:100%}</style><h1>右边缘胶囊 · ${scheme === "dark" ? "深色" : "浅色"}（真扩展截图）</h1><div class="g">${CAPTIONS.map(([file, caption]) => `<figure><figcaption>${caption}</figcaption><img src="/shots/${scheme}-${file}.png"></figure>`).join("")}</div>`;

const site = createServer((q, r) => {
  const url = q.url ?? "/";

  if (url.startsWith("/shots/")) {
    void readFile(join(shots, url.slice(7).replace(/[^\w.-]/g, ""))).then(png => r.writeHead(200, { "content-type": "image/png" }).end(png), () => r.writeHead(404).end());

    return;
  }

  r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(url.startsWith("/sheet-") ? sheet(url.slice(7)) : url.startsWith("/other") ? OTHER : SHOP);
});

await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const GOAL = "把降噪耳机 Pro 加进购物车";
const SLOW_GOAL = "慢慢加三样进购物车";
const PAUSE_GOAL = "加一半交给我";

const start = [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }];
const add = (i: number, delayMs = 1200) => ({ tool: { name: "click", args: { target: `#add${i}` } }, delayMs });

const model = await startScriptedModel([
  { match: GOAL, steps: [...start, add(1, 900), { tool: { name: "click", args: { target: "#cart" } }, delayMs: 900 }, { text: "加好了，购物车里有 1 件。", delayMs: 600 }] },
  // 助手在后台新开一页干活，用户留在自己看的页面：这才是「别的标签页还有助手」。
  { match: SLOW_GOAL, steps: [{ tool: { name: "tabs", args: { action: "open", url: `${origin}/?bg` } } }, add(1, 4000), add(2, 4000), add(3, 4000), add(1, 4000), add(2, 4000), add(3, 4000), { text: "都加好了。" }] },
  { match: PAUSE_GOAL, steps: [...start, add(1, 1500), add(2, 1500), add(3, 1500), { text: "加好了。" }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

// SAFETY: Tab 读数来自 CDP returnByValue，是可序列化的普通对象，可以直接写进证据。
const asJson = (v: unknown) => v as Json;

try {
  const workTarget = (await rp.targets()).find(t => t.url === "about:blank")!.targetId;
  const work = await rp.attach(workTarget);

  // 扩展内容脚本的读数在扩展的隔离环境里，网页自己的环境读不到：按会话记下隔离环境，逐个试。
  const isolated = new Map<string, Set<number>>();

  rp.cdp.onEvent("Runtime.executionContextCreated", (m: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (m.sessionId && m.params.context.auxData?.type === "isolated" && m.params.context.origin.startsWith("chrome-extension://")) {
      const set = isolated.get(m.sessionId) ?? new Set();
      set.add(m.params.context.id);
      isolated.set(m.sessionId, set);
    }
  });
  rp.cdp.onEvent("Runtime.executionContextDestroyed", (m: { sessionId?: string; params: { executionContextId: number } }) => { if (m.sessionId) isolated.get(m.sessionId)?.delete(m.params.executionContextId); });
  rp.cdp.onEvent("Runtime.executionContextsCleared", (m: { sessionId?: string }) => { if (m.sessionId) isolated.get(m.sessionId)?.clear(); });

  const inExtension = async <T,>(session: string, expression: string): Promise<T | null> => {
    for (const contextId of [...(isolated.get(session) ?? [])]) {
      // SAFETY: CDP Runtime.evaluate 返回 { result: { value } }；读数是可序列化的普通对象。
      const res = await rp.cdp.send("Runtime.evaluate", { expression: `(() => { const ns = globalThis.__sideagent; return ns?.cursor ? (${expression}) : undefined; })()`, contextId, returnByValue: true }, session).catch(() => null) as { result?: { value?: T } } | null;

      if (res?.result && res.result.value !== undefined) return res.result.value;
    }

    return null;
  };

  const tab = (session = work) => inExtension<Tab | null>(session, "ns.edgeTab?.() ?? null");
  const drive = (session: string, js: string) => inExtension<boolean>(session, `(${js}, true)`);
  const mouse = (session: string, type: string, at: { x: number; y: number }) => rp.cdp.send("Input.dispatchMouseEvent", { type, ...at, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }, session);

  const mouseClick = async (session: string, r: Rect) => {
    const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    await mouse(session, "mouseMoved", at);

    for (const type of ["mousePressed", "mouseReleased"]) await mouse(session, type, at);
  };

  const waitTab = (want: (t: Tab) => boolean, ms: number, label: string, session = work) => until(async () => { const t = await tab(session); return t && want(t) ? t : null; }, ms, label, 40);

  for (const session of [work]) { await rp.cdp.send("Runtime.enable", {}, session); await rp.cdp.send("Page.enable", {}, session); }
  // 录屏按真实像素录（帧和视口一样大）；截图用两倍像素。
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", record ? { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false } : { width: 1100, height: 640, deviceScaleFactor: 2, mobile: false }, work);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => (await inExtension<boolean>(work, "true")) ?? null, 15000, "演示页加载、扩展脚本就位");

  let panelId = await rp.openSidePanel();
  let panel = await rp.attach(panelId);
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await ready();
  await rp.cdp.send("Page.bringToFront", {}, work);
  const send = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const finished = () => until(async () => (await rp.evaluate(panel, '!!document.querySelector("#takeover-btn")?.hidden')) || null, 60000, "任务结束");

  const vw = Number(await rp.evaluate(work, "innerWidth"));

  if (!fromOthers) {
  // ── 没有任务：完全不显示 ──
  const idle = await tab();
  check("没有任务时不显示", !idle?.shown, asJson(idle));

  // ── 一次真实任务：连续两步不缩回，做成变绿圈，结束收起 ──
  // 逐帧截图拼视频：浏览器自带的录屏帧在改过视口后会被放大裁切，截图的位置才是准的。
  const frames: Array<{ at: number; file: string }> = [];
  let recording = record;
  const frameDir = record ? await mkdtemp(join(tmpdir(), "edge-tab-frames-")) : "";
  const recorder = (async () => {
    while (recording) {
      // SAFETY: Page.captureScreenshot 回包的 data 是 base64 JPEG。
      const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }, work) as { data: string };
      const file = join(frameDir, `${String(frames.length).padStart(5, "0")}.jpg`);
      await writeFile(file, Buffer.from(data, "base64"));
      frames.push({ at: Date.now(), file });
    }
  })();
  await send(GOAL);
  const acting = await waitTab(t => t.shown && t.tone === "work" && t.a === "在点", 30000, "胶囊伸出：在点");
  check("助手动手时伸出「在点 加入购物车」和停止键", acting.b.includes("加入购物车") && acting.end === "stop", asJson(acting));
  await sleep(700);
  const settled = (await tab())!;
  check("贴着视口右边、上边离顶部 64px", !!settled.rect && Math.abs(settled.rect.x + settled.rect.width + 1 - vw) <= 2 && Math.abs(settled.rect.y - 64) <= 1, asJson({ rect: settled.rect, vw }));

  // 每 40ms 采一次，直到任务结束：中间换步时胶囊一直在，宽度不掉回一小截。
  const samples: Array<{ at: number; shown: boolean; w: number; tone: string | null; a: string; b: string }> = [];
  const t0 = Date.now();
  let sawOk: Tab | null = null;

  while (Date.now() - t0 < 20000) {
    const t = await tab();

    if (t) samples.push({ at: Date.now() - t0, shown: t.shown, w: t.rect?.width ?? 0, tone: t.tone, a: t.a, b: t.b });

    if (t?.tone === "ok" && !sawOk) { sawOk = t; await rp.screenshot(work, join(out, "latest.png")); }

    if (!t?.shown) break;
    await sleep(40);
  }

  const running = samples.filter(s => s.shown);
  const texts = [...new Set(running.map(s => `${s.tone}:${s.a}${s.b}`))];
  check("做成后原地变成「已加入购物车」绿圈", !!sawOk && sawOk.a === "已" && sawOk.b.includes("加入购物车"), asJson(sawOk));
  check("连续多步不缩回：从伸出到收起之间一直显示，最窄也没缩回一小截", running.length > 20 && Math.min(...running.slice(5).map(s => s.w)) > 60 && running.some(s => s.a === "在点" && s.b.includes("购物车") && !s.b.includes("加入")), asJson({ n: running.length, minW: Math.min(...running.slice(5).map(s => s.w)), texts }));
  check("任务结束后收起", !(await tab())?.shown, asJson({ lastMs: samples.at(-1)?.at ?? null }));
  await finished();

  if (record) {
    await sleep(800);
    recording = false;
    await recorder;
    const list = frames.flatMap((f, i) => [`file '${f.file}'`, `duration ${(((frames[i + 1]?.at ?? f.at + 500) - f.at) / 1000).toFixed(3)}`]);
    list.push(`file '${frames.at(-1)!.file}'`);
    await writeFile(join(frameDir, "list.txt"), list.join("\n"));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(frameDir, "list.txt"), "-fps_mode", "cfr", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(out, "run.mp4")]);
    await rm(frameDir, { recursive: true, force: true });
    const size = (await stat(join(out, "run.mp4"))).size;
    check("录屏 run.mp4 小于 3MB", size < 3_000_000, { size, frames: frames.length });
  }

  // ── 只有胶囊接鼠标：紧贴胶囊下方的网页按钮照常能点 ──
  await drive(work, "ns.cursor.showFeedback({ id: 'probe', text: '没有执行', kind: 'failure' })");
  await waitTab(t => t.shown && t.tone === "err", 3000, "胶囊伸出");
  const edgeBox = await rp.evaluate(work, '(()=>{const r=document.querySelector("#edge").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()') as Rect;
  await mouseClick(work, edgeBox);
  check("胶囊下方的网页按钮照常能点", Number(await rp.evaluate(work, "window.edgeHits||0")) === 1, Number(await rp.evaluate(work, "window.edgeHits||0")));
  // 没做成不自动收起：过 3 秒还在；点胶囊本身才算看过，收起。
  await sleep(3000);
  check("没做成过 3 秒仍显示", (await tab())?.tone === "err", asJson(await tab()));
  await mouseClick(work, (await tab())!.rect!);
  await waitTab(t => !t.shown, 3000, "点一下没做成后收起").then(() => check("没做成不自动收起，点一下才收起", true, null), () => check("没做成不自动收起，点一下才收起", false, null));

  // ── 每种状态，浅色和深色各截一张；顺带比底色、量动画 ──
  const wallpaper = await readFile(join(REPO, "extension/src/sidepanel/styles.css"), "utf8");
  const panelColors = [...wallpaper.matchAll(/--wallpaper:\s*([^;]+);/g)].map(m => m[1]!.trim());

  const STATES: Array<[string, string]> = [
    ["1-work", "ns.cursor.beginAction('s1', 'click', undefined, document.querySelector('#add1'))"],
    ["2-wait", "(ns.cursor.endAction('s1', 'done'), ns.cursor.clearStatus(), ns.cursor.showFeedback({ id: 's2', text: '等待页面响应', kind: 'pending' }))"],
    ["3-unknown", "(ns.cursor.hideFeedback(), ns.cursor.beginAction('s3', 'click', undefined, undefined, '提交'), ns.cursor.endAction('s3', 'unknown'))"],
    ["4-failed", "(ns.cursor.beginAction('s4', 'fill', undefined, undefined, '收货地址'), ns.cursor.endAction('s4', 'failed'))"],
    ["5-handoff", "ns.cursor.showUserControl({ status: '现在归你', ask: '请先登录京东', action: '继续', actionEnabled: true })"],
    ["6-others", "(ns.cursor.hideUserControl(), ns.cursor.clearStatus(), ns.cursor.showCrossPage({ members: [{ sessionId: 'task-cast-omar-12345678', title: '京东 · 我的订单', tabId: 99999, state: 'reading' }] }), ns.cursor.beginAction('s6', 'click', undefined, document.querySelector('#add1')))"],
    ["7-done", "(ns.cursor.hideCrossPage(), ns.cursor.endAction('s6', 'done'))"],
  ];

  const crop = async (name: string) => {
    // SAFETY: Page.captureScreenshot 回包的 data 是 base64 PNG。
    const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: vw - 460, y: 30, width: 460, height: 200, scale: 2 } }, work) as { data: string };
    await writeFile(join(shots, `${name}.png`), Buffer.from(data, "base64"));
  };

  const readings: Record<string, Json> = {};

  for (const scheme of ["light", "dark"] as const) {
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, work);
    await drive(work, "(ns.cursor.hideUserControl(), ns.cursor.hideCrossPage(), ns.cursor.hideFeedback(), ns.cursor.clearStatus(), ns.cursor.hide())");
    await waitTab(t => !t.shown, 3000, "先收起");

    for (const [name, js] of STATES) {
      await drive(work, js);
      await sleep(name === "7-done" ? 900 : 1100);
      const t = (await tab())!;
      readings[`${scheme}:${name}`] = asJson({ tone: t.tone, a: t.a, b: t.b, end: t.end, bubble: t.bubble?.count ?? null, panel: t.panel });
      await crop(`${scheme}-${name}`);

      if (scheme === "light" && name === "5-handoff") await rp.screenshot(work, join(out, "latest.png"));
    }

    check(`${scheme === "light" ? "浅色" : "深色"}：胶囊底色等于侧栏底色`, (readings[`${scheme}:1-work`] as { panel: string }).panel === panelColors[scheme === "light" ? 0 : 1], asJson({ capsule: (readings[`${scheme}:1-work`] as { panel: string }).panel, sidepanel: panelColors }));
  }

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [] }, work);
  const r = readings as Record<string, { tone: string; a: string; b: string; end: string | null; bubble: number | null }>;
  check("在干活：在点 加入购物车 + 停止键", r["light:1-work"]!.tone === "work" && r["light:1-work"]!.end === "stop", r["light:1-work"]!);
  check("等页面响应：转圈 + 在等 页面响应 + 停止键", r["light:2-wait"]!.tone === "wait" && r["light:2-wait"]!.a === "在等" && r["light:2-wait"]!.end === "stop", r["light:2-wait"]!);
  check("结果不确定：点了提交 结果还不确定，不写「详情在侧栏」", r["light:3-unknown"]!.tone === "unk" && r["light:3-unknown"]!.a === "点了提交" && r["light:3-unknown"]!.b === "结果还不确定", r["light:3-unknown"]!);
  check("没做成：收货地址 没填进去", r["light:4-failed"]!.tone === "err" && r["light:4-failed"]!.a === "收货地址" && r["light:4-failed"]!.b === "没填进去", r["light:4-failed"]!);
  check("现在归你压过「没做成」，带「继续」", r["light:5-handoff"]!.tone === "hand" && r["light:5-handoff"]!.a === "现在归你" && r["light:5-handoff"]!.end === "继续", r["light:5-handoff"]!);
  check("别页还有助手：主胶囊照常、下方小圆泡 +1", r["light:6-others"]!.tone === "work" && r["light:6-others"]!.bubble === 1, r["light:6-others"]!);

  // ── 动画：伸出时宽度是长出来的；换内容时从当前形状接着变；减少动态效果时不伸缩 ──
  const sampleOpen = async (js: string) => {
    await drive(work, "(ns.cursor.hideUserControl(), ns.cursor.hideFeedback(), ns.cursor.clearStatus(), ns.cursor.hide())");
    await waitTab(t => !t.shown, 3000, "先收起");
    await sleep(300);
    await drive(work, js);
    const widths: number[] = [];

    for (let i = 0; i < 12; i++) { widths.push((await tab())?.rect?.width ?? 0); await sleep(25); }

    return { widths, final: (await waitTab(t => !!t.rect, 2000, "伸出"))!.width };
  };

  const normal = await sampleOpen("ns.cursor.showFeedback({ id: 'm1', text: '没有执行', kind: 'failure' })");
  check("伸出：宽度从一小截长到整句", normal.widths[0]! < normal.final * 0.6 && Math.max(...normal.widths) >= normal.final * 0.9, asJson(normal));
  // 打断：长句还在伸出，立刻换成短句，宽度从当时的位置接着变，不先缩回一小截。
  await drive(work, "(ns.cursor.hideFeedback(), ns.cursor.beginAction('m2', 'click', undefined, undefined, '加入购物车'))");
  await sleep(90);
  const midWidth = (await tab())!.rect!.width;
  await drive(work, "ns.cursor.endAction('m2', 'done')");
  const after: number[] = [];

  for (let i = 0; i < 15; i++) { after.push((await tab())?.rect?.width ?? 0); await sleep(25); }
  check("新状态来时从当前形状接着变，不跳回去", Math.min(...after) > Math.min(midWidth, after.at(-1)!) * 0.8, asJson({ midWidth, after }));

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, work);
  const calm = await sampleOpen("ns.cursor.showFeedback({ id: 'm3', text: '没有执行', kind: 'failure' })");
  check("减少动态效果：不伸缩，第一帧就是整句宽度（只淡入）", calm.widths.filter(w => w > 0).every(w => Math.abs(w - calm.final) <= 1), asJson(calm));
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [] }, work);
  await drive(work, "(ns.cursor.hideFeedback(), ns.cursor.clearStatus(), ns.cursor.hide())");

  // ── 现在归你：真实接管，优先级最高，点「继续」交还 ──
  await rp.click(panel, "#conversation-new"); await ready();
  await rp.cdp.send("Page.bringToFront", {}, work);
  const before = Number(await rp.evaluate(work, "window.added"));
  await send(PAUSE_GOAL);
  await until(async () => Number(await rp.evaluate(work, "window.added")) > before || null, 30000, "接管前点了第一下");
  // 让页面上同时挂着一条「没做成」：接管后它必须让位，不叠两层。
  await drive(work, "ns.cursor.showFeedback({ id: 'under', text: '没有执行', kind: 'failure' })");
  await rp.click(panel, "#takeover-btn");
  const handed = await waitTab(t => t.tone === "hand", 10000, "现在归你").catch(() => null);
  check("接管后胶囊是「现在归你」带「继续」，压过没做成", handed?.a === "现在归你" && handed.end === "继续" && handed.endEnabled, asJson(handed));
  const hosts = Number(await rp.evaluate(work, 'document.querySelectorAll("[data-sideagent-overlay=edge-tab]").length'));
  check("页面上只有一个胶囊", hosts === 1, hosts);
  await sleep(500);
  await mouseClick(work, (await tab())!.button!);
  const resumed = await until(async () => { const t = await tab(); return t && t.tone !== "hand" ? t : null; }, 15000, "点继续后交还").catch(() => null);
  check("点「继续」交还，胶囊离开「现在归你」", !!resumed, asJson(resumed));
  await finished();
  await drive(work, "(ns.cursor.hideFeedback(), ns.cursor.clearStatus())");

  }

  // ── 别的标签页：主胶囊「在 〈那页〉 ↗」，点它切过去；本页也有动作时，下方小圆泡 +1、展开列表 ──
  const otherTarget = (await rp.cdp.send("Target.createTarget", { url: `${origin}/other` })).targetId as string;
  const other = await rp.attach(otherTarget);
  await rp.cdp.send("Runtime.enable", {}, other);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 640, deviceScaleFactor: 2, mobile: false }, other);
  await rp.cdp.send("Target.activateTarget", { targetId: otherTarget });
  await until(async () => (await inExtension<boolean>(other, "true")) ?? null, 15000, "资料页扩展脚本就位");
  await rp.click(panel, "#conversation-new"); await ready();
  await send(SLOW_GOAL);
  const away = await waitTab(t => t.tone === "away", 30000, "别页胶囊", other).catch(async () => {
    console.log("诊断", JSON.stringify({ tab: await tab(other), active: await rp.evaluate(panel, "chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t.map(x=>x.url))") }));

    return null;
  });
  check("别的标签页显示「在 〈那页标题〉 ↗」", away?.a === "在" && away.b.includes("京东") && away.end === "arrow", asJson(away));
  await sleep(600);

  /** 浅色、深色各截一张同样大小的图。 */
  const shotOther = async (file: string) => {
    for (const scheme of ["light", "dark"]) {
      await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, other);
      await sleep(250);
      // SAFETY: Page.captureScreenshot 回包的 data 是 base64 PNG。
      const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: Number(await rp.evaluate(other, "innerWidth")) - 460, y: 30, width: 460, height: 200, scale: 2 } }, other) as { data: string };
      await writeFile(join(shots, `${scheme}-${file}.png`), Buffer.from(data, "base64"));
    }

    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [] }, other);
  };

  await shotOther("8-away");

  await drive(other, "ns.cursor.showFeedback({ id: 'o1', text: '等待页面响应', kind: 'pending' })");
  const withBubble = await waitTab(t => t.tone === "wait" && (t.bubble?.rect.width ?? 0) > 30, 5000, "小圆泡", other).catch(() => null);
  check("本页也有动作时，别页助手收进下方小圆泡 +1", withBubble?.bubble?.count === 1, asJson(withBubble));

  if (withBubble?.bubble) {
    await mouseClick(other, withBubble.bubble.rect);
    const opened = await waitTab(t => t.list.open && t.list.rows.length === 1, 3000, "列表展开", other).catch(() => null);
    check("点小圆泡向下展开列表", opened?.list.rows[0]?.title.includes("京东") === true, asJson(opened?.list ?? null));
    await sleep(400);
    await shotOther("9-list");
    await drive(other, "ns.cursor.hideFeedback()");
  }

  const back = await waitTab(t => t.tone === "away" && (t.rect?.width ?? 0) > 60, 8000, "回到在 〈那页〉", other).catch(() => null);

  if (back?.rect) await mouseClick(other, { ...back.rect, width: back.rect.width - 20 });
  const switched = await until(async () => String(await rp.evaluate(panel, "chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]?.url??'')")).endsWith("/?bg") || null, 6000, "切到工作页").catch(() => null);
  check("点「在 〈那页〉 ↗」切到助手在干活的页面", !!switched, asJson(switched));

  // ── 侧栏关着：胶囊贴在窗口右边，点它打开侧栏 ──
  const bgTarget = (await rp.targets()).find(t => t.url.endsWith("/?bg"))?.targetId;

  if (bgTarget) {
    const bg = await rp.attach(bgTarget);
    await rp.cdp.send("Runtime.enable", {}, bg);
    await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 640, deviceScaleFactor: 2, mobile: false }, bg);
    await rp.cdp.send("Target.closeTarget", { targetId: panelId });
    await sleep(800);
    const closedTab = await waitTab(t => t.shown && !!t.rect && t.rect.width > 60, 10000, "侧栏关着时胶囊仍在", bg).catch(() => null);
    const bgWidth = Number(await rp.evaluate(bg, "innerWidth"));
    check("侧栏关着时胶囊贴在窗口右边", !!closedTab?.rect && Math.abs(closedTab.rect.x + closedTab.rect.width + 1 - bgWidth) <= 2, asJson({ rect: closedTab?.rect ?? null, bgWidth }));

    if (closedTab?.rect) {
      // 点胶囊左半边（避开停止键）。
      await mouseClick(bg, { ...closedTab.rect, width: 40 });
      panelId = (await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url.includes("sidepanel.html")), 8000, "侧栏重开").catch(() => ({ targetId: "" }))).targetId;
      check("侧栏关着时点胶囊打开侧栏", !!panelId, panelId);

      if (panelId) { panel = await rp.attach(panelId); await ready().catch(() => undefined); }
    }
  } else check("找到助手开的工作页", false, null);

  await finished().catch(() => undefined);
  await rp.cdp.send("Target.closeTarget", { targetId: otherTarget }).catch(() => {});

  for (const scheme of ["light", "dark"]) {
    const page = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `${origin}/sheet-${scheme}` })).targetId as string);
    await sleep(1200);
    // SAFETY: 同上，Page.captureScreenshot 回包。
    const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1048, height: Number(await rp.evaluate(page, "document.body.scrollHeight")), scale: 1 } }, page) as { data: string };
    await writeFile(join(out, `sheet-${scheme}.png`), Buffer.from(data, "base64"));
  }
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, notCovered: ["真实网站", "日常 Chrome 里真侧栏贴边的观感", "等页面响应 / 结果不确定 / 没做成由真实执行结果触发（这里直接调页面脚本入口）"], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
