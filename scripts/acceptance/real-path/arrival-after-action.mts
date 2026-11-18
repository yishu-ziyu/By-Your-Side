import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-arrival-after-action`);

await mkdir(artifacts, { recursive: true });

const MARK = "到达新页";
const FINAL = `【${MARK}结束】`;
const SLOW_MS = 700;

type Payload = { tools?: unknown[]; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };

const textOf = (content: string | Array<{ text?: string }> | null | undefined) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";

const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8">${body}`);

  if (url.pathname === "/results") { setTimeout(() => html(`<title>结果页</title><h1>搜索结果：${url.searchParams.get("q") ?? ""}</h1><p>结果正文已就绪</p>`), SLOW_MS); return; }

  if (url.pathname === "/detail") { setTimeout(() => html(`<title>详情页</title><h1>慢页面正文</h1>`), SLOW_MS); return; }

  html(`<title>首页</title><form action="/results"><input id="q" name="q" aria-label="站内搜索"></form><a id="go" href="/detail">去详情</a>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const closed = createServer();
await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
const unreachable = `http://127.0.0.1:${siteAddress(closed).port}/profile`;
await new Promise(resolve => closed.close(resolve));

const steps: Step[] = [
  { tool: { name: "browser_run", args: { code: 'await browser.fill({target:"#q", value:"故宫"}); return await browser.pressKey({key:"Enter"});' } } },
  { tool: { name: "navigate", args: { url: `${origin}/`, inPlace: true } } },
  { tool: { name: "browser_run", args: { code: 'return await browser.click({target:"#go"});' } } },
  { tool: { name: "navigate", args: { url: `${origin}/`, inPlace: true } } },
  { tool: { name: "fill", args: { target: "#q", value: "长城" } } },
  { tool: { name: "press_key", args: { key: "Enter" } } },
  { tool: { name: "tabs", args: { action: "open", url: unreachable } } },
  { text: `已经为你打开了作者主页。${FINAL}` },
];

const payloads: Payload[] = [];
const goalChecks: string[] = [];

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: MARK, steps },
], undefined, payload => {
  const p = payload as Payload;
  const raw = JSON.stringify(p);

  if (raw.includes('\\"goalPage\\"') || raw.includes('"goalPage"')) goalChecks.push(raw);

  if (!p.tools?.length || !p.messages?.some(m => m.role === "user" && textOf(m.content).includes(MARK))) return;
  payloads.push(p);
});

const rp = await launchRealPath();
const screenshot = join(artifacts, "sidebar.png");
let error: string | null = null;
let receipts: string[] = [];
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
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new") && document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK}：在站内搜索故宫，再打开详情，再搜长城，最后打开作者主页。`);
  await rp.pressEnter(panel);

  await until(async () => await rp.evaluate(panel, `!document.querySelector("#status-pill")?.classList.contains("running") && document.querySelector("#send-btn")?.disabled===false && document.querySelector("#messages")?.textContent.includes(${JSON.stringify(FINAL)})`) || undefined, 150_000, "final answer");
  await until(async () => goalChecks.length ? true : undefined, 30_000, "goal check request").catch(() => undefined);
  await sleep(500);
  await rp.screenshot(panel, screenshot);

  receipts = (payloads.at(-1)?.messages ?? []).filter(m => m.role === "tool").map(m => textOf(m.content));
  const [a = "", , c = "", , , f = ""] = receipts;
  const check0 = goalChecks.at(-1) ?? "";

  check("(a) Enter inside a program returns the arrived results page with its text", /"arrived"/.test(a) && a.includes("搜索结果：故宫"));
  check("(c) click inside a program returns the arrived slow page with its text", /"arrived"/.test(c) && c.includes("慢页面正文"));
  check("(f) standalone Enter returns a fresh snapshot of the results page", /Fresh snapshot|fresh snapshot/i.test(f) && f.includes("搜索结果：长城"));
  check("(g) the goal check is told the opened profile tab showed an error page", /\\?"loaded\\?":\\?"error_page/.test(check0));

  if (checks.some(item => !item.pass)) throw new Error(`failed: ${checks.filter(item => !item.pass).map(item => item.name).join(" | ")}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice site", checks, receipts: receipts.map(r => r.slice(0, 1500)), goalCheck: (goalChecks.at(-1) ?? "").slice(0, 4000), screenshot, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, checks, error }, null, 2));
process.exit(error ? 1 : 0);
