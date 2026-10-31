/**
 * 自动续做阶段超过两分钟：不再开启下一次续做，由用户决定是否继续。
 * 只装扩展、隔离构建、本机脚本模型（目标核对也由脚本回「接着做」）。约 2.5 分钟。
 *   npx tsx scripts/acceptance/real-path/goal-continue-budget.mts --headless
 *   a) 允许第一次续做；续做超过两分钟后不再发第三次请求。
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

const TASK = "久跑核对：读取页面上两项资料并完整列出";
const FIRST = "只整理了第一项青松，第二项还没有整理。";
const SECOND = "第二项白鹭还没有整理。";
const THIRD = "不应该自动开始第三次。";
const CONTINUE_JSON = JSON.stringify({ items: [{ text: "列出两项资料", done: false }], status: "continue", verificationSubject: 'answer', evidence: FIRST, remaining: "第二项资料", correction: "读完并列出第二项资料", finding: "第二项尚未整理" });
// 每段停 5 秒、不超过断流计时：两分多钟里一直在出字，像一次很长的作答。
const slow = Array.from({ length: 26 }, () => ({ text: "…", delayMs: 5_000 }));

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>两项资料</title><body><main><h1>资料</h1><p>第一项青松，第二项白鹭。</p><input id="progress" aria-label="整理进度"></main></body></html>`));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const continueStep = { text: "…".repeat(slow.length) + SECOND, pieces: [...slow, { text: SECOND }] };
const checkStep = { text: CONTINUE_JSON };
const model = await startScriptedModel([
  // 目标核对的输入带 lastReply；接着做的那一轮以 [GOAL CHECK] 开头，也带着原话，所以都排在原话前面。
  { match: `"lastReply"`, steps: [checkStep] },
  { match: "[GOAL CHECK]", steps: [{ tool: { name: 'fill', args: { target: '#progress', value: '第一轮续做进展', label: '整理进度' } } }, continueStep] },
  // 用过浏览器工具的一轮才核对；打开一页才有过程行，核对结论写在过程行上。
  { match: TASK, steps: [{ tool: { name: "navigate", args: { url: `http://127.0.0.1:${siteAddress(site).port}/` } } }, { text: FIRST }] },
], undefined, payload => {
  for (const message of payload.messages ?? []) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const input = JSON.parse(message.content);
      if (typeof input.lastReply === 'string') checkStep.text = JSON.stringify({ ...JSON.parse(CONTINUE_JSON), evidence: input.lastReply.slice(-100) });
    } catch { /* 普通用户指令不是核对输入。 */ }
  }
});

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
  const traces = await rp.evaluate(panel, `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`) as Array<{type:string;data:{overBudget?:boolean}}>;
  check("a 第一次续做已执行，超过预算后不再开始下一次", !text.includes(THIRD) && model.requests.filter(r => r.rule === "[GOAL CHECK]").length === 2 && traces.some(t=>t.type==='goal_check'&&t.data.overBudget), { thirdAnswer: text.includes(THIRD), continued: model.requests.filter(r => r.rule === "[GOAL CHECK]").length, overBudget:traces.some(t=>t.type==='goal_check'&&t.data.overBudget) });
  check("b 过程行写「还没做成」", line === "还没做成", { line });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
