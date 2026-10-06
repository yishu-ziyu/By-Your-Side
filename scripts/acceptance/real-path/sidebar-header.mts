/**
 * 侧栏顶部改版（2026-09-27）：空闲、执行中（收起/展开）、断线三态各截一张真侧栏图，并读出顶部与任务条的实际布局。
 *
 *   npx tsx scripts/acceptance/real-path/sidebar-header.mts --headless
 *
 * 隔离的无窗口 Chrome，只装扩展；模型是本机脚本模型（scripted-model.mts），像用户一样在设置页填「自定义地址」。
 * 断线态：像 Chrome 回收后台那样停掉 service worker，记下顶部连接状态的真实变化；
 * 重连只要几毫秒截不到图，断线的样子另用「把状态停在重连中」的样式预览截一张（不作连接判据）。
 * 产物：out/acceptance/sidebar-header/ 下每态一张图，summary.json 记下每态的布局读数与判据。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/sidebar-header");

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Writers</title></head>
<body style="font:16px/1.8 -apple-system,sans-serif;margin:32px"><h1>Writers</h1><ul><li>Ada Lin</li><li>Mia Chen</li><li>Jo Park</li></ul></body></html>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const RULES: Rule[] = [{ match: "找到她", steps: [{ text: "在作者列表里找到了 Mia Chen。", delayMs: 45_000 }] }];

/** 顶部到第一条内容之间有哪些可见块、各多高；任务条在不在输入框正上方。 */
const LAYOUT = `(() => {
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.height ? { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } : null; };
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const topbar = q("#topbar");
  return {
    topbar: box(topbar),
    topbarBg: getComputedStyle(topbar).backgroundColor,
    topbarBorder: getComputedStyle(topbar).borderBottomColor,
    topbarText: topbar.innerText.replace(/\\s+/g, " ").trim(),
    brandShown: shown(q("#brand")) || shown(q("#logo")),
    statusPillShown: shown(q("#status-pill")),
    statusText: q("#status-text")?.textContent ?? "",
    modeToggleGone: !q("#teach-toggle"),
    taskBar: shown(q(".task-bar")) ? { box: box(q(".task-bar")), text: q(".task-bar").innerText.replace(/\\s+/g, " ").trim(), expanded: q(".task-bar").hasAttribute("data-expanded") } : null,
    composer: box(q("#composer")),
    messagesTop: box(q("#messages"))?.top ?? null,
  };
})()`;

type Layout = {
  topbar: { top: number; bottom: number; height: number } | null;
  topbarBg: string;
  topbarBorder: string;
  topbarText: string;
  brandShown: boolean;
  statusPillShown: boolean;
  statusText: string;
  modeToggleGone: boolean;
  taskBar: { box: { top: number; bottom: number; height: number } | null; text: string; expanded: boolean } | null;
  composer: { top: number; bottom: number; height: number } | null;
  messagesTop: number | null;
};

const checks: Array<{ item: string; pass: boolean; detail: Json }> = [];

const check = (item: string, pass: boolean, detail: Json) => {
  checks.push({ item, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${item} ${JSON.stringify(detail)}`);
};

const shots: Array<{ state: string; file: string; layout: Layout }> = [];

const model = await startScriptedModel(RULES);

const rp = await launchRealPath({ withoutNativeHost: true });

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/writers` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // SAFETY: LAYOUT 返回的字段与 Layout 一一对应。
  const layout = async () => (await rp.evaluate(panel, LAYOUT)) as Layout;

  const shot = async (state: string) => {
    await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
    await sleep(300);
    const file = `${state}.png`;
    await rp.screenshot(panel, join(artifacts, file));
    const read = await layout();
    shots.push({ state, file, layout: read });

    return read;
  };

  await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on")`)) || undefined, 60_000, "侧栏连上", 500);
  const ready = `!document.querySelector("#send-btn").disabled && document.querySelector("#conversation-new")?.getAttribute("aria-label") === "新会话" && !document.querySelector("#conversation-new").disabled`;
  await until(async () => (await rp.evaluate(panel, ready)) || undefined, 60_000, "默认会话建好");

  // 像用户一样在设置页选「自定义地址」，填本机脚本模型。
  await rp.click(panel, "#header-more");
  await sleep(400);
  await rp.click(panel, "#model-settings-open");
  const settingsTarget = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页打开");
  const settings = await rp.attach(settingsTarget.targetId);
  await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");
  await rp.evaluate(settings, `document.querySelector("#provider-more").open = true; true`);
  await rp.click(settings, `.provider-option[data-provider="custom"]`);
  const focus = (sel: string) => rp.evaluate(settings, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: "center" }); el.focus(); el.select?.(); return true; })()`);
  await focus("#base-url");
  await rp.typeText(settings, model.baseUrl);
  await focus("#api-key");
  await rp.typeText(settings, "local-demo-no-secret");
  await focus("#model-id");
  await rp.typeText(settings, "demo-model");
  await rp.evaluate(settings, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, "#model-save");
  await until(async () => String(await rp.evaluate(settings, `document.querySelector("#model-status").textContent`)).startsWith("已保存") || undefined, 10_000, "保存模型");
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget.targetId });
  await sleep(1500);

  // 1. 空闲。
  const idle = await shot("1-idle");
  check("空闲：顶部一行，不再有第二个品牌", !!idle.topbar && idle.topbar.height <= 40 && !idle.brandShown, { topbar: idle.topbar, text: idle.topbarText });
  check("空闲：连上时不显示连接状态", !idle.statusPillShown, { statusText: idle.statusText });
  check("空闲：没有「操作方式」切换（指导模式已删除）", idle.modeToggleGone, null);
  check("空闲：顶部底色接 Chrome 标题栏", idle.topbarBg === "rgb(255, 255, 255)", { bg: idle.topbarBg });

  // 2. 执行中：收起、展开。
  await rp.click(panel, "#input");
  await rp.typeText(panel, "这个网站上你能找到她吗");
  await rp.pressEnter(panel);
  // #58 C：进行中只在对话里留一行「正在…」，任务条让位（页面归你、回执、任务页不一致时才出来）。
  const runLine = `(() => { const t = document.querySelector("details.run-steps:not(.done) .run-title"); const r = t?.getBoundingClientRect(); return t ? { text: t.textContent, height: Math.round(r.height) } : null; })()`;
  await until(async () => (await rp.evaluate(panel, runLine))?.text.startsWith("正在") || undefined, 20_000, "过程行出现");
  await sleep(4000);
  const running = await shot("2-running");
  const line = await rp.evaluate(panel, runLine);
  // 这一轮模型只想不做，没有步骤可展开；展开后的步骤见 scripts/probes/shell/process-line.mts。
  check("执行中：对话里一行「正在…」，任务条不出现", !running.taskBar && !!line && line.height <= 26, { line, taskBar: running.taskBar?.text ?? null });
  const panelText = String(await rp.evaluate(panel, `document.querySelector("#app").innerText`));
  check("执行中：任务页就是当前页时，网站名只在输入框上方出现一次", (panelText.match(/127\.0\.0\.1/g) ?? []).length === 1, { hits: (panelText.match(/127\.0\.0\.1/g) ?? []).length });
  await until(async () => await rp.evaluate(panel, `!document.querySelector("#send-btn.stopping")`) || undefined, 60_000, "这一轮结束");
  await sleep(1000);
  await shot("4-done");

  // 3. 断线：停掉 service worker，侧栏端口断开后自动重连。
  const worker = await rp.serviceWorker();

  if (!worker) throw new Error("找不到扩展的 service worker");
  // 和 Chrome 空闲回收 worker 一样（见 offline-send-and-model-menu.mts）。
  await rp.evaluate(panel, `(() => { window.__pill = []; const t0 = performance.now(); new MutationObserver(() => window.__pill.push(Math.round(performance.now() - t0) + " " + document.querySelector("#status-pill").className + " " + document.querySelector("#status-text").textContent)).observe(document.querySelector("#status-pill"), { attributes: true, subtree: true, childList: true, characterData: true }); return true; })()`);
  await rp.cdp.send("ServiceWorker.enable", {}, work);
  await rp.cdp.send("ServiceWorker.stopAllWorkers", {}, work);
  await sleep(3000);
  // SAFETY: 页面脚本返回字符串数组（毫秒 类名 文字）。
  const pillLog = await rp.evaluate(panel, `window.__pill`) as string[];
  const retryAt = pillLog.find((line) => line.includes("status-retry") || line.includes("status-off"));
  const backAt = pillLog.findLast((line) => line.includes("status-on"));
  check("断线：真实断开时顶部出现连接状态，连上后消失", !!retryAt && !!backAt && pillLog.indexOf(backAt) > pillLog.indexOf(retryAt), { retryAt: retryAt ?? null, backAt: backAt ?? null, events: pillLog.length });
  // worker 被回收后几毫秒就重连上，真实断线态截不到；这里把状态停在「重连中」只为看样子（样式预览，不作连接判据）。
  await rp.evaluate(panel, `(() => { const p = document.querySelector("#status-pill"); p.className = "activity-island status-retry"; document.querySelector("#status-dot").className = "dot island-pulse-dot retry"; document.querySelector("#status-text").textContent = "重连中…"; return true; })()`);
  const off = await shot("5-disconnected-style-preview");
  check("断线样式：状态在会话名右侧，不挤掉＋和⋯", off.statusPillShown && /重连中/.test(off.topbarText) && (off.topbar?.height ?? 99) <= 40, { text: off.topbarText });
} finally {
  await writeFile(join(artifacts, "summary.json"), JSON.stringify({ at: new Date().toISOString(), shots, checks, modelRequests: model.requests }, null, 2));
  await rp.close();
  await model.close();
  await rp.remove();
  site.close();
}

const failed = checks.filter((c) => !c.pass);

console.log(`${checks.length - failed.length}/${checks.length} 通过；截图在 ${artifacts}`);

process.exit(failed.length ? 1 : 0);
