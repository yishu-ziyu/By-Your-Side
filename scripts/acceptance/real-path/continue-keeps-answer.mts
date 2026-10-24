/**
 * 一次交代几件事，助手写好回答，核对判「接着做」：接着做以模型报错或用户点停止结束时，侧栏仍给出原来那份回答，不只剩报错。
 * 只装扩展、隔离构建、本机脚本模型（目标核对也由脚本回「接着做」）。约 2 分钟。
 *   npx tsx scripts/acceptance/real-path/continue-keeps-answer.mts --headless
 *   a) 接着做时模型报错：侧栏有原回答，也有报错卡。
 *   b) 接着做时用户点停止：侧栏有原回答，这一轮写「已中止」。
 *   c) 重开侧栏从记录重放：a 的原回答还在。
 *   d) 接着做交出新回答：侧栏只有新回答，原回答不再出现。
 * 失败方式：判继续时把扣着的回答直接扔掉，a、b、c 都看不到原回答。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-continue-keeps-answer`);

await mkdir(out, { recursive: true });

const TASK = "续做留底验收：1. 读一下这页的标题；2. 说出页面上的房间数。";
const ANSWER = "标题是「故宫简介」，页面写着有 8886 间房。";
const CONTINUE_JSON = JSON.stringify({ items: [{ text: "读标题", done: true }, { text: "说房间数", done: false }], status: "continue", remaining: "房间数", correction: "还没说房间数", finding: "房间数没说" });
const NEW_ANSWER = "接着做的回答：页面上有 8886 间房。";
const DONE_JSON = JSON.stringify({ items: [{ text: "读标题", done: true }, { text: "说房间数", done: true }], status: "done", remaining: "" });
const FAILURE = JSON.stringify({ error: { message: "scripted continue failure", type: "invalid_request_error" } });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>故宫简介</title><body><main><h1>故宫简介</h1><p>有 8886 间房。</p></main></body></html>`));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
// 交付的回答气泡；执行过程里的草稿（details）不算用户看得到的回答。
const answers = `[...document.querySelectorAll(".msg.assistant")].filter(m => !m.closest("details")).map(m => m.textContent).join("\\n")`;
const running = `document.querySelector("#status-pill")?.classList.contains("running") || document.querySelector("#send-btn")?.classList.contains("stopping")`;

async function runCase(name: "a" | "b" | "d", continueStep: Step): Promise<void> {
  const model = await startScriptedModel([
    // 核对接着做交出的新回答时判做完。
    { match: NEW_ANSWER, steps: [{ text: DONE_JSON }] },
    // 目标核对的输入带 lastReply；接着做的那一轮以 [GOAL CHECK] 开头，也带着原话，所以都排在原话前面。
    { match: `"lastReply"`, steps: [{ text: CONTINUE_JSON }] },
    { match: "[GOAL CHECK]", steps: [continueStep] },
    { match: TASK, steps: [{ tool: { name: "navigate", args: { url: `http://127.0.0.1:${siteAddress(site).port}/` } } }, { text: ANSWER }] },
  ]);
  const rp = await launchRealPath();

  try {
    const panel = await rp.attach(await rp.openSidePanel());
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
    await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false && !(${running})`), 60_000, "侧栏就绪");
    await rp.click(panel, "#input");
    await rp.typeText(panel, TASK);
    await rp.pressEnter(panel);
    await until(() => model.requests.some(r => r.rule === "[GOAL CHECK]") || undefined, 120_000, "接着做开始");

    if (name === "b") {
      await sleep(1_500);
      await rp.evaluate(panel, `(() => { const b = document.querySelector("#send-btn"); if (b?.classList.contains("stopping")) b.click(); return true; })()`);
    }
    await until(async () => !(await rp.evaluate(panel, running)) || undefined, 90_000, "这一轮结束");
    await sleep(2_000);
    const shown = await rp.evaluate(panel, answers) as string;
    await rp.screenshot(panel, join(out, `${name}-panel.png`));

    if (name === "a") {
      const errorCard = await rp.evaluate(panel, `document.querySelector(".error-card")?.textContent ?? ""`) as string;
      check("a 接着做报错后仍看得到原回答和报错", shown.includes(ANSWER) && !!errorCard, { answer: shown.includes(ANSWER), errorCard: errorCard.slice(0, 120) });
      await rp.cdp.send("Page.reload", {}, panel);
      await sleep(1_000);
      await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false`), 60_000, "重开侧栏就绪");
      await sleep(2_000);
      const replayed = await rp.evaluate(panel, answers) as string;
      await rp.screenshot(panel, join(out, "c-reopened.png"));
      check("c 重开侧栏后原回答还在", replayed.includes(ANSWER), { answer: replayed.includes(ANSWER) });
    } else if (name === "d") {
      check("d 接着做交出新回答时只显示新回答", shown.includes(NEW_ANSWER) && !shown.includes(ANSWER), { newAnswer: shown.includes(NEW_ANSWER), oldAnswer: shown.includes(ANSWER) });
    } else {
      const body = await rp.evaluate(panel, `document.querySelector("#messages")?.textContent ?? document.body.textContent`) as string;
      check("b 接着做被停止后仍看得到原回答和已中止", shown.includes(ANSWER) && body.includes("已中止"), { answer: shown.includes(ANSWER), stopped: body.includes("已中止") });
    }
  } catch (error) { check(`${name} 流程完成`, false, String(error).split("\n")[0]!); } finally {
    await rp.close(); await rp.remove(); await model.close();
  }
}

await runCase("a", { status: 400, body: FAILURE });
await runCase("b", { text: NEW_ANSWER, delayMs: 40_000 });
await runCase("d", { text: NEW_ANSWER });
site.close();
await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, dependency: "real isolated extension; scripted model and checker" }, null, 2));
console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
