/**
 * 浮在网页上的会话卡片：只装扩展的隔离无头 Chrome、真侧栏、本机两张练习页与本机脚本模型。
 *
 *   npx tsx scripts/acceptance/real-path/float-card.mts --headless [--record]
 *
 * 真实路径走：侧栏里聊一句 → 菜单点「浮在页面上」→ 侧栏关掉、卡片出现在网页上、里面是同一段对话 →
 * 拖标题条移动 → 拉左边改宽 → 收起成圆钮、点圆钮展开 → 换到另一个标签页，卡片跟过去（旧页拆掉）→ 点 × 关掉。
 * 点击和拖动一律是真鼠标事件；位置从存储里的卡片位置算，卡片在 closed shadow 里，网页脚本看不到里面。
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-float-card`);
const record = process.argv.includes("--record");
await mkdir(out, { recursive: true });

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;padding:40px 56px;font:16px/1.9 -apple-system,"PingFang SC",sans-serif;color:#222;background:#fff}h1{font-size:26px}</style><h1>${title}</h1>${body}`;
const PAGES: Record<string, string> = {
  "/a": page("降噪耳机怎么选", "<p>" + "主动降噪靠麦克风采集环境声，再生成反相声波抵消。通勤选入耳式，长时间办公选头戴式。".repeat(14) + "</p>"
    + `<button id="under" style="position:fixed;right:60px;top:300px;width:140px;height:36px" onclick="window.underHits=(window.underHits||0)+1">被卡片挡住的按钮</button>`),
  "/b": page("耳机评测汇总", "<p>" + "这一页是另一个标签页，用来看卡片会不会跟着用户换过来。".repeat(14) + "</p>"),
};
const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGES[req.url ?? ""] ?? PAGES["/a"]); });
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const model = await startScriptedModel([
  { match: "卡片下面", steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: { target: "#under" } }, delayMs: 600 }, { text: "点好了。" }] },
  { match: "耳机", steps: [{ text: "通勤选入耳式主动降噪，办公选头戴式。要我对比具体型号吗？" }] },
]);
const rp = await launchRealPath();

type Rect = { right: number; top: number; width: number; height: number };
type Card = { open: boolean; collapsed: boolean; conversation: string; rect: Rect };
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const check = (name: string, pass: boolean, detail?: string) => { results.push({ name, pass, detail }); if (!pass) throw new Error(`${name}：${detail ?? ""}`); };
let error: string | null = null;
let recording = false;
const frames: string[] = [];
let frameDir = "";
let recordStart = 0;
let recorder: Promise<void> = Promise.resolve();

try {
  const open = async (path: string) => {
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${origin}${path}` });
    const s = await rp.attach(targetId);
    await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false }, s);
    await until(async () => (await rp.evaluate(s, "document.readyState")) === "complete" || undefined, 15000, `${path} 加载`);
    await sleep(800);
    return { targetId, s };
  };
  const A = await open("/a");
  const B = await open("/b");
  await rp.cdp.send("Target.activateTarget", { targetId: A.targetId });
  await rp.cdp.send("Page.bringToFront", {}, A.s);
  await until(async () => (await rp.evaluate(A.s, "document.visibilityState")) === "visible" || undefined, 5000, "A 页在前台");

  let shotOf = A.s;
  if (record) {
    recording = true;
    recordStart = Date.now();
    frameDir = await mkdtemp(join(tmpdir(), "float-card-frames-"));
    recorder = (async () => {
      while (recording) {
        // SAFETY: Page.captureScreenshot 回包的 data 是 base64 JPEG。
        const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 }, shotOf).catch(() => ({ data: "" })) as { data: string };
        if (data) { const f = join(frameDir, `${String(frames.length).padStart(5, "0")}.jpg`); await writeFile(f, Buffer.from(data, "base64")); frames.push(f); }
        await sleep(80);
      }
    })();
  }

  const panelId = await rp.openSidePanel();
  const panel = await rp.attach(panelId);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false`) || undefined, 60000, "侧栏就绪");
  await rp.click(panel, "#input"); await rp.typeText(panel, "降噪耳机怎么选？"); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, "document.body.innerText")).includes("通勤选入耳式") || undefined, 60000, "侧栏收到回答");

  await rp.click(panel, "#header-more");
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#popout-open")?.checkVisibility()') || undefined, 3000, "菜单展开");
  check("菜单里是「浮在页面上」", (await rp.evaluate(panel, 'document.querySelector("#popout-open").textContent')) === "浮在页面上");
  await rp.click(panel, "#popout-open");
  await until(async () => !(await rp.targets()).some(t => t.targetId === panelId) || undefined, 5000, "侧栏关掉");

  const card = async (): Promise<Card> => await rp.evaluate(await workerish(), `chrome.storage.local.get("float_card").then(s => s.float_card)`) as Card;
  async function workerish(): Promise<string> {
    const t = (await rp.targets()).find(t => t.url.includes("sidepanel.html?float=1"));
    if (!t) throw new Error("没有卡片会话页");
    return rp.attach(t.targetId);
  }
  const frameTarget = () => rp.targets().then(ts => ts.filter(t => t.url.includes("sidepanel.html?float=1")));
  await until(async () => (await frameTarget()).length === 1 || undefined, 10000, "卡片会话页出现");
  const inner = await workerish();
  await until(async () => (await rp.evaluate(inner, "document.body.innerText")).includes("通勤选入耳式") || undefined, 20000, "卡片里是同一段对话");
  check("卡片里是同一段对话", true);
  await sleep(600);
  await rp.screenshot(A.s, join(out, "01-card-open.png"));

  const vw = Number(await rp.evaluate(A.s, "innerWidth"));
  const hitsCard = (s: string, x: number, y: number) => rp.evaluate(s, `document.elementFromPoint(${x}, ${y})?.getAttribute("data-sideagent-overlay") === "float-card"`);
  let r = (await card()).rect;
  check("卡片挡在网页上", await hitsCard(A.s, vw - r.right - r.width / 2, r.top + r.height / 2) === true, JSON.stringify(r));

  const mouse = async (s: string, type: string, x: number, y: number) => rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, s);
  const drag = async (s: string, x0: number, y0: number, x1: number, y1: number) => {
    await mouse(s, "mouseMoved", x0, y0); await mouse(s, "mousePressed", x0, y0);
    for (let i = 1; i <= 12; i++) { await mouse(s, "mouseMoved", x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12); await sleep(16); }
    await mouse(s, "mouseReleased", x1, y1); await sleep(300);
  };
  const clickAt = async (s: string, x: number, y: number) => { await mouse(s, "mouseMoved", x, y); await mouse(s, "mousePressed", x, y); await mouse(s, "mouseReleased", x, y); await sleep(300); };

  // 在卡片里用真鼠标点输入框、发一句话：卡片里的会话照常能用；助手要点的网页按钮被卡片挡着，点击时卡片让开
  const frameBox = async (s: string, sel: string) => await rp.evaluate(s, `(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`) as { x: number; y: number };
  const toPage = (p: { x: number; y: number }) => ({ x: vw - r.right - r.width + 1 + 8 + p.x, y: r.top + 1 + 28 + p.y });
  const inputAt = toPage(await frameBox(inner, "#input"));
  await clickAt(A.s, inputAt.x, inputAt.y);
  check("真鼠标点卡片里的输入框能聚焦", await rp.evaluate(inner, `document.activeElement?.id === "input"`) === true);
  await rp.typeText(inner, "帮我点一下卡片下面的按钮"); await rp.pressEnter(inner);
  await until(async () => (await rp.evaluate(inner, "document.body.innerText")).includes("点好了") || undefined, 60000, "助手做完");
  check("卡片挡住的网页按钮助手能点到", Number(await rp.evaluate(A.s, "window.underHits || 0")) === 1, String(await rp.evaluate(A.s, "window.underHits || 0")));
  check("点完卡片回来", await hitsCard(A.s, vw - r.right - r.width / 2, r.top + r.height / 2) === true);

  // 网页在卡片上面盖一层不接鼠标的假界面，骗用户点到下面卡片里的按钮：点击不生效；拿掉后照常
  const before = (await card()).conversation;
  const newAt = toPage(await frameBox(inner, "#conversation-new"));
  await rp.evaluate(A.s, `(() => { const d = document.createElement("div"); d.id = "decoy"; d.popover = "manual"; d.textContent = "领取优惠券"; d.style.cssText = "margin:0;inset:auto;left:0;top:0;width:100vw;height:100vh;padding:0;border:0;background:rgba(255,255,255,.9);pointer-events:none"; document.body.append(d); d.showPopover(); return true; })()`);
  await sleep(400);
  await clickAt(A.s, newAt.x, newAt.y);
  await sleep(800);
  check("卡片被网页盖住时点击不生效", (await card()).conversation === before);
  await rp.evaluate(A.s, `document.getElementById("decoy").remove()`);
  await sleep(400);
  await clickAt(A.s, newAt.x, newAt.y);
  await until(async () => (await card()).conversation !== before || undefined, 5000, "恢复后点新会话生效");
  check("拿掉遮挡后点击照常", true);

  // 拖标题条：从中间把手往左下拖
  const left = vw - r.right - r.width;
  await drag(A.s, left + r.width / 2, r.top + 14, left + r.width / 2 - 260, r.top + 14 + 60);
  const moved = (await card()).rect;
  check("拖标题条能移动卡片", Math.abs(moved.right - (r.right + 260)) <= 2 && Math.abs(moved.top - (r.top + 60)) <= 2, JSON.stringify({ before: r, after: moved }));
  r = moved;

  // 拉左边改宽
  const edgeX = vw - r.right - r.width + 5;
  await drag(A.s, edgeX, r.top + r.height / 2, edgeX - 80, r.top + r.height / 2);
  const wider = (await card()).rect;
  check("拉左边能改宽", Math.abs(wider.width - (r.width + 80)) <= 2 && wider.right === r.right, JSON.stringify({ before: r, after: wider }));
  r = wider;
  await rp.screenshot(A.s, join(out, "02-moved-resized.png"));

  // 收起：标题条右起第二个按钮（× 左边）
  const barRight = vw - r.right - 1 - 6;
  await clickAt(A.s, barRight - 11 - 24, r.top + 14);
  await until(async () => (await card()).collapsed || undefined, 3000, "收起");
  await sleep(300);
  const bx = vw - 16 - 22, by = r.top + 22;
  check("收起后只剩圆钮", await hitsCard(A.s, bx, by) === true && await hitsCard(A.s, vw - r.right - r.width / 2, r.top + r.height / 2) === false);
  await rp.screenshot(A.s, join(out, "03-collapsed.png"));
  await clickAt(A.s, bx, by);
  await until(async () => !(await card()).collapsed || undefined, 3000, "展开");
  check("点圆钮展开", true);

  // 换到 B 页：卡片跟过去，A 页拆掉
  await rp.cdp.send("Target.activateTarget", { targetId: B.targetId });
  await rp.cdp.send("Page.bringToFront", {}, B.s);
  shotOf = B.s;
  await until(async () => (await rp.evaluate(A.s, "document.visibilityState")) === "hidden" || undefined, 5000, "A 页转到后台");
  await until(async () => (await hitsCard(B.s, vw - r.right - r.width / 2, r.top + r.height / 2)) || undefined, 10000, "B 页出现卡片");
  await until(async () => (await rp.evaluate(A.s, `!!document.querySelector('[data-sideagent-overlay="float-card"]')`)) === false || undefined, 5000, "A 页拆掉卡片");
  await until(async () => (await frameTarget()).length === 1 || undefined, 10000, "B 页卡片会话页出现");
  const want = (await card()).conversation;
  check("换标签页后卡片跟过去、位置不变、还是同一个会话", (await frameTarget())[0]!.url.includes(`conversation=${encodeURIComponent(want)}`), (await frameTarget())[0]!.url);
  await sleep(500);
  await rp.screenshot(B.s, join(out, "04-follows-tab.png"));

  // ×：关掉
  await clickAt(B.s, barRight - 11, r.top + 14);
  await until(async () => (await rp.evaluate(B.s, `!!document.querySelector('[data-sideagent-overlay="float-card"]')`)) === false || undefined, 3000, "关掉");
  check("点 × 关掉卡片", (await frameTarget()).length === 0);
  await rp.screenshot(B.s, join(out, "05-closed.png"));
} catch (e) {
  error = e instanceof Error ? e.stack ?? e.message : String(e);
} finally {
  recording = false;
  await recorder;
  if (record && frames.length > 1) {
    try { execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", (frames.length / ((Date.now() - recordStart) / 1000)).toFixed(2), "-i", join(frameDir, "%05d.jpg"), "-vf", "format=yuv420p", join(out, "run.mp4")]); } catch { /* 没装 ffmpeg 只少录屏 */ }
  }
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", error, results }, null, 2));
  console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error, checked: results.map(r => r.name) }));
  await rp.close(); await rp.remove?.(); await model.close(); await new Promise<void>(r => site.close(() => r()));
  process.exit(error ? 1 : 0);
}
