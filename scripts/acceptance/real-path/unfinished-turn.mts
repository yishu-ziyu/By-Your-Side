/**
 * 没做完的一轮：请求里一项页面上做得到、一项做不到，看侧栏是否只留一行加「继续」，并拍下执行过程展开后的步骤清单。
 *
 *   npx tsx scripts/acceptance/real-path/unfinished-turn.mts --headless [--model=provider/id]
 *
 * 判据：侧栏那一行说的是用户没拿到的事（升级套餐），不是中途失败的内部步骤；没有「继续」；
 * 展开后只有动作清单，没有思考/草稿分组、单步耗时和交付工具。
 * 练习页在本机，不碰真实账号。产物：panel-collapsed.png、panel-expanded.png、summary.json。
 */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";

requireHeadless();

const LIMIT_MS = 600_000;

const PROMPT = "在页面上圈出五小时用量和「升级套餐」按钮。";

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-unfinished-turn`);

await mkdir(artifacts, { recursive: true });

// 页面上没有「升级套餐」按钮：第二项必然做不到。
const QUOTA = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>套餐用量</title></head><body><main><h1>套餐用量</h1><section><h2>当前套餐：Go</h2>
<div class="row"><span>本月请求数</span><strong>1,204</strong></div>
<div class="row" id="five-hour"><span>五小时用量</span><strong>32%</strong></div>
<div class="row"><span>剩余额度</span><strong>$12.40</strong></div></section></main></body></html>`;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(QUOTA);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  const resume = q("#resume-entry-root");
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    running: q("#status-pill")?.classList.contains("running") ?? false,
    stopping: q("#send-btn")?.classList.contains("stopping") ?? false,
    streaming: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing]"),
    userMessages: document.querySelectorAll(".msg.user").length,
    answers: [...document.querySelectorAll("#messages .msg.assistant")].map((el) => el.innerText.trim()).filter(Boolean),
    resumeText: resume?.innerText.trim() ?? "",
    resumeButton: [...(resume?.querySelectorAll("button") ?? [])].map((b) => b.innerText.trim()),
    processTitles: [...document.querySelectorAll("#messages .run-steps > summary")].map((el) => el.innerText.trim()),
    steps: [...document.querySelectorAll("#messages .run-steps .chip")].map((el) => el.innerText.trim()),
    visibleGroups: [...document.querySelectorAll("#messages .run-steps .run-body > details.thinking")].filter((el) => el.getClientRects().length > 0).length,
  };
})()`;

type PanelState = {
  connected: boolean; running: boolean; stopping: boolean; streaming: boolean; userMessages: number;
  answers: string[]; resumeText: string; resumeButton: string[]; processTitles: string[]; steps: string[]; visibleGroups: number;
};

const rp = await launchRealPath();

let final: PanelState | null = null;

let doneMs: number | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/quota` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  // SAFETY: PANEL_STATE 返回的对象字段与 PanelState 一一对应。
  const readPanel = async () => (await rp.evaluate(panel, PANEL_STATE)) as PanelState;

  await until(async () => (await readPanel()).connected || undefined, 90_000, "侧栏连上伴随进程", 500);
  await sleep(1500);
  await rp.click(panel, "#input");
  await rp.typeText(panel, PROMPT);
  const sentAt = Date.now();
  await rp.pressEnter(panel);
  let idle = 0;

  while (Date.now() - sentAt < LIMIT_MS) {
    const state = await readPanel().catch(() => null);

    if (state) {
      final = state;
      const busy = state.running || state.stopping || state.streaming;
      idle = !busy && state.userMessages > 0 && Date.now() - sentAt > 3000 ? idle + 1 : 0;

      if (idle >= 6) {
        doneMs = Date.now() - sentAt - 1500;
        break;
      }
    }

    await sleep(250);
  }

  await sleep(1000);
  final = (await readPanel().catch(() => null)) ?? final;
  await rp.screenshot(panel, join(artifacts, "panel-collapsed.png")).catch(() => {});
  await rp.click(panel, "#messages .run-steps > summary").catch(() => {});
  await sleep(600);
  await rp.screenshot(panel, join(artifacts, "panel-expanded.png")).catch(() => {});
  await rp.screenshot(work, join(artifacts, "page.png")).catch(() => {});
  final = (await readPanel().catch(() => null)) ?? final;
} finally {
  await writeFile(join(artifacts, "hostlog.txt"), await rp.hostLog()).catch(() => {});
  await cp(join(rp.dirs.data, "traces"), join(artifacts, "traces"), { recursive: true }).catch(() => {});
  await rp.close();
  site.close();
}

const failures: string[] = [];

if (doneMs === null) failures.push(`超过 ${LIMIT_MS / 1000} 秒未结束`);

if (!final?.resumeText.includes("升级套餐")) failures.push(`那一行没说出没做成的事：${JSON.stringify(final?.resumeText)}`);

if (final?.resumeButton.length) failures.push(`仍有按钮：${final.resumeButton.join("、")}`);

if (final?.visibleGroups) failures.push(`展开后仍显示 ${final.visibleGroups} 个思考/草稿分组`);

if (final?.steps.some((step) => /send_user_message|task_goals|\d+\.\ds/.test(step))) failures.push(`步骤里有交付工具或单步耗时：${final.steps.join(" | ")}`);

const summary = { case: "unfinished-turn", startedAt: startedAt.toISOString(), prompt: PROMPT, doneMs, outcome: failures.length ? "fail" : "pass", failures, final };

await writeFile(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));

console.log(artifacts);

await rp.remove();
