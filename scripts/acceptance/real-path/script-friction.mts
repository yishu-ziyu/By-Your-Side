/**
 * 页面在 snapshot 之后刷新：js、CSS 点击照常在新页面执行；js 的 saveAs 把页面数据直接存成侧栏文件
 * （docs/evals/20261004-script-friction.md R1、R4）。只装扩展、隔离构建、本机脚本模型；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/script-friction.mts --headless
 * 失败方式：刷新后 js / 点击回「页面文档已变化」；saveAs 的正文回到模型；卡片缺失或内容与页面不一致。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-script-friction`);

await mkdir(artifacts, { recursive: true });

// 独立参照：服务器第 v 次出页时的正文，测试按同一公式算期望值。
const pageData = (v: number) => Array.from({ length: 120 }, (_, i) => `第${v}版 第${i + 1}行 字幕`).join("\n") + "\n";

let version = 0;

let acks = 0;

const site = createServer((req, res) => {
  if (req.url === "/ack") { acks++; res.writeHead(204).end();

 return; }

  if (req.url !== "/") { res.writeHead(404).end();

 return; }

  version++;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>字幕页</title><button id="ack" onclick="fetch('/ack')">已读</button><pre id="data">${pageData(version)}</pre>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

const MARK = "刷新后读取并存文件";

const READ = 'document.querySelector("#data").textContent';

/** 产品发给模型的 OpenAI 兼容请求里本脚本要读的部分：有没有工具表、各条消息的正文。 */
type Payload = { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };

const payloads: Payload[] = [];

const model = await startScriptedModel([{ match: MARK, steps: [
  { tool: { name: "tabs", args: { action: "active" } } },
  { tool: { name: "snapshot", args: {} } },
  // 这一步的模型回复压住 4 秒，驱动在此期间刷新页面：js 发出时页面已不是 snapshot 那份文档。
  { tool: { name: "js", args: { code: READ } }, delayMs: 4000 },
  { tool: { name: "click", args: { target: "#ack" } } },
  { tool: { name: "js", args: { code: READ, saveAs: "page-data.txt" } } },
  { text: `【${MARK}结束】` },
] }], undefined, payload => {
  // SAFETY: 脚本模型把产品的 OpenAI 兼容请求体原样交给这里；Payload 只取其中可选的 tools 与 messages。
  payloads.push(payload as Payload);
});

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的现场证据。 */
type Evidence = { receipts?: string[]; versionAtSnapshot?: number; savedChars?: number };

const evidence: Evidence = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK}：读当前页的字幕全文，存成 page-data.txt。`);
  await rp.pressEnter(panel);

  // 模型请求第 2 步（js）时 snapshot 已经做完；趁回复被压住时刷新页面。
  await until(async () => model.requests.some(r => r.rule === MARK && r.step === 2) || undefined, 60_000, "snapshot done");
  const versionAtSnapshot = version;
  await rp.cdp.send("Page.reload", {}, work);
  await until(async () => String(await rp.evaluate(work, 'document.querySelector("#data")?.textContent ?? ""').catch(() => "")).startsWith(`第${versionAtSnapshot + 1}版`) || undefined, 10_000, "reloaded page");
  const expected = pageData(versionAtSnapshot + 1);

  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(`【${MARK}结束】`)}) && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 90_000, "task finished");
  await sleep(500);

  // 主任务请求带工具表；之后的核对类请求不带，也不含工具回执。
  const last = payloads.findLast(p => p.tools?.length && p.messages?.some(m => m.role === "user" && JSON.stringify(m.content).includes(MARK)))!;
  const receipts = (last.messages ?? []).filter(m => m.role === "tool").map(m => Array.isArray(m.content) ? m.content.map(part => part.text ?? "").join("") : m.content ?? "");
  evidence.receipts = receipts.map(r => r.slice(0, 300));
  evidence.versionAtSnapshot = versionAtSnapshot;
  await rp.screenshot(panel, join(artifacts, "sidebar.png"));

  // R1：刷新后 js 读到新页面、CSS 点击真的点到；全程没有「文档已变化」。
  assert.ok(!receipts.some(r => /页面文档已变化|STALE_DOCUMENT/.test(r)), "no stale-document refusal after reload");
  assert.ok(receipts[2]?.includes(`第${versionAtSnapshot + 1}版 第1行`), "js read the reloaded page");
  assert.equal(acks, 1, "CSS click on the reloaded page reached the site");
  // R4：saveAs 的回执只有文件名、字数、行数；正文没回到模型。
  assert.equal(receipts[4], JSON.stringify({ filename: "page-data.txt", chars: expected.length, lines: 120 }));

  // 侧栏卡片：像用户一样点「下载」，文件内容与页面数据逐字相同。
  const dir = join(rp.dirs.downloads, "card");
  await mkdir(dir, { recursive: true });
  await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  const sel = '.artifact-card[data-filename="page-data.txt"] .artifact-download';
  await until(async () => await rp.evaluate(panel, `!!document.querySelector(${JSON.stringify(sel)})`) || undefined, 10_000, "file card");
  await rp.evaluate(panel, `document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:"center"}); true`);
  await rp.click(panel, sel);
  const name = await until(async () => (await readdir(dir)).find(f => !f.endsWith(".crdownload")), 15_000, "download");
  const saved = await readFile(join(dir, name), "utf8");
  await writeFile(join(artifacts, "downloaded-page-data.txt"), saved);
  assert.equal(saved, expected, "saved file equals the reloaded page data");
  evidence.savedChars = saved.length;
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
