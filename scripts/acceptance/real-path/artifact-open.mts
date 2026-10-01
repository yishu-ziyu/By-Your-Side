/**
 * 「生成的文件直接在新标签页打开」验收（docs/evals/20261002-open-artifact-in-browser.md 标准 1–3）。
 *
 * 只装扩展的隔离无头 Chrome、真侧栏；模型换成本机脚本模型（设置页「自定义地址」），按脚本调用产品的 artifacts 工具
 * 写 6 个文件：带越权探针的网页、Markdown、CSV、JSON、SVG、纯 ASCII 的 PDF。之后像用户一样点每张卡片的「打开」。
 *
 *   npx tsx scripts/acceptance/real-path/artifact-open.mts --headless
 *
 * 先列失败方式，判据逐条对应：
 *   noOpen      卡片上没有「打开」，或点了不开新标签页（旧代码在这里失败）。
 *   title       新标签页标题不是文件名；没有「下载」按钮；点「下载」得到的文件和生成的不一致。
 *   html        网页被当源码显示、脚本没跑，或没放进沙箱（iframe 缺 sandbox、带 allow-same-origin、不是扩展沙箱页）。
 *   escape      网页脚本读到扩展存储里的暗号、调到 chrome.runtime、读写到查看页 DOM、读到扩展来源 localStorage 里的暗号、
 *               把整个标签页导航走；任何一条成功即失败。对照组：同一组探针在查看页本身（扩展来源）
 *               必须能读到暗号，证明探针真能发现泄漏。
 *               只作证据、不判失败：读扩展安装包里的静态文件（manifest、打包代码）。Chrome 对 chrome-extension:// 资源
 *               不套页面 CSP，沙箱页总能读到自己扩展的安装包；那是公开代码，不含凭据、记忆或存储（10-02 首轮实测后修正）。
 *               另记 CDN 脚本是否被 CSP 拦下，用来确认 manifest 里放宽的沙箱 CSP 真的生效。
 *   markdown    Markdown 显示成带 # 和 ** 的源码，而不是标题与加粗。
 *   image/pdf   SVG 不是图片（img 没解码出尺寸）；PDF 没交给 Chrome 的 PDF 显示（不是 application/pdf 的 blob）。
 *   text        CSV/JSON 不是原样（逐字比对）或不是等宽字体。
 *   missing     对话里删掉文件后，已开的查看页和重新载入的查看页不提示「文件已不在了」；不存在的地址也一样。
 *
 * 产物：out/acceptance/real-path/<时间>-artifact-open/ 下 summary.json、每个查看页的截图、侧栏截图、下载的文件。
 */
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const STORAGE_SECRET = "storage-secret-7f3a";

const LOCAL_SECRET = "local-secret-91c2";

const PROBE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>里面的标题</title>
<style>body{font:16px/1.6 sans-serif;margin:24px}h1{color:#4b3a78}</style></head><body>
<h1 id="hello">论证链条测试页</h1><p id="ran">脚本没跑</p><pre id="probes"></pre>
<script>
window.cspBlocked = [];
document.addEventListener("securitypolicyviolation", (e) => window.cspBlocked.push(e.blockedURI + " " + e.violatedDirective));
</script>
<script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.13/dayjs.min.js" onerror="window.cdnError = true"></script>
<script>
document.getElementById("ran").textContent = "脚本已运行";
const results = {};
async function probe(name, fn) {
  try { const v = await fn(); results[name] = { ok: true, value: String(v).slice(0, 300) }; }
  catch (e) { results[name] = { ok: false, error: String((e && e.name) || e) + ": " + String((e && e.message) || "").slice(0, 120) }; }
}
(async () => {
  await probe("chromeStorage", () => chrome.storage.local.get(null).then((v) => JSON.stringify(v)));
  await probe("chromeRuntime", () => { if (!chrome.runtime || !chrome.runtime.id) throw new Error("chrome.runtime 不可用"); return chrome.runtime.id; });
  await probe("runtimeSendMessage", () => chrome.runtime.sendMessage({ type: "probe" }));
  await probe("parentDocument", () => parent.document.title);
  await probe("topDocumentWrite", () => { top.document.body.innerHTML = "pwned"; return "wrote"; });
  await probe("localStorage", () => localStorage.getItem("artifact-probe"));
  await probe("extensionFetch", () => fetch(new URL("/manifest.json", location.href)).then((r) => r.text()));
  await probe("topNavigation", () => { top.location.href = "https://example.com/"; return "navigated"; });
  document.getElementById("probes").textContent = JSON.stringify(results, null, 1);
  document.body.dataset.done = "1";
})();
</script></body></html>`;

const MD = "# 周报摘要\n\n这周完成了 **三件事**：\n\n- 打开文件\n- 下载文件\n\n> 引用一句。\n";

const CSV = "名称,价格\n苹果,3.5\n\"带,逗号\",12\n";

const JSON_TEXT = "{\n  \"items\": [1, 2, 3],\n  \"ok\": true\n}\n";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" rx="12" fill="#8975b2"/><text x="60" y="48" font-size="20" text-anchor="middle" fill="#fff">SVG</text></svg>`;

const PDF = (() => {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 24 Tf 40 70 Td (Hello PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return out;
})();

const FILES: Array<{ filename: string; content: string }> = [
  { filename: "probe-page.html", content: PROBE_HTML },
  { filename: "notes.md", content: MD },
  { filename: "prices.csv", content: CSV },
  { filename: "data.json", content: JSON_TEXT },
  { filename: "logo.svg", content: SVG },
  { filename: "hello.pdf", content: PDF },
];

const MAKE = "做一组测试文件";

const DELETE = "把 notes.md 删掉";

const RULES: Rule[] = [
  { match: MAKE, steps: [...FILES.map((f) => ({ tool: { name: "artifacts", args: { command: "create", filename: f.filename, content: f.content } } })), { text: "6 个文件都做好了。" }] },
  { match: DELETE, steps: [{ tool: { name: "artifacts", args: { command: "delete", filename: "notes.md" } } }, { text: "notes.md 已删除。" }] },
];

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-artifact-open`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>练习页</title><h1>练习页</h1>"));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const model = await startScriptedModel(RULES);

const rp = await launchRealPath();

const checks: Record<string, boolean> = {};

const evidence: JsonRecord = {};

let fatal: string | null = null;

let panel = "";

const viewerPrefix = () => `chrome-extension://${rp.extensionId}/artifact-viewer.html`;

const PANEL_STATE = `(() => ({
  ready: document.querySelector("#send-btn")?.disabled === false,
  busy: !!(document.querySelector("#status-pill")?.classList.contains("running") || document.querySelector("#send-btn")?.classList.contains("stopping") || document.querySelector(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
  userMessages: document.querySelectorAll("#messages .msg.user").length,
  cards: [...document.querySelectorAll(".artifact-card")].map((el) => ({ filename: el.dataset.filename ?? "", deleted: el.dataset.deleted === "true",
    buttons: [...el.querySelectorAll("button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })) })),
}))()`;

type PanelState = { ready: boolean; busy: boolean; userMessages: number; cards: Array<{ filename: string; deleted: boolean; buttons: Array<{ text: string; disabled: boolean }> }> };

// SAFETY: PANEL_STATE 返回的字段与 PanelState 一一对应。
const readPanel = async () => (await rp.evaluate(panel, PANEL_STATE)) as PanelState;

async function send(text: string, settled: (s: PanelState) => boolean) {
  const before = await readPanel();
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(async () => (await readPanel()).userMessages > before.userMessages || undefined, 10_000, `发出「${text}」`);
  await until(async () => {
    const s = await readPanel();

    return !s.busy && settled(s) ? s : undefined;
  }, 60_000, `「${text}」这一轮结束`, 300);
  await sleep(800);
}

async function viewerTargets() {
  return (await rp.targets()).filter((t) => t.type === "page" && t.url.startsWith(viewerPrefix()));
}

/** 像用户一样点卡片按钮「打开」，返回新开的查看页会话。 */
async function openCard(filename: string): Promise<{ session: string; targetId: string; url: string }> {
  const before = new Set((await viewerTargets()).map((t) => t.targetId));
  const sel = `.artifact-card[data-filename=${JSON.stringify(filename)}] .artifact-open`;
  await rp.evaluate(panel, `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }); true`);
  await sleep(200);
  await rp.click(panel, sel);
  const target = await until(async () => (await viewerTargets()).find((t) => !before.has(t.targetId)), 10_000, `打开 ${filename} 的新标签页`);
  const session = await rp.attach(target.targetId);
  await rp.cdp.send("Page.enable", {}, session);
  await until(async () => (await rp.evaluate(session, `document.readyState === "complete" && !!document.querySelector("#view > *")`).catch(() => false)) || undefined, 10_000, `${filename} 查看页加载`);

  return { session, targetId: target.targetId, url: target.url };
}

async function shot(session: string, name: string) {
  await rp.cdp.send("Target.activateTarget", { targetId: (await rp.cdp.send("Target.getTargetInfo", {}, session)).targetInfo.targetId }).catch(() => undefined);
  await sleep(500);
  await rp.screenshot(session, join(artifacts, `${name}.png`)).catch(() => undefined);
}

const VIEWER_BASICS = `(() => ({
  title: document.title,
  downloadVisible: !!document.querySelector("#download") && !document.querySelector("#download").hidden,
  missing: document.querySelector(".missing")?.innerText ?? null,
}))()`;

/** 沙箱 iframe 里的文档：站点隔离时它是单独的 iframe 目标，否则在同一进程里用隔离世界读。 */
async function evaluateInSandbox(viewer: string, expression: string): Promise<Json> {
  const frameTarget = (await rp.targets()).find((t) => t.type === "iframe" && t.url.includes("/artifact-sandbox.html"));

  if (frameTarget) return rp.evaluate(await rp.attach(frameTarget.targetId), expression);
  // SAFETY: CDP Page.getFrameTree 的返回形状。
  const tree = (await rp.cdp.send("Page.getFrameTree", {}, viewer)) as { frameTree: { childFrames?: Array<{ frame: { id: string; url: string } }> } };
  const child = tree.frameTree.childFrames?.find((f) => f.frame.url.includes("/artifact-sandbox.html"));

  if (!child) throw new Error("查看页里没有沙箱 iframe");
  const { executionContextId } = await rp.cdp.send("Page.createIsolatedWorld", { frameId: child.frame.id, worldName: "acceptance" }, viewer);
  const reply = await rp.cdp.send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true }, viewer);

  return reply.result?.value;
}

async function downloadFromViewer(session: string, n: number): Promise<string | null> {
  const dir = join(rp.dirs.downloads, `viewer-${n}`);
  await mkdir(dir, { recursive: true });
  await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  await rp.click(session, "#download");
  const name = await until(async () => (await readdir(dir)).find((f) => !f.endsWith(".crdownload")), 10_000, "查看页下载").catch(() => null);

  return name ? readFile(join(dir, name), "utf8") : null;
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

  // 扩展里放两个暗号：网页脚本能读到任何一个就算越权。
  await rp.evaluate(panel, `chrome.storage.local.set({ artifactProbeSecret: ${JSON.stringify(STORAGE_SECRET)} }).then(() => { localStorage.setItem("artifact-probe", ${JSON.stringify(LOCAL_SECRET)}); return true; })`);

  await send(MAKE, (s) => s.cards.filter((c) => !c.deleted).length >= FILES.length);
  const afterMake = await readPanel();
  evidence.cards = afterMake.cards;
  await rp.screenshot(panel, join(artifacts, "panel-cards.png"));
  checks.openButton = FILES.every((f) => afterMake.cards.find((c) => c.filename === f.filename)?.buttons.some((b) => b.text === "打开" && !b.disabled));

  const viewers: Record<string, { session: string; targetId: string; url: string }> = {};
  const basics: JsonRecord = {};

  for (const f of FILES) {
    viewers[f.filename] = await openCard(f.filename);
    // SAFETY: VIEWER_BASICS 返回 {title, downloadVisible, missing}。
    basics[f.filename] = (await rp.evaluate(viewers[f.filename]!.session, VIEWER_BASICS)) as JsonRecord;
  }

  evidence.viewerBasics = basics;
  checks.newTabs = Object.keys(viewers).length === FILES.length;
  // SAFETY: 上面写入的 basics 每项都是 VIEWER_BASICS 的形状。
  checks.titleAndDownload = FILES.every((f) => (basics[f.filename] as { title: string; downloadVisible: boolean }).title === f.filename && (basics[f.filename] as { downloadVisible: boolean }).downloadVisible);

  // 网页：沙箱、脚本跑了、探针全失败。
  const html = viewers["probe-page.html"]!;
  const frameInfo = await rp.evaluate(html.session, `(() => { const f = document.querySelector("#view iframe"); return f ? { sandbox: f.getAttribute("sandbox"), src: f.src } : null; })()`);
  evidence.htmlFrame = frameInfo;
  await until(async () => (await evaluateInSandbox(html.session, `document.body?.dataset.done === "1"`).catch(() => false)) || undefined, 10_000, "网页探针跑完");
  // SAFETY: 探针页在 #probes 写的是 {名字:{ok,value?,error?}}。
  const inside = (await evaluateInSandbox(html.session, `({ heading: document.querySelector("#hello")?.textContent, ran: document.querySelector("#ran")?.textContent, probes: JSON.parse(document.querySelector("#probes").textContent) })`)) as { heading: string; ran: string; probes: Record<string, { ok: boolean; value?: string; error?: string }> };
  evidence.htmlInside = inside;
  // SAFETY: frameInfo 形状见上。
  const frame = frameInfo as { sandbox: string | null; src: string } | null;
  checks.htmlRendersAndRuns = inside.heading === "论证链条测试页" && inside.ran === "脚本已运行";
  checks.htmlSandboxed = !!frame && frame.sandbox !== null && frame.sandbox.includes("allow-scripts") && !frame.sandbox.includes("allow-same-origin") && frame.src.endsWith("/artifact-sandbox.html");

  const leaks = Object.entries(inside.probes).filter(([name, r]) => {
    if (!r.ok || name === "extensionFetch") return false;

    if (name === "localStorage") return r.value === LOCAL_SECRET;

    if (name === "chromeStorage") return (r.value ?? "").includes(STORAGE_SECRET);

    return true;
  }).map(([name]) => name);

  const viewerAfter = await rp.evaluate(html.session, `({ title: document.title, url: location.href, bodyHasPwned: document.body.innerHTML.includes("pwned") })`);
  evidence.htmlLeaks = leaks;
  evidence.cdnScript = await evaluateInSandbox(html.session, `({ dayjsLoaded: typeof dayjs === "function", networkError: !!window.cdnError, cspBlocked: window.cspBlocked })`);
  evidence.viewerAfterProbes = viewerAfter;
  // SAFETY: 上一行表达式的返回形状。
  const va = viewerAfter as { title: string; url: string; bodyHasPwned: boolean };
  checks.htmlIsolated = Object.keys(inside.probes).length === 8 && leaks.length === 0 && va.title === "probe-page.html" && va.url === html.url && !va.bodyHasPwned;
  // 对照组：同样的读法在查看页本身（扩展来源）能拿到暗号，证明探针真能发现泄漏。
  const control = await rp.evaluate(html.session, `(async () => ({ storage: JSON.stringify(await chrome.storage.local.get("artifactProbeSecret")), local: localStorage.getItem("artifact-probe"), runtime: chrome.runtime.id }))()`);
  evidence.controlInExtensionOrigin = control;
  // SAFETY: 上一行表达式的返回形状。
  const ctl = control as { storage: string; local: string | null; runtime: string };
  checks.probeControl = ctl.storage.includes(STORAGE_SECRET) && ctl.local === LOCAL_SECRET && ctl.runtime === rp.extensionId;
  await shot(html.session, "viewer-html");

  // Markdown：排版后的正文。
  const md = await rp.evaluate(viewers["notes.md"]!.session, `(() => { const a = document.querySelector("#view article"); return a ? { h1: a.querySelector("h1")?.textContent, strong: a.querySelector("strong")?.textContent, items: a.querySelectorAll("li").length, text: a.innerText } : null; })()`);
  evidence.markdown = md;
  // SAFETY: 上一行表达式的返回形状。
  const mdv = md as { h1?: string; strong?: string; items: number; text: string } | null;
  checks.markdown = !!mdv && mdv.h1 === "周报摘要" && mdv.strong === "三件事" && mdv.items === 2 && !mdv.text.includes("**") && !mdv.text.includes("# ");
  await shot(viewers["notes.md"]!.session, "viewer-md");

  // 文本类：逐字原样、等宽。
  const textOf = async (name: string) => rp.evaluate(viewers[name]!.session, `(() => { const p = document.querySelector("#view pre"); return p ? { text: p.textContent, font: getComputedStyle(p).fontFamily } : null; })()`);
  const csv = await textOf("prices.csv");
  const json = await textOf("data.json");
  evidence.text = { csv, json };
  // SAFETY: textOf 的返回形状。
  const mono = (v: Json, want: string) => !!v && (v as { text: string }).text === want && /mono|Menlo|SFMono/i.test((v as { font: string }).font);
  checks.text = mono(csv, CSV) && mono(json, JSON_TEXT);
  await shot(viewers["prices.csv"]!.session, "viewer-csv");
  await shot(viewers["data.json"]!.session, "viewer-json");

  // 图片与 PDF。
  const svg = await rp.evaluate(viewers["logo.svg"]!.session, `(async () => { const i = document.querySelector("#view img"); if (!i) return null; await i.decode().catch(() => {}); return { w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 5) }; })()`);
  evidence.svg = svg;
  // SAFETY: 上一行表达式的返回形状。
  const sv = svg as { w: number; h: number; src: string } | null;
  checks.image = !!sv && sv.w === 120 && sv.h === 80 && sv.src === "blob:";
  await shot(viewers["logo.svg"]!.session, "viewer-svg");
  const pdf = await rp.evaluate(viewers["hello.pdf"]!.session, `(async () => { const f = document.querySelector("#view iframe"); if (!f) return null; const r = await fetch(f.src); const t = await r.text(); return { src: f.src.slice(0, 5), type: r.headers.get("content-type"), head: t.slice(0, 8), same: t === ${JSON.stringify(PDF)} }; })()`);
  evidence.pdf = pdf;
  // SAFETY: 上一行表达式的返回形状。
  const pv = pdf as { src: string; type: string; head: string; same: boolean } | null;
  checks.pdf = !!pv && pv.src === "blob:" && pv.type === "application/pdf" && pv.same;
  await sleep(1500);
  await shot(viewers["hello.pdf"]!.session, "viewer-pdf");

  // 查看页的「下载」：拿到的文件与生成的一致（CSV 多一个 BOM）。
  const downloadedMd = await downloadFromViewer(viewers["notes.md"]!.session, 1);
  const downloadedCsv = await downloadFromViewer(viewers["prices.csv"]!.session, 2);
  evidence.viewerDownloads = { md: downloadedMd, csv: downloadedCsv };

  if (downloadedMd !== null) await writeFile(join(artifacts, "downloaded-notes.md"), downloadedMd);
  checks.viewerDownload = downloadedMd === MD && downloadedCsv === `﻿${CSV}`;

  // 删除：已开的查看页随之提示；重新载入仍提示；不存在的地址也提示。
  await send(DELETE, (s) => s.cards.some((c) => c.filename === "notes.md" && c.deleted));
  const mdSession = viewers["notes.md"]!.session;

  const liveMissing = await until(async () => {
    // SAFETY: VIEWER_BASICS 形状。
    const b = (await rp.evaluate(mdSession, VIEWER_BASICS)) as { title: string; missing: string | null; downloadVisible: boolean };

    return b.missing ? b : undefined;
  }, 5_000, "已开的查看页提示文件不在").catch(() => null);

  await shot(mdSession, "viewer-md-deleted");
  await rp.cdp.send("Page.reload", {}, mdSession);
  await sleep(1500);
  // SAFETY: VIEWER_BASICS 形状。
  const reloaded = (await rp.evaluate(mdSession, VIEWER_BASICS)) as { title: string; missing: string | null; downloadVisible: boolean };
  const bogus = await rp.cdp.send("Target.createTarget", { url: `${viewerPrefix()}?id=does-not-exist&name=${encodeURIComponent("旧文件.html")}` });
  const bogusSession = await rp.attach(bogus.targetId);
  await sleep(1500);
  // SAFETY: VIEWER_BASICS 形状。
  const bogusState = (await rp.evaluate(bogusSession, VIEWER_BASICS)) as { title: string; missing: string | null; downloadVisible: boolean };
  await shot(bogusSession, "viewer-missing");
  evidence.missing = { liveMissing, reloaded, bogusState };
  const saysGone = (b: { title: string; missing: string | null; downloadVisible: boolean } | null, title: string) => !!b && b.title === title && (b.missing ?? "").includes("文件已不在了") && !b.downloadVisible;
  checks.missing = saysGone(liveMissing, "notes.md") && saysGone(reloaded, "notes.md") && saysGone(bogusState, "旧文件.html");
  const finalPanel = await readPanel();
  checks.deletedCardDisabled = finalPanel.cards.find((c) => c.filename === "notes.md")?.buttons.every((b) => b.disabled) ?? false;
  await rp.screenshot(panel, join(artifacts, "panel-after-delete.png"));
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(fatal);

  if (panel) await rp.screenshot(panel, join(artifacts, "error-panel.png")).catch(() => undefined);
} finally {
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  await model.close().catch(() => undefined);
  site.closeAllConnections();
  site.close();
}

const pass = !fatal && Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);

await writeFile(join(artifacts, "summary.json"), JSON.stringify({
  case: "artifact-open", contract: "docs/evals/20261002-open-artifact-in-browser.md", startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  status: pass ? "pass" : "fail", checks, evidence, fatal,
}, null, 2));

console.log(`${pass ? "PASS" : "FAIL"} artifact-open ${JSON.stringify(checks)} ${artifacts}`);

process.exit(pass ? 0 : 1);
