/**
 * 计划卡原地变成回执：只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/plan-receipt.mts --headless [--record]
 *   1) 填表任务一开始，对话里有一张计划卡，卡头是「会去 … · 不会做 …」；每做完一步，同一张卡里那一步打勾，不另起一块。
 *   2) 做完后这张卡收成一行「已填 3 项 · 用时 N 秒 · 撤销 · 细节 ›」，就在回答上面；过程行不再单独叠在侧栏里。
 *   3) 点「细节 ›」：同一张卡里展开每一步；点「撤销」：网页里三栏回到原样（走原有的还原填写）。
 * --record：录下整段的侧栏和网页，左右并排成 plan-receipt.mp4，只给人看，不参与判定。
 * SIDEAGENT_ACCEPTANCE_DIST 指向旧版扩展时用来录改动前的样子，判定照常会失败。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-plan-receipt`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>活动报名</title><style>body{margin:0;padding:32px 40px;font:18px/2.2 sans-serif;color:#222}input{font:inherit;padding:2px 8px;width:260px}</style></head><body><main><h1>活动报名</h1>
<form onsubmit="event.preventDefault()"><label>姓名 <input id="name"></label><br><label>电话 <input id="phone"></label><br><label>邮箱 <input id="email"></label><br><button type="submit">提交报名</button></form></main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const ASK = "帮我把报名表填了，用我的常用信息";
const DONE = "填好了，还没点提交。邮箱用的是你的工作邮箱。";
const fill = (target: string, value: string) => ({ tool: { name: "fill", args: { target, value } }, delayMs: 700 });
const model = await startScriptedModel([
  { match: ASK, steps: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明"), fill("#phone", "13812345678"), fill("#email", "xiaoming@work.example"), { text: DONE, delayMs: 600 }] },
]);

const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "page loaded");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const record = process.argv.includes("--record");
  const stops = record ? [await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")), await recordScreen(rp.cdp, work, join(artifacts, "page.mp4"))] : [];
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);

  // 1) 进行中：同一张卡里的步骤打勾。
  const midway = await until(async () => {
    const seen = await rp.evaluate(panel, `(() => { const card = document.querySelector(".plan-card"); return card ? { done: card.querySelectorAll(".chip:not(.prep) .chip-dot.done").length, steps: [...card.querySelectorAll(".chip")].filter(s => s.getClientRects().length > 0).length, goal: card.querySelector(".task-plan-goal")?.textContent ?? "" } : null; })()`) as { done: number; steps: number; goal: string } | null;

    return seen && seen.done >= 1 ? seen : undefined;
  }, 30_000, "a step ticked in the plan card", 100).catch(() => null);
  evidence.midway = midway;
  await rp.screenshot(panel, join(artifacts, "1-midway.png"));

  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(DONE)})`) || undefined, 60_000, "answer", 100);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "settled", 100);
  await sleep(1500);
  await rp.screenshot(panel, join(artifacts, "2-done.png"));
  const done = await rp.evaluate(panel, `(() => {
    const card = document.querySelector(".plan-card");
    const answer = [...document.querySelectorAll("#messages .msg.assistant")].find(m => m.textContent.includes(${JSON.stringify(DONE)}));
    const line = card?.querySelector(".plan-receipt-line");
    return {
      line: line?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      before: !!(card && answer && (card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)),
      collapsed: card instanceof HTMLDetailsElement && !card.open,
      looseRuns: [...document.querySelectorAll("#messages details.run-steps:not(.plan-card)")].filter(s => s.getClientRects().length > 0).length,
    };
  })()`) as { line: string; before: boolean; collapsed: boolean; looseRuns: number };
  evidence.done = done;

  let opened = 0;
  if (done.line) {
    if (record) await sleep(1200);
    await rp.click(panel, ".plan-card .plan-details");
    await sleep(800);
    opened = await rp.evaluate(panel, `document.querySelector(".plan-card")?.open ? [...document.querySelectorAll(".plan-card .chip:not(.prep)")].filter(s => s.getClientRects().length > 0).length : 0`) as number;
    await rp.screenshot(panel, join(artifacts, "3-details.png"));
    if (record) await sleep(1500);
    await rp.click(panel, ".plan-card .plan-details");
    await sleep(600);
  } else if (record) {
    await sleep(3000);
  }
  evidence.detailsOpened = opened;

  let restored: Record<string, string> = {};
  if (done.line) {
    await rp.click(panel, ".plan-card .plan-undo");
    await until(async () => (await rp.evaluate(work, `document.getElementById("email").value === ""`)) || undefined, 10_000, "undo", 100).catch(() => undefined);
    await sleep(1200);
    restored = JSON.parse(String(await rp.evaluate(work, `JSON.stringify({ name: document.getElementById("name").value, phone: document.getElementById("phone").value, email: document.getElementById("email").value })`)));
    await rp.screenshot(panel, join(artifacts, "4-undone.png"));
  }
  evidence.restored = restored;

  if (record) {
    const [panelVideo, pageVideo] = await Promise.all(stops.map(stop => stop()));

    if (panelVideo && pageVideo) {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", pageVideo, "-i", panelVideo, "-filter_complex",
        "[0:v][1:v]scale2ref=oh*mdar:ih[page][panel];[page][panel]hstack=inputs=2,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", join(artifacts, "plan-receipt.mp4")]);
      evidence.recording = join(artifacts, "plan-receipt.mp4");
    }
  }

  assert.ok(midway && midway.steps >= 1 && midway.goal.startsWith("会去 "), `1: 进行中同一张卡里有计划、步骤打勾 ${JSON.stringify(midway)}`);
  assert.match(done.line, /^已填 3 项 · 用时 \d+ 秒 · 撤销 · 细节 ›$/, `2: 收成一行 ${JSON.stringify(done)}`);
  assert.ok(done.before && done.collapsed && done.looseRuns === 0, `2: 卡在回答上面、步骤收起、没有另一块过程 ${JSON.stringify(done)}`);
  assert.ok(opened >= 3, `3: 细节里展开每一步 ${opened}`);
  assert.deepEqual(restored, { name: "", phone: "", email: "" }, "3: 撤销后网页三栏回到原样");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
