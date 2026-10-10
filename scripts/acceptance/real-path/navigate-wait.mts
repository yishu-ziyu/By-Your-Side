/**
 * 打开的地址变成下载、或是不能注入脚本的页面时，navigate 几秒内如实返回，不再等到超时（docs/evals/20261010-navigate-wait.md R1）。
 * 只装扩展、隔离构建、本机脚本模型、本机练习站；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/navigate-wait.mts --headless
 * 路径：同一任务里依次 navigate 到 (a) 服务器按附件回的导出地址，(b) chrome://downloads/，(c) 普通页面，(d) 连不上的本机端口；
 * 然后 (e) 用 tabs open 新开一个按附件回文件的地址；(f) 再 navigate 到一个慢慢发完的附件地址，等待上限 1 秒。
 * 判据：(a)(b)(d)(e) 各自从上一次模型请求到下一次不超过 5 秒；(a) 的回执说开始了下载并写出文件名，下载目录里真有这个文件、内容等于服务器发的字节；
 * (c) 的回执仍是 interactive/complete，并带新页面的快照；(d) 的回执说 Chrome 显示了错误页，不说 complete；
 * (e) 不是报错，回执说开始了下载、Chrome 关掉了新标签页，下载目录里真有这个文件；
 * (f) 等待上限先到，回执仍说开始了下载、还没存好，不是 timeout，也不说存好。
 * 失败方式：去掉等待里的浏览器通知，(a)(b) 都等满 30 秒、回执是 timeout；把错误页当成加载完，(d) 回执是 complete（反例结果见验收文件）。
 */
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

/** 产品发给模型的 OpenAI 兼容请求里本脚本要读的部分。 */
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
// 先占一个端口再关掉：这个地址连不上，Chrome 显示自己的错误页。
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
  { text: FINAL },
];

const payloads: Payload[] = [];
/** 第 k 项：带 k 条工具结果的主任务请求到达脚本模型的时刻。相邻两项之差就是第 k 次 navigate 从发出到回执的上限。 */
const requestAt: Record<number, number> = {};

const model = await startScriptedModel([{ match: MARK, steps }], undefined, payload => {
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
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK}：打开导出地址、下载页和第二页。`);
  await rp.pressEnter(panel);

  // 反例里两次导航各等满 30 秒，所以这里给足时间，让失败落在判据上而不是等待上。
  await until(async () => await rp.evaluate(panel, `!document.querySelector("#status-pill")?.classList.contains("running") && document.querySelector("#send-btn")?.disabled===false && document.querySelector("#messages")?.textContent.includes(${JSON.stringify(FINAL)})`) || undefined, 150_000, "final answer");
  await sleep(1500);

  const last = payloads.at(-1);
  receipts = (last?.messages ?? []).filter(m => m.role === "tool").map(m => textOf(m.content));
  durations = [0, 1, 2, 3, 4, 5].map(k => (requestAt[k + 1] ?? NaN) - (requestAt[k] ?? NaN));
  downloaded = await readdir(rp.dirs.downloads);
  await rp.screenshot(panel, screenshot);

  const file = await until(async () => (await readFile(join(rp.dirs.downloads, "list.csv")).catch(() => null)) ?? undefined, 5_000, "list.csv in downloads").catch(() => Buffer.alloc(0));
  const report = await until(async () => (await readFile(join(rp.dirs.downloads, "report.csv")).catch(() => null)) ?? undefined, 5_000, "report.csv in downloads").catch(() => Buffer.alloc(0));
  const [a = "", b = "", c = "", d = "", e = "", f = ""] = receipts;

  // (a) 导出地址变成下载：很快返回，回执说开始了下载并写出文件名，文件真存在且字节相同。
  check(`(a) attachment navigate returned in ${durations[0]} ms`, durations[0]! < LIMIT_MS);
  check("(a) receipt says a download started and names list.csv", /document: download/.test(a) && /started a download instead of opening a page/.test(a) && a.includes('"list.csv"'));
  check("(a) receipt carries no query string", !a.includes("mode=all"));
  check("(a) downloaded file has the served bytes", file.equals(CSV));
  check("(a) export requested once", requests.filter(r => r.startsWith("/export")).length === 1);
  // (b) chrome://downloads/ 不能注入：很快返回，不是 timeout。
  check(`(b) chrome://downloads navigate returned in ${durations[1]} ms`, durations[1]! < LIMIT_MS);
  check("(b) receipt readiness is complete", /document: complete/.test(b));
  // (c) 普通页面：照旧就绪并带新页面快照。
  check("(c) receipt readiness is interactive/complete with a fresh snapshot", /document: (interactive|complete)/.test(c) && /Fresh snapshot of the new page[\s\S]*第二页的标题/.test(c));
  // (d) 连不上的地址：Chrome 显示错误页，回执如实说，不说 complete。
  check(`(d) unreachable navigate returned in ${durations[3]} ms`, durations[3]! < LIMIT_MS);
  check("(d) receipt does not say complete", !/document: complete/.test(d));
  check("(d) receipt says Chrome showed an error page", /document: error_page/.test(d) && /error page/.test(d));
  // (e) 新标签页打开的地址变成下载：不是报错，回执说下载和标签页被关，文件真存在。
  check(`(e) tabs open returned in ${durations[4]} ms`, durations[4]! < LIMIT_MS);
  check("(e) receipt says a download started, names report.csv and says the tab was closed", /document: download/.test(e) && e.includes('"report.csv"') && /closed/.test(e) && !/^Error|错误|失败/.test(e));
  check("(e) downloaded file has the served bytes", report.equals(REPORT));

  // (f) 等待上限先到、下载还没完：回执仍带这次下载，如实说还没存好。
  check("(f) receipt keeps the download and says it is not saved yet", /document: download/.test(f) && f.includes('"slow.csv"') && /not saved yet/.test(f) && !/reports it complete/.test(f));

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
