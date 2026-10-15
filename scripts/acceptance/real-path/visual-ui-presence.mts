/**
 * 真扩展 + 真 content script，隔离无头 Chrome；不使用真实模型或日常浏览器。
 * npx tsx scripts/acceptance/real-path/visual-ui-presence.mts --headless
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, sleep } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/visual-ui-production/real-extension");
await mkdir(out, { recursive: true });
// /hover：网页自己记下光效浮层有没有进入过「用户接手」，覆盖助手不移动光标就派发的悬停。
const HOVER_PAGE = '<!doctype html><meta charset="utf-8"><title>悬停让位</title><h1 id="title" style="margin:200px 0 0 300px">悬停目标</h1><script>window.__everUserActive=false;new MutationObserver(()=>{const h=document.querySelector("[data-sideagent-overlay=cursor]");if(h&&h.classList.contains("user-active"))window.__everUserActive=true}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["class"]})</script>';
const HOVER_TASK = "把鼠标停在标题上";
const site = createServer((req, res) => {
  if (req.url === "/hover") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOVER_PAGE);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end('<!doctype html><meta charset="utf-8"><title>真实扩展光标验收</title><button id="tap" onclick="window.taps=(window.taps||0)+1">网页点击</button><p>网页主体不受浮层影响。</p><script>window.__restoredFromCache=false;addEventListener("pageshow",e=>{if(e.persisted)window.__restoredFromCache=true})</script>');
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const port = siteAddress(site).port;
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
try {
  rp = await launchRealPath();
  const siteTarget = (await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` })).targetId as string;
  const page = await rp.attach(siteTarget);
  // 从真实侧栏的扩展权限调用，避免借用 service worker 的非扩展执行上下文。
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp!.evaluate(panel, "typeof chrome !== 'undefined' && !!chrome.scripting")) || undefined, 10_000, "扩展侧栏权限");
  const tabId = await rp.evaluate(panel, `chrome.tabs.query({}).then(ts => ts.find(t=>t.url?.startsWith("http://127.0.0.1:${port}/"))?.id ?? null)`) as number | null;
  assert(tabId, "应找到本轮隔离网页的 tabId");
  const isolated = (body: string) => rp!.evaluate(panel,
    `chrome.scripting.executeScript({target:{tabId:${tabId}},world:"ISOLATED",func:()=>{${body}}}).then(rs=>rs[0]?.result)`);
  const state = () => isolated("return window.__sideagent?.cursorState?.() ?? null;") as Promise<{ hidden: boolean; resting: boolean; x: number; y: number } | null>;
  await rp.cdp.send("DOM.enable", {}, page);
  // DevTools can inspect a closed shadow root even though scripts on the page
  // cannot. Check CSS classes directly instead of pixel-identical screenshots.
  type DomNode = {
    attributes?: string[];
    children?: DomNode[];
    shadowRoots?: DomNode[];
    contentDocument?: DomNode;
  };
  const edgeClasses = async (session = page): Promise<string[]> => {
    const response = await rp!.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as {
      root: DomNode;
    };
    const classes: string[] = [];
    const visit = (node: DomNode | undefined): void => {
      if (!node) return;
      const attributes = node.attributes;
      const ix = attributes?.indexOf("class") ?? -1;

      if (ix >= 0 && attributes?.[ix + 1]?.split(/\s+/).includes("edge")) classes.push(attributes[ix + 1]!);
      for (const child of node.children ?? []) visit(child);
      for (const child of node.shadowRoots ?? []) visit(child);
      if (node.contentDocument) visit(node.contentDocument);
    };
    visit(response.root);

    return classes;
  };
  await until(async () => (await state())?.resting || undefined, 15_000, "内容脚本自动显示主光标");
  const current = (await state())!;
  assert.equal(current.hidden, false);
  const viewport = await isolated("return {width:innerWidth,height:innerHeight};") as {width:number;height:number};
  assert(current.x > viewport.width - 75 && current.y > viewport.height - 135,
    `光标应停靠本页右下角：${JSON.stringify({current,viewport})}`);
  assert.equal(await rp.evaluate(page, 'document.querySelector("[data-sideagent-overlay]")?.style.pointerEvents'), "none");
  await rp.click(page, "#tap");
  assert.equal(await rp.evaluate(page, "window.taps"), 1, "浮层不得挡住网页点击");
  await rp.screenshot(page, join(out, "01-parked.png"));

  await isolated("window.__sideagent.cursor.setGlow(true); return true;");
  await sleep(450);
  await rp.screenshot(page, join(out, "02-reading-glow.png"));
  const first = await readFile(join(out, "01-parked.png"));
  const second = await readFile(join(out, "02-reading-glow.png"));
  assert.notEqual(Buffer.compare(first, second), 0, "亮起彩边后真实网页像素应发生变化");
  // 让位：助手的鼠标事件落在光标刚飞到的点上，不算用户；用户自己动鼠标，彩边和光标退淡，停下后亮回。
  const receded = () => rp!.evaluate(page, 'document.querySelector("[data-sideagent-overlay=cursor]")?.classList.contains("user-active") === true') as Promise<boolean>;
  const flight = await isolated("return window.__sideagent.cursor.move(120, 90);") as number;
  await sleep(flight + 150);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 120, y: 90 }, page);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 120, y: 90, button: "left", clickCount: 1 }, page);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 120, y: 90, button: "left", clickCount: 1 }, page);
  await sleep(100);
  assert.equal(await receded(), false, "助手在光标落点的点击不能让彩边让位");
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 260 }, page);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 430, y: 280 }, page);
  await until(async () => (await receded()) || undefined, 2_000, "用户动鼠标后彩边让位");
  await rp.screenshot(page, join(out, "02b-user-active.png"));
  assert.notEqual(Buffer.compare(await readFile(join(out, "02-reading-glow.png")), await readFile(join(out, "02b-user-active.png"))), 0,
    "让位时网页上的彩边像素应变化");
  await until(async () => !(await receded()) || undefined, 3_000, "用户停下后彩边亮回");
  await isolated("window.__sideagent.cursor.setGlow(false); window.__sideagent.cursor.hide(); return true;");
  assert.equal((await state())?.hidden, true, "显式停止必须隐藏光标");
  // Chrome BFCache 恢复的是同一个 Document；不会重新执行 content script。
  // 两次往返还要覆盖重复挂载与上一页正在运行的彩边残留。
  for (let i = 0; i < 2; i++) {
    await isolated("window.__sideagent.cursor.setGlow(true); return true;");
    assert((await edgeClasses()).some(c => c.split(/\s+/).includes("on")),
      "对照组：被关闭的旧彩边之前确实处于亮起状态");
    await rp.evaluate(page, 'dispatchEvent(new PageTransitionEvent("pagehide", {persisted:true}));true');
    await rp.evaluate(page, 'dispatchEvent(new PageTransitionEvent("pageshow", {persisted:true}));true');
    // 光标先问后台上一页停在哪，再出现。
    const restored = await until(async () => (await state()) || undefined, 3_000, "BFCache 恢复后的主光标");
    assert(restored.resting && !restored.hidden, "BFCache 恢复后重新出现一个可见的主光标");
    assert.equal(await rp.evaluate(page, 'document.querySelectorAll("[data-sideagent-overlay=cursor]").length'), 1,
      "重复恢复不得创建重叠光标");
    assert(!(await edgeClasses()).some(c => c.split(/\s+/).includes("on")),
      "BFCache 恢复时旧任务彩边不能再次点亮");
  }
  await rp.screenshot(page, join(out, "03-after-cache-restore.png"));

  // 真正的历史前进/后退也应有光标。若 Chrome 没把该页放进 BFCache，
  // 新加载应靠 content script 注入；usedBfCache 如实记录。
  const history = await rp.cdp.send("Page.getNavigationHistory", {}, page) as {
    currentIndex: number; entries: Array<{ id: number; url: string }>;
  };
  const originalEntry = history.entries[history.currentIndex]!;
  // 合成 pageshow 已设置过此标志，真实导航前先清空，防止 BFCache 假阳性。
  await rp.evaluate(page, "window.__restoredFromCache=false;true");
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/other` }, page);
  await until(async () => await rp!.evaluate(page, 'location.pathname === "/other"') || undefined, 10_000, "浏览器进入下一页");
  await rp.cdp.send("Page.navigateToHistoryEntry", { entryId: originalEntry.id }, page);
  await until(async () => await rp!.evaluate(page, 'location.pathname === "/"') || undefined, 10_000, "浏览器后退返回原页");
  await until(async () => (await state())?.resting || undefined, 10_000, "后退后主光标");
  assert.equal((await state())?.hidden, false);
  assert.equal(await rp.evaluate(page, 'document.querySelectorAll("[data-sideagent-overlay=cursor]").length'), 1);
  assert(!(await edgeClasses()).some(c => c.split(/\s+/).includes("on")),
    "真实后退返回旧 Document 后，也不得恢复上一轮的彩边");
  const usedBfCache = await rp.evaluate(page, 'window.__restoredFromCache===true') as boolean;
  console.log("HISTORY_BACK", JSON.stringify({ usedBfCache, cursorVisible: true }));
  // 真实工具路径：脚本模型打开 /hover，再悬停标题（受保护的悬停不移动光标）。光效亮着，但不能让位。
  const model = await startScriptedModel([{ match: HOVER_TASK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${port}/hover` } } },
    // 光效跟着文档走、在工具开始时异步点亮：先读一次新页面让它亮起，再隔一会儿悬停，像真模型那样。
    { tool: { name: "js", args: { code: "document.title" } } },
    { tool: { name: "hover", args: { target: "#title", label: "标题" } }, delayMs: 1500 },
    { tool: { name: "hover", args: { target: "#title", label: "标题" } }, delayMs: 800 },
    { text: "停好了。" },
  ] }]);
  try {
    await rp.cdp.send("Target.activateTarget", { targetId: siteTarget });
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
    await until(async () => await rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏可发送");
    await rp.click(panel, "#input");
    await rp.typeText(panel, HOVER_TASK);
    await rp.pressEnter(panel);
    // 跳到新网页后彩边要在新文档上亮起（以前同一标签页只画一次，跳页后整轮都没有彩边）。
    let litAfterNavigate = false;
    const answered = () => rp!.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].some(m => m.textContent.includes("停好了"))`) as Promise<boolean>;
    for (const t0 = Date.now(); Date.now() - t0 < 60_000 && !(await answered()); await sleep(150)) {
      const t = (await rp.targets()).find((x: { url: string }) => x.url.endsWith("/hover"));
      if (!t || litAfterNavigate) continue;
      try {
        const s = await rp.attach(t.targetId);
        await rp.cdp.send("DOM.enable", {}, s);
        litAfterNavigate = (await edgeClasses(s)).some(c => c.split(/\s+/).includes("on"));
      } catch { /* 页面正在加载 */ }
    }
    await until(async () => (await answered()) || undefined, 5_000, "悬停任务答复");
    assert(litAfterNavigate, "跳到新网页后彩边应在新页面上亮起");
    const hoverTab = (await rp.targets()).find((t: { url: string }) => t.url.endsWith("/hover"));
    assert(hoverTab, "脚本模型应打开 /hover");
    const hp = await rp.attach(hoverTab.targetId);
    assert.equal(await rp.evaluate(hp, "document.querySelector('[data-sideagent-overlay=cursor]') !== null"), true, "悬停时光效浮层应在页面上");
    assert.equal(await rp.evaluate(hp, "window.__everUserActive"), false, "助手的悬停不能让彩边让位");
  } finally { await model.close(); }

  await writeFile(join(out, "result.json"), JSON.stringify({
    passed: ["真实扩展自动驻留", "点击穿透", "彩边渲染", "显式停止", "BFCache 合成生命周期两轮与旧彩边清理", "Chrome 历史后退"],
    usedBfCache, extensionId: rp.extensionId,
  }, null, 2));
  console.log("PASS 真扩展 · 自动驻留 / 网页点击 / C 彩边 / 显式关闭");
} finally {
  if (rp) { await rp.close(); await rp.remove(); }
  await new Promise<void>(resolve => site.close(() => resolve()));
}
