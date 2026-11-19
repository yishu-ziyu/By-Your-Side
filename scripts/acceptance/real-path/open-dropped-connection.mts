import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-open-dropped-connection`);

await mkdir(artifacts, { recursive: true });

const MARK = "断开的网站";
const FINAL = `【${MARK}结束】`;
const LIMIT_MS = 6000;

type Payload = { tools?: unknown[]; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };

const textOf = (content: string | Array<{ text?: string }> | null | undefined) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";

const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>首页</title><h1>首页</h1>"); });
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const dropping = createServer();
dropping.on("connection", socket => socket.destroy());
await new Promise<void>(resolve => dropping.listen(0, "127.0.0.1", resolve));
const dropped = `http://127.0.0.1:${siteAddress(dropping).port}/profile`;

const steps: Step[] = [
  { tool: { name: "tabs", args: { action: "open", url: dropped } } },
  { tool: { name: "navigate", args: { url: dropped } } },
  { text: FINAL },
];

const payloads: Payload[] = [];
const requestAt: Record<number, number> = {};

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: MARK, steps },
], undefined, payload => {
  const p = payload as Payload;

  if (!p.tools?.length || !p.messages?.some(m => m.role === "user" && textOf(m.content).includes(MARK))) return;
  payloads.push(p);
  const count = p.messages.filter(m => m.role === "tool").length;
  requestAt[count] ??= Date.now();
});

const rp = await launchRealPath();
let error: string | null = null;
let receipts: string[] = [];
let durations: number[] = [];
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
  await rp.typeText(panel, `${MARK}：打开作者主页。`);
  await rp.pressEnter(panel);

  await until(async () => await rp.evaluate(panel, `!document.querySelector("#status-pill")?.classList.contains("running") && document.querySelector("#send-btn")?.disabled===false && document.querySelector("#messages")?.textContent.includes(${JSON.stringify(FINAL)})`) || undefined, 120_000, "final answer");

  receipts = (payloads.at(-1)?.messages ?? []).filter(m => m.role === "tool").map(m => textOf(m.content));
  durations = [0, 1].map(k => (requestAt[k + 1] ?? NaN) - (requestAt[k] ?? NaN));
  const [a = "", b = ""] = receipts;

  check(`(a) tabs open on a site that drops the connection returned in ${durations[0]} ms`, durations[0]! < LIMIT_MS);
  check("(a) its receipt says Chrome showed an error page", /document: error_page/.test(a));
  check(`(b) navigate to the same site returned in ${durations[1]} ms`, durations[1]! < LIMIT_MS);
  check("(b) its receipt says Chrome showed an error page", /document: error_page/.test(b));

  if (checks.some(item => !item.pass)) throw new Error(`failed: ${checks.filter(item => !item.pass).map(item => item.name).join(" | ")}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice site", checks, durationsMs: durations, receipts: receipts.map(r => r.slice(0, 800)), error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
  dropping.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, checks, durationsMs: durations, receipts: receipts.map(r => r.slice(0, 400)), error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
