/**
 * 计划卡原地变成回执：只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/plan-receipt.mts --headless [--case=success|undo|failed|stopped] [--record]
 *   不带 --case 时四种依次各跑一遍（各开一个浏览器）。
 *   success：进行中卡头是「会去 … · 不会做 …」，每做完一步同一张卡里那一步打勾；做完收成一行
 *     「已填 3 项 · 用时 N 秒 · 撤销」（后面是「细节 ›」），在回答上面；回答下没有「还原填写」；点细节展开每一步。
 *   undo：同上，点卡上的「撤销」：网页三栏回到空，卡上写「已撤销」，卡下写「还原了 3 处…」，回答变淡。
 *   failed：第 2 步没找到电话栏：卡不收起，行首写「没做完」，没做成那一步标 ✕。
 *   stopped：填到一半用户点停止：卡不收起，行首写「已中止」。
 * --record：录侧栏和网页，左右并排成 <case>.mp4，并截一张结束时的侧栏 <case>-end.png，只给人看，不参与判定。
 * SIDEAGENT_ACCEPTANCE_DIST 指向旧版扩展时用来录改动前的样子，判定照常会失败。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

type Case = "success" | "undo" | "failed" | "stopped";
const only = process.argv.find(a => a.startsWith("--case="))?.slice(7) as Case | undefined;
const cases: Case[] = only ? [only] : ["success", "undo", "failed", "stopped"];
const record = process.argv.includes("--record");
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-plan-receipt`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>活动报名</title><style>body{margin:0;padding:32px 40px;font:18px/2.2 sans-serif;color:#222}input{font:inherit;padding:2px 8px;width:260px}</style></head><body><main><h1>活动报名</h1>
<form onsubmit="event.preventDefault()"><label>姓名 <input id="name"></label><br><label>电话 <input id="phone"></label><br><label>邮箱 <input id="email"></label><br><button type="submit">提交报名</button></form></main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const ASK = "帮我把报名表填了，用我的常用信息";
const DONE: Record<Case, string> = { success: "填好了，还没点提交。邮箱用的是你的工作邮箱。", undo: "填好了，还没点提交。邮箱用的是你的工作邮箱。", failed: "电话那一栏没找到，只填了姓名。", stopped: "" };
// 脚本模型用 CSS 选择器填，步骤名写成「填「#name」」：填写的步骤名取自 target，产品里 fill 没有单独的栏名参数。
const fill = (target: string, value: string, _field: string, delayMs = 700): Step => ({ tool: { name: "fill", args: { target, value } }, delayMs });
const STEPS: Record<Case, Step[]> = {
  success: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明", "姓名"), fill("#phone", "13812345678", "电话"), fill("#email", "xiaoming@work.example", "邮箱"), { text: DONE.success, delayMs: 600 }],
  undo: [],
  failed: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明", "姓名"), fill("#tel-missing", "13812345678", "电话"), { text: DONE.failed, delayMs: 600 }],
  stopped: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明", "姓名"), fill("#phone", "13812345678", "电话", 6000), fill("#email", "xiaoming@work.example", "邮箱"), { text: "填好了。" }],
};
STEPS.undo = STEPS.success;

type Seen = { line: string; open: boolean; goal: string; before: boolean; looseRuns: number; answerUndo: boolean; error: number; resultAfterCard: string; faded: number };
const results: Record<string, unknown> = {};
let failed = false;

for (const name of cases) {
  const model = await startScriptedModel([{ match: ASK, steps: STEPS[name] }]);
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
    const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running") && !!document.querySelector(".plan-card .plan-receipt-line")') || undefined, 60_000, "settled", 100);
    const seen = async () => await rp.evaluate(panel, `(() => {
      const card = document.querySelector(".plan-card");
      const answer = [...document.querySelectorAll("#messages .msg.assistant")].at(-1);
      const next = card?.nextElementSibling;
      return {
        line: card?.querySelector(".plan-receipt-line")?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        open: !!card?.open,
        goal: card?.querySelector(".task-plan-goal")?.textContent ?? "",
        before: !!(card && answer && (card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)),
        looseRuns: [...document.querySelectorAll("#messages details.run-steps:not(.plan-card)")].filter(s => s.getClientRects().length > 0).length,
        answerUndo: !!document.querySelector('#messages .answer-primary[data-action="undo-fill"]') || [...document.querySelectorAll("#messages .answer-primary")].some(b => b.textContent.includes("还原")),
        error: card?.querySelectorAll(".chip.error").length ?? 0,
        resultAfterCard: next?.matches(".fill-undo-result") ? next.textContent : "",
        faded: answer?.querySelector("p") ? Number(getComputedStyle(answer.querySelector("p")).opacity) : 1,
      };
    })()`) as Seen;

    const stops = record ? [await recordScreen(rp.cdp, panel, join(artifacts, `${name}-panel.mp4`)), await recordScreen(rp.cdp, work, join(artifacts, `${name}-page.mp4`))] : [];
    await rp.click(panel, "#input");
    await rp.typeText(panel, ASK);
    await rp.pressEnter(panel);

    const midway = await until(async () => {
      const s = await rp.evaluate(panel, `(() => { const c = document.querySelector(".plan-card"); return c ? { ticked: c.querySelectorAll(".chip:not(.prep) .chip-dot.done").length, goal: c.querySelector(".task-plan-goal")?.textContent ?? "" } : null; })()`) as { ticked: number; goal: string } | null;
      return s && s.ticked >= 1 ? s : undefined;
    }, 30_000, "a step ticked in the plan card", 100);
    evidence.midway = midway;
    assert.ok(midway.goal.startsWith("会去 "), `进行中卡头是计划 ${JSON.stringify(midway)}`);

    if (name === "stopped") {
      await sleep(1200);
      await rp.click(panel, "#send-btn");
    }
    await settled();
    await sleep(1200);
    const end = await seen();
    evidence.end = end;

    if (name === "success" || name === "undo") {
      assert.match(end.line, /^已填 3 项 · 用时 \d+ 秒 · 撤销 ·$/, `收成一行 ${JSON.stringify(end)}`);
      assert.ok(!end.open && end.before && end.looseRuns === 0, `收起、在回答上面、没有另一块过程 ${JSON.stringify(end)}`);
      assert.ok(!end.answerUndo, `回答下没有还原填写 ${JSON.stringify(end)}`);
    }

    if (name === "success") {
      if (record) await sleep(1200);
      await rp.click(panel, ".plan-card .plan-details");
      await sleep(900);
      const opened = await rp.evaluate(panel, `document.querySelector(".plan-card")?.open ? [...document.querySelectorAll(".plan-card .chip:not(.prep) .chip-label")].map(e => e.textContent.trim()) : []`) as string[];
      evidence.opened = opened;
      assert.ok(opened.length >= 3, `细节里展开每一步 ${JSON.stringify(opened)}`);
      if (record) await sleep(1200);
      await rp.click(panel, ".plan-card .plan-details");
      await sleep(900);
    }

    if (name === "undo") {
      if (record) await sleep(1200);
      await rp.click(panel, ".plan-card .plan-undo");
      await until(async () => (await rp.evaluate(work, `document.getElementById("email").value === ""`)) || undefined, 10_000, "undo", 100);
      await sleep(1200);
      const after = await seen();
      const page = JSON.parse(String(await rp.evaluate(work, `JSON.stringify([document.getElementById("name").value, document.getElementById("phone").value, document.getElementById("email").value])`)));
      evidence.afterUndo = { after, page };
      assert.deepEqual(page, ["", "", ""], "网页三栏回到空");
      assert.ok(after.line.includes("已撤销") && after.resultAfterCard.startsWith("还原了 3 处") && after.faded < 0.6, `卡上写已撤销，卡下写结果，回答变淡 ${JSON.stringify(after)}`);
    }

    if (name === "failed") assert.ok(end.line.startsWith("没做完 · ") && end.open && end.error >= 1, `没做完时卡展开、标出没做成那一步 ${JSON.stringify(end)}`);

    if (name === "stopped") assert.ok(end.line.startsWith("已中止 · ") && end.open, `停下时卡展开 ${JSON.stringify(end)}`);

    if (record) await sleep(1500);
    await rp.screenshot(panel, join(artifacts, `${name}-end.png`));

    if (record) {
      const [panelVideo, pageVideo] = await Promise.all(stops.map(stop => stop()));

      if (panelVideo && pageVideo) {
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", pageVideo, "-i", panelVideo, "-filter_complex",
          "[0:v][1:v]scale2ref=oh*mdar:ih[page][panel];[page][panel]hstack=inputs=2,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", join(artifacts, `${name}.mp4`)]);
        evidence.recording = join(artifacts, `${name}.mp4`);
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
    failed = true;
  } finally {
    await rp.close();
    await rp.remove();
    await model.close();
  }
  results[name] = { status: error ? "FAIL" : "PASS", evidence, error };
  console.log(`${error ? "FAIL" : "PASS"} ${name}${error ? ` ${error.split("\n")[0]}` : ""}`);
}

await writeFile(join(artifacts, "result.json"), JSON.stringify(results, null, 2));
site.closeAllConnections();
site.close();
console.log(JSON.stringify({ status: failed ? "FAIL" : "PASS", artifacts }));

if (failed) process.exitCode = 1;
