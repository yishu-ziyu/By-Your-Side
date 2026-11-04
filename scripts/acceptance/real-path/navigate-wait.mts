import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-navigate-wait`);

await mkdir(artifacts, { recursive: true });

const MARK = "导航等待";
const FINAL = `【${MARK}结束】`;
const CSV = Buffer.from("名称,数量\n苹果,3\n梨,5\n");
const REPORT = Buffer.from("月份,金额\n一月,100\n");
const LIMIT_MS = 5000;

type Payload = { tools?: unknown[]; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };

const textOf = (content: string | Array<{ text?: string }> | null | undefined) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";

const requests: string[] = [];

const site = createServer((req, res) => {
  requests.push(req.url ?? "");

  if (req.url?.startsWith("/export")) { res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="list.csv"', "content-length": CSV.length }).end(CSV); return; }

  if (req.url?.startsWith("/report")) { res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"', "content-length": REPORT.length }).end(REPORT); return; }

  if (req.url === "/slow") { res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="slow.csv"', "content-length": CSV.length }); res.write(CSV.subarray(0, 4)); setTimeout(() => res.end(CSV.subarray(4)), 4000); return; }

  if (req.url === "/next") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>第二页</title><h1>第二页的标题</h1>`); return; }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>列表</title><h1>列表</h1><a href="/export?mode=all">导出</a>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const closed = createServer();
await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
const unreachable = `http://127.0.0.1:${siteAddress(closed).port}/`;
await new Promise(resolve => closed.close(resolve));

const steps: Step[] = [
  { tool: { name: "navigate", args: { url: `${origin}/export?mode=all` } } },
  { tool: { name: "navigate", args: { url: "chrome://downloads/" } } },
  { tool: { name: "navigate", args: { url: `${origin}/next` } } },
  { tool: { name: "navigate", args: { url: unreachable } } },
  { tool: { name: "tabs", args: { action: "open", url: `${origin}/report?month=1` } } },
  { tool: { name: "navigate", args: { url: `${origin}/slow`, timeout: 1 } } },
  { tool: { name: "browser_run", args: { code: 'const first = await browser.js({code: "null"}); if (first) await browser.navigate({url: first.url}); return "done";' } } },
  { text: FINAL },
];

const payloads: Payload[] = [];
const requestAt: Record<number, number> = {};

const CHECK_DELAY_MS = 8_000;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }), delayMs: CHECK_DELAY_MS }] },
  { match: MARK, steps },
], undefined, payload => {
  // SAFETY: 脚本模型把产品的 OpenAI 兼容请求体原样交给这里；Payload 只取其中可选的 tools 与 messages。
  const p = payload as Payload;

  if (!p.tools?.length || !p.messages?.some(m => m.role === "user" && textOf(m.content).includes(MARK))) return;
  payloads.push(p);
  const count = p.messages.filter(m => m.role === "tool").length;
  requestAt[count] ??= Date.now();
});

const rp = await launchRealPath();
const screenshot = join(artifacts, "sidebar.png");
let error: string | null = null;
let receipts: string[] = [];
let durations: number[] = [];
let detachMs = NaN;
let beforeVerdictMs = NaN;
let downloaded: string[] = [];
const checks: Array<{ name: string; pass: boolean }> = [];
const check = (name: string, pass: boolean) => { checks.push({ name, pass }); };

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  const worker = await rp.attach((await rp.serviceWorker())!.targetId);
  await rp.evaluate(worker, `(() => { globalThis.__detachAt = []; const detach = chrome.debugger.detach.bind(chrome.debugger); chrome.debugger.detach = (...args) => { globalThis.__detachAt.push(Date.now()); return detach(...args); }; return true; })()`);
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK}：打开导出地址、下载页和第二页。`);
  await rp.pressEnter(panel);

  await until(async () => await rp.evaluate(panel, `!document.querySelector("#status-pill")?.classList.contains("running") && document.querySelector("#send-btn")?.disabled===false && document.querySelector("#messages")?.textContent.includes(${JSON.stringify(FINAL)})`) || undefined, 150_000, "final answer");
  const idleAt = Date.now();
  const detachedAt = await until(async () => ((await rp.evaluate(worker, "globalThis.__detachAt")) as number[]).find(at => at >= idleAt - 1000) ?? undefined, 20_000, "debugger detach").catch(() => NaN);
  detachMs = detachedAt - idleAt;
  const verdictAt = await until(async () => model.requests.find(r => r.rule === '"goalPage"')?.firstTextAt, 15_000, "goal check verdict").catch(() => NaN);
  beforeVerdictMs = verdictAt - detachedAt;
  await sleep(1500);

  const last = payloads.at(-1);
  receipts = (last?.messages ?? []).filter(m => m.role === "tool").map(m => textOf(m.content));
  durations = [0, 1, 2, 3, 4, 5, 6].map(k => (requestAt[k + 1] ?? NaN) - (requestAt[k] ?? NaN));
  downloaded = await readdir(rp.dirs.downloads);
  await rp.screenshot(panel, screenshot);

  const file = await until(async () => (await readFile(join(rp.dirs.downloads, "list.csv")).catch(() => null)) ?? undefined, 5_000, "list.csv in downloads").catch(() => Buffer.alloc(0));
  const report = await until(async () => (await readFile(join(rp.dirs.downloads, "report.csv")).catch(() => null)) ?? undefined, 5_000, "report.csv in downloads").catch(() => Buffer.alloc(0));
  const [a = "", b = "", c = "", d = "", e = "", f = "", g = ""] = receipts;

  check(`(a) attachment navigate returned in ${durations[0]} ms`, durations[0]! < LIMIT_MS);
  check("(a) receipt says a download started and names list.csv", /document: download/.test(a) && /started a download instead of opening a page/.test(a) && a.includes('"list.csv"'));
  check("(a) receipt carries no query string", !a.includes("mode=all"));
  check("(a) downloaded file has the served bytes", file.equals(CSV));
  check("(a) export requested once", requests.filter(r => r.startsWith("/export")).length === 1);
  check(`(b) chrome://downloads navigate returned in ${durations[1]} ms`, durations[1]! < LIMIT_MS);
  check("(b) receipt readiness is complete", /document: complete/.test(b));
  check("(c) receipt readiness is interactive/complete with a fresh snapshot", /document: (interactive|complete)/.test(c) && /Fresh snapshot of the new page[\s\S]*第二页的标题/.test(c));
  check(`(d) unreachable navigate returned in ${durations[3]} ms`, durations[3]! < LIMIT_MS);
  check("(d) receipt does not say complete", !/document: complete/.test(d));
  check("(d) receipt says Chrome showed an error page", /document: error_page/.test(d) && /error page/.test(d));
  check(`(e) tabs open returned in ${durations[4]} ms`, durations[4]! < LIMIT_MS);
  check("(e) receipt says a download started, names report.csv and says the tab was closed", /document: download/.test(e) && e.includes('"report.csv"') && /closed/.test(e) && !/^Error|错误|失败/.test(e));
  check("(e) downloaded file has the served bytes", report.equals(REPORT));

  check("(f) receipt keeps the download and says it is not saved yet", /document: download/.test(f) && f.includes('"slow.csv"') && /not saved yet/.test(f) && !/reports it complete/.test(f));

  check(`(g) navigate without url returned in ${durations[6]} ms`, durations[6]! < LIMIT_MS);
  check("(g) receipt says navigate needs a url and points at .value", /navigate 需要 url/.test(g) && /\.value/.test(g));

  check(`(h) debugger detached ${detachMs} ms after the panel went idle, ${beforeVerdictMs} ms before the goal check verdict`, detachMs < 3000 && beforeVerdictMs > 0);

  if (checks.some(item => !item.pass)) throw new Error(`failed: ${checks.filter(item => !item.pass).map(item => item.name).join(" | ")}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice site", checks, durationsMs: durations, receipts: receipts.map(r => r.slice(0, 600)), downloaded, requests, screenshot, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, checks, durationsMs: durations, receipts: receipts.map(r => r.slice(0, 220)), downloaded, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
