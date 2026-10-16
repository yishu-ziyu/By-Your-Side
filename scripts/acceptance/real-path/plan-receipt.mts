/**
 * 真实扩展的任务结果卡：完成、恢复、失败、中止、重试成功、同名字段和部分提交。
 *   npx tsx scripts/acceptance/real-path/plan-receipt.mts --headless [--case=success|undo|failed|stopped|recovered|duplicate|partial] [--record]
 * 脚本模型与本机练习页，只证明程序层；判页面字段、提交副作用和用户可见状态。
 * --record 留侧栏和网页录屏；SIDEAGENT_ACCEPTANCE_DIST 可指向冻结版本做前后对照。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

type Case = "success" | "undo" | "failed" | "stopped" | "recovered" | "duplicate" | "partial";
const only = process.argv.find(a => a.startsWith("--case="))?.slice(7) as Case | undefined;
const cases: Case[] = only ? [only] : ["success", "undo", "failed", "stopped", "recovered", "duplicate", "partial"];
const record = process.argv.includes("--record");
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-plan-receipt`);

await mkdir(artifacts, { recursive: true });

const site = createServer((req, res) => {
  if (req.url === "/duplicate" || req.url === "/partial") {
    const divide = req.url === "/partial" ? ` <button id="submit-project" type="submit">保存项目信息</button></form><form onsubmit="event.preventDefault()">` : "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>项目发布</title><style>body{padding:24px;font:18px/2 sans-serif}fieldset{margin-bottom:16px}label{display:block}input{font:inherit}</style><main><h1>项目发布</h1><form onsubmit="event.preventDefault(); document.body.dataset.submitted = String(Number(document.body.dataset.submitted || 0) + 1)"><fieldset><legend>项目信息</legend><label>标题 <input id="project-title" value="原项目标题"></label><label>负责人 <input id="owner" value="原负责人"></label></fieldset>${divide}<fieldset><legend>首篇文章</legend><label>标题 <input id="article-title" value="原文章标题"></label><label>摘要 <input id="summary" value="原摘要"></label><label>作者 <input id="author" value="原作者"></label></fieldset><button>发布</button></form></main></html>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>活动报名</title><style>body{margin:0;padding:32px 40px;font:18px/2.2 sans-serif;color:#222}input{font:inherit;padding:2px 8px;width:260px}</style></head><body><main><h1>活动报名</h1>
<form onsubmit="event.preventDefault()"><label>姓名 <input id="name"></label><br><label>电话 <input id="phone"></label><br><label>邮箱 <input id="email"></label><br><button type="submit">提交报名</button></form></main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const ASK = "帮我把报名表填了，用我的常用信息";
const DONE: Record<Case, string> = { success: "填好了，还没点提交。邮箱用的是你的工作邮箱。", undo: "填好了，还没点提交。邮箱用的是你的工作邮箱。", failed: "电话那一栏没找到，只填了姓名。", stopped: "", recovered: "填好了，还没点提交。邮箱用的是你的工作邮箱。", duplicate: "五处都填好了，还没发布。", partial: "五处都填好了，还没发布。" };
// 脚本模型用 CSS 选择器填，步骤名写成「填「#name」」：填写的步骤名取自 target，产品里 fill 没有单独的栏名参数。
const fill = (target: string, value: string, _field: string, delayMs = 700): Step => ({ tool: { name: "fill", args: { target, value } }, delayMs });
const STEPS: Record<Case, Step[]> = {
  success: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明", "姓名"), fill("#phone", "13812345678", "电话"), fill("#email", "xiaoming@work.example", "邮箱"), { text: DONE.success, delayMs: 600 }],
  duplicate: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#project-title", "新项目标题", "标题"), fill("#owner", "新负责人", "负责人"), fill("#article-title", "新文章标题", "标题"), fill("#summary", "新摘要", "摘要"), fill("#author", "新作者", "作者"), { text: DONE.duplicate, delayMs: 600 }],
  partial: [],
  undo: [],
  failed: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明", "姓名"), fill("#tel-missing", "13812345678", "电话"), { text: DONE.failed, delayMs: 600 }],
  stopped: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明", "姓名"), fill("#phone", "13812345678", "电话", 6000), fill("#email", "xiaoming@work.example", "邮箱"), { text: "填好了。" }],
  recovered: [{ tool: { name: "snapshot", args: {} }, delayMs: 600 }, fill("#name", "王小明", "姓名"), fill("#tel-missing", "13812345678", "电话"), fill("#phone", "13812345678", "电话"), fill("#email", "xiaoming@work.example", "邮箱"), { text: DONE.recovered, delayMs: 600 }],
};
STEPS.undo = STEPS.success;
STEPS.partial = STEPS.duplicate;

type Seen = { line: string; open: boolean; goal: string; before: boolean; looseRuns: number; answerUndo: boolean; error: number; resultAfterCard: string; faded: number; resumeInCard: boolean; taskCards: number };
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
    await rp.cdp.send("Page.navigate", { url: name === "duplicate" || name === "partial" ? `${origin}${name}` : origin }, work);
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
        resumeInCard: !!card?.querySelector(".plan-resume .resume-action"),
        taskCards: [...document.querySelectorAll("#messages .ai-task-card")].filter(c => c.getClientRects().length > 0).length,
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

    if (name === "duplicate" || name === "partial") {
      const restoredCount = name === "partial" ? 2 : 4;
      const values = () => rp.evaluate(work, `Array.from(document.querySelectorAll("input"), e => e.value)`);
      const scope = String(await rp.evaluate(panel, 'document.querySelector(".plan-undo-scope")?.textContent ?? ""'));
      evidence.filled = { values: await values(), scope };
      await rp.screenshot(panel, join(artifacts, `${name}-filled-panel.png`));
      await rp.screenshot(work, join(artifacts, `${name}-filled-page.png`));
      assert.deepEqual(await values(), ["新项目标题", "新负责人", "新文章标题", "新摘要", "新作者"], "五处都真实填入");
      assert.match(end.line, /^已填\s*5\s*项/u, `同名字段也计入五处 ${JSON.stringify(end)}`);
      assert.equal((scope.match(/标题/g) ?? []).length, 2, `范围列出两处标题，不按名字去重 ${scope}`);
      assert.ok(scope.includes("项目信息") && scope.includes("首篇文章"), `同名标题用所在分区区分 ${scope}`);
      assert.ok(!end.open && !end.answerUndo && end.before, `只在原计划卡提供还原 ${JSON.stringify(end)}`);
      const scopeVisible = () => rp.evaluate(panel, '!!document.querySelector(".plan-undo-scope")?.getClientRects().length');
      assert.equal(await scopeVisible(), false, "收起计划卡时范围不可见");
      await rp.click(panel, ".plan-card .plan-details");
      assert.equal(await scopeVisible(), true, "展开后范围和位置名可见");
      assert.ok(await rp.evaluate(panel, '["项目信息", "首篇文章"].every(place => [...document.querySelectorAll(".plan-undo-scope li")].some(e => e.getClientRects().length && e.textContent.includes(place) && e.textContent.includes("标题")))'), "两个标题的位置名真实可见");
      await rp.screenshot(panel, join(artifacts, `${name}-scope-panel.png`));
      await rp.click(panel, ".plan-card .plan-details");
      if (name === "partial") {
        await rp.click(work, "#submit-project");
        assert.equal(await rp.evaluate(work, 'Number(document.body.dataset.submitted)'), 1, "真实点击触发第一张表单的 submit");
        await until(async () => await rp.evaluate(panel, '/已提交|页面已变化/.test(document.querySelector(".plan-undo-scope")?.textContent ?? "")') || undefined, 10_000, "submitted fields marked unavailable", 100);
        assert.match((await seen()).line, /^已填\s*5\s*项/u, "已提交的两处仍计入本轮填写总数");
      }
      await rp.click(work, "#article-title");
      for (const type of ["keyDown", "keyUp"]) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: "End", code: "End", windowsVirtualKeyCode: 35 }, work);
      await rp.typeText(work, "用户后改");
      await rp.click(panel, ".plan-card .plan-undo");
      await until(async () => (await values())[3] === "原摘要" || undefined, 10_000, "untouched fields restored", 100);
      await until(async () => (await seen()).resultAfterCard.includes(String(restoredCount)) || undefined, 10_000, "partial restore result", 100);
      const after = await seen();
      evidence.afterUndo = { after, values: await values() };
      await rp.screenshot(panel, join(artifacts, `${name}-restored-panel.png`));
      await rp.screenshot(work, join(artifacts, `${name}-restored-page.png`));
      assert.deepEqual(await values(), [name === "partial" ? "新项目标题" : "原项目标题", name === "partial" ? "新负责人" : "原负责人", "新文章标题用户后改", "原摘要", "原作者"], "只恢复仍可恢复的字段，保留已提交和用户后改的值");
      const assertPartial = (state: Seen) => {
        assert.match(state.resultAfterCard, new RegExp(`(?:还原|恢复)了?\\s*${restoredCount}\\s*处`, "u"), `显示真实恢复数量 ${JSON.stringify(state)}`);
        assert.ok(/(?:后来|后).*改过.*没动/u.test(state.resultAfterCard) && state.resultAfterCard.includes("标题") && state.resultAfterCard.includes("首篇文章"), `说明哪处是用户后改、未动 ${JSON.stringify(state)}`);
        if (name === "partial") {
          assert.match(state.line, /^已填\s*5\s*项/u, "恢复后仍保留总填写数");
          assert.ok(/已提交|页面已变化/u.test(state.resultAfterCard) && /(?:无法|不能)恢复/u.test(state.resultAfterCard) && /项目信息[^。]*标题/u.test(state.resultAfterCard) && state.resultAfterCard.includes("负责人"), `说明已提交的两处不能恢复 ${JSON.stringify(state)}`);
        }
        assert.ok(!state.answerUndo && state.before && !/(?:已撤销|已还原|已恢复)\s*·?$/u.test(state.line), `不能把部分恢复概括为全部恢复 ${JSON.stringify(state)}`);
      };
      assertPartial(after);
      await rp.cdp.send("Page.reload", {}, panel);
      await until(async () => await rp.evaluate(panel, '!!document.querySelector(".plan-card .plan-receipt-line") && !!document.querySelector(".plan-card + .fill-undo-result")') || undefined, 30_000, "plan card and partial restore replayed", 100);
      const reopened = await seen();
      const entries = await rp.evaluate(panel, 'document.querySelectorAll(".plan-card .plan-undo, #messages .answer-primary[data-action=undo-fill]").length');
      evidence.reopened = { ...reopened, entries };
      await rp.screenshot(panel, join(artifacts, `${name}-reopened-panel.png`));
      assert.equal(entries, 1, "重开后仅一个还原入口");
      assert.equal(await rp.evaluate(panel, 'document.querySelectorAll(".plan-card").length'), 1, "原任务仍是一张计划卡");
      assertPartial(reopened);
    }

    if (name === "success" || name === "undo" || name === "recovered") {
      assert.match(end.line, /^已填 3 项 · 用时 \d+ 秒 · 恢复这 3 处填写 ·$/, `收成一行 ${JSON.stringify(end)}`);
      assert.ok(!end.open && end.before && end.looseRuns === 0, `收起、在回答上面、没有另一块过程 ${JSON.stringify(end)}`);
      assert.ok(!end.answerUndo, `回答下没有还原填写 ${JSON.stringify(end)}`);
    }

    if (name === "success" || name === "recovered") {
      if (record) await sleep(1200);
      await rp.click(panel, ".plan-card .plan-details");
      await sleep(900);
      const opened = await rp.evaluate(panel, `(() => {
        const card = document.querySelector(".plan-card");
        return {
          labels: card?.open ? [...document.querySelectorAll(".plan-card .chip:not(.prep) .chip-label")].map(e => e.textContent.trim()) : [],
          error: card?.querySelectorAll(".chip.error").length ?? 0,
        };
      })()`) as { labels: string[]; error: number };
      evidence.opened = opened;
      assert.ok(opened.labels.length >= 3, `细节里展开每一步 ${JSON.stringify(opened)}`);
      if (name === "recovered") assert.ok(opened.error >= 1 && !end.line.startsWith("没做完"), `一步没做成但整轮做完，卡仍收成一行 ${JSON.stringify({ end, opened })}`);
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
      assert.ok(after.line.includes("已恢复 3 处") && after.resultAfterCard.startsWith("还原了 3 处") && after.faded < 0.6, `卡上写已撤销，卡下写结果，回答变淡 ${JSON.stringify(after)}`);
    }

    if (name === "failed") assert.ok(end.line.startsWith("没做完 · ") && end.open && end.error >= 1, `没做完时卡展开、标出没做成那一步 ${JSON.stringify(end)}`);

    if (name === "failed") assert.ok(end.resumeInCard && end.taskCards === 0, `「继续原任务」在卡里，下面没有另一张卡 ${JSON.stringify(end)}`);

    if (name === "stopped") assert.ok(end.line.startsWith("已中止 · ") && end.open && end.taskCards === 0, `中止时卡展开、下面没有另一张卡 ${JSON.stringify(end)}`);

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
