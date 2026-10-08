/**
 * 真扩展 + 真 content script，隔离无头 Chrome；不使用真实模型或日常浏览器。
 * npx tsx scripts/acceptance/real-path/visual-ui-presence.mts --headless
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, sleep } from "./harness.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/visual-ui-production/real-extension");
await mkdir(out, { recursive: true });
const site = createServer((_, res) => {
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
  const edgeClasses = async (): Promise<string[]> => {
    const response = await rp!.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as {
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
    const restored = await state();
    assert(restored && restored.resting && !restored.hidden, "BFCache 恢复后重新出现一个可见的主光标");
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
  await writeFile(join(out, "result.json"), JSON.stringify({
    passed: ["真实扩展自动驻留", "点击穿透", "彩边渲染", "显式停止", "BFCache 合成生命周期两轮与旧彩边清理", "Chrome 历史后退"],
    usedBfCache, extensionId: rp.extensionId,
  }, null, 2));
  console.log("PASS 真扩展 · 自动驻留 / 网页点击 / C 彩边 / 显式关闭");
} finally {
  if (rp) { await rp.close(); await rp.remove(); }
  await new Promise<void>(resolve => site.close(() => resolve()));
}
