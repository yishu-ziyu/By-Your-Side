/**
 * 圈的地方带上页面内容（YIS-89）：圈住一张商品卡，请求里「圈 1」带着卡上的名字和价格；圈住空白处，只带图不编文字。
 * 只装扩展、隔离构建、本机脚本模型（读请求原文，不花钱）。圈是真鼠标拖出来的。
 *   npx tsx scripts/acceptance/real-path/circle-notes.mts --headless
 * 失败方式：请求里没有圈内文字；带了圈外的文字（A 款）；空白处编出了文字；带了输入框里的值。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-circle-notes`);

await mkdir(artifacts, { recursive: true });

const SECRET = "hunter2-secret";

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>两款耳机</title>
<style>body{font:16px system-ui;margin:0;padding:40px;display:flex;gap:40px} .card{width:220px;height:160px;border:1px solid #ccc;border-radius:12px;padding:16px}</style>
<div class="card" style="background:#eef5ff"><h2>A 款</h2><p>399 元 · 30 小时</p></div><div class="card" style="background:#fff3e8"><h2>B 款</h2><p>499 元 · 40 小时</p><input type="password" value="${SECRET}"></div>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const QUESTION = "圈的这两处是什么";

/** 带这句问话的请求原文。 */
const sent: string[] = [];

const model = await startScriptedModel([{ match: QUESTION, steps: [{ text: "好的。" }] }], undefined, (payload) => {
  const text = JSON.stringify(payload.messages ?? []);

  if (text.includes(QUESTION)) sent.push(text);
});

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

let work = "";

const evidence: JsonRecord = {};

// SAFETY: 页面脚本返回数字数组。
const tiles = () => rp.evaluate(panel, `[...document.querySelectorAll("#attachments-strip .tile-56:not(.removing)")].map((t) => Number(t.dataset.circle ?? 0))`) as Promise<number[]>;

/** 用真鼠标在页面上绕 (cx, cy) 画一圈。 */
async function drawCircle(cx: number, cy: number, rx: number, ry: number) {
  const mouse = (type: string, x: number, y: number) => rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, work);

  const at = (i: number) => { const a = -2.3 + (i / 40) * Math.PI * 2.15;

 return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as const; };


  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at(0)[0], y: at(0)[1] }, work);
  await mouse("mousePressed", ...at(0));

  for (let i = 1; i <= 40; i++) { await mouse("mouseMoved", ...at(i)); await sleep(8); }

  await mouse("mouseReleased", ...at(40));
}

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "sidebar ready");

  // 圈 1：B 款整张卡；圈 2：下面的空白处。
  await rp.click(panel, "#attach-btn");
  await rp.click(panel, "#menu-action-region");
  await sleep(800);
  await drawCircle(452, 130, 145, 120);
  await until(async () => (await tiles()).length === 1 || undefined, 10_000, "第 1 张附件");
  await drawCircle(452, 450, 120, 80);
  await until(async () => (await tiles()).length === 2 || undefined, 10_000, "第 2 张附件");
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await rp.screenshot(work, join(artifacts, "circles.png"));

  await rp.click(panel, "#input");
  await rp.typeText(panel, QUESTION);
  await rp.pressEnter(panel);
  await until(async () => sent.length > 0 || undefined, 30_000, "请求发到模型");
  const request = sent[0]!;
  const lines = request.split("\\n");
  evidence.circleLines = lines.filter(l => l.startsWith("圈 "));
  evidence.hasNoteHeader = request.includes("Page text inside the user's circled areas");
  assert.ok(evidence.hasNoteHeader, "请求里有圈内文字一段");
  assert.ok(lines.some(l => l.startsWith("圈 1：") && l.includes("B 款") && l.includes("499 元")), "圈 1 带着 B 款的名字和价格");
  assert.ok(!lines.some(l => l.startsWith("圈 1：") && l.includes("A 款")), "圈 1 不带圈外的 A 款");
  assert.ok(!lines.some(l => l.startsWith("圈 2：")), "空白处的圈 2 不编文字");
  assert.ok(!request.includes(SECRET), "密码框里的值不带");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => undefined);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
