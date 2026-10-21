/**
 * 任务跑了两分多钟还没做完，核对仍判「接着做」：不再自动接着做，过程行写「还没做成」，由用户决定要不要继续。
 * 用户自己的记录里，跑了两分钟以后才接着做的那些次一次都没做成，每次多让用户等好几分钟。
 * 只装扩展、隔离构建、本机脚本模型（目标核对也由脚本回「接着做」）。约 2.5 分钟。
 *   npx tsx scripts/acceptance/real-path/goal-continue-budget.mts --headless
 *   a) 第一次回答之后没有自动接着做（不出现第二次回答）。
 *   b) 过程行写「还没做成」，用户能看到没做完。
 * 失败方式：只按次数上限判断，a 失败。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-goal-continue-budget`);

await mkdir(out, { recursive: true });

const TASK = "久跑核对：拿到这期视频的字幕";
const FIRST = "这期视频没有字幕轨。";
const SECOND = "接着又找了一遍，还是没有。";
const CONTINUE_JSON = JSON.stringify({ items: [{ text: "拿到字幕", done: false }], status: "continue", remaining: "字幕", correction: "还没交付字幕", finding: "没有字幕" });
// 每段停 5 秒、不超过断流计时：两分多钟里一直在出字，像一次很长的作答。
const slow = Array.from({ length: 26 }, () => ({ text: "…", delayMs: 5_000 }));

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>视频页</title><body><main><h1>一期访谈</h1></main></body></html>`));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const model = await startScriptedModel([
  // 目标核对的输入带 lastReply；接着做的那一轮以 [GOAL CHECK] 开头，也带着原话，所以都排在原话前面。
  { match: `"lastReply"`, steps: [{ text: CONTINUE_JSON }] },
  { match: "[GOAL CHECK]", steps: [{ text: SECOND }] },
  // 用过浏览器工具的一轮才核对；打开一页才有过程行，核对结论写在过程行上。
  { match: TASK, steps: [{ tool: { name: "navigate", args: { url: `http://127.0.0.1:${siteAddress(site).port}/` } } }, { text: "…".repeat(slow.length) + FIRST, pieces: [...slow, { text: FIRST }] }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  const answers = `[...document.querySelectorAll(".msg.assistant")].map(m => m.textContent).join("\\n")`;
  // 自动接着做时第一次回答被扣下不显示，侧栏只出第二次的。
  await until(async () => { const text = await rp.evaluate(panel, answers) as string; return text.includes(FIRST) || text.includes(SECOND) || undefined; }, 200_000, "回答");
  // 核对约 2 秒出结论；自动接着做的话第二次回答几秒内就到。
  await sleep(15_000);
  const text = await rp.evaluate(panel, answers) as string;
  const line = await rp.evaluate(panel, `[...document.querySelectorAll(".run-check")].map(e => e.textContent.replace("·", "").trim()).filter(Boolean).at(-1) ?? ""`) as string;
  await rp.screenshot(panel, join(out, "panel.png"));
  check("a 跑了两分多钟后不再自动接着做", !text.includes(SECOND) && !model.requests.some(r => r.rule === "[GOAL CHECK]"), { secondAnswer: text.includes(SECOND), continued: model.requests.filter(r => r.rule === "[GOAL CHECK]").length });
  check("b 过程行写「还没做成」", line === "还没做成", { line });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
