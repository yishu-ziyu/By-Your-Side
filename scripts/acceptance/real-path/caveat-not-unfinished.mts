/**
 * 回答里一句「另两个服务限流，未能交叉验证」只是多核对一遍没做到：任务做完了，过程行不写「还没做成」。
 * 回答说「订单还没能提交」才是没做成：过程行照旧写「还没做成」。
 * 只装扩展、隔离构建、本机脚本模型（目标核对也由脚本回「做完了」）。
 *   npx tsx scripts/acceptance/real-path/caveat-not-unfinished.mts --headless
 *   a) 回答带「未能交叉验证」，核对判做完：过程行是「已核对页面」，不是「还没做成」。
 *   b) 回答说「订单还没能提交」，核对仍判做完：过程行写「还没做成」。
 * 失败方式：claimsUnfinished 认任何「未能」，a 失败。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-caveat-not-unfinished`);

await mkdir(out, { recursive: true });

const CAVEAT = "核对措辞一：这个地址在哪";
const UNDONE = "核对措辞二：帮我提交订单";
const DONE_JSON = (text: string) => JSON.stringify({ items: [{ text, done: true }], status: "done", remaining: "" });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>查询</title><body><main><p>64.29.17.1</p></main></body></html>`));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
// 打开一页才有过程行，核对结论写在过程行上。
const OPEN = { tool: { name: "navigate", args: { url: `http://127.0.0.1:${siteAddress(site).port}/` } } };

const model = await startScriptedModel([
  // 目标核对的输入是带 lastReply 字段的 JSON，排在前面先匹配。
  { match: `"lastReply"`, steps: [{ text: DONE_JSON("任务") }] },
  { match: CAVEAT, steps: [OPEN, { text: "这个地址在美国加州，属于 Vercel 的服务器。来源 ip-api（另两个查询服务当时限流，未能交叉验证）。" }] },
  { match: UNDONE, steps: [OPEN, { text: "订单还没能提交：页面一直报错，我先停在这里。" }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const checkLine = `[...document.querySelectorAll(".run-check")].map(e => e.textContent.replace("·", "").trim()).filter(Boolean).at(-1) ?? ""`;
  const say = async (text: string, done: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(done)}))`) || undefined, 60_000, `回答：${done}`);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
    // 目标核对在这一轮结束后约 2 秒内出结论；等它落定再看卡。
    await sleep(5_000);
  };

  await say(CAVEAT, "未能交叉验证");
  const caveat = await rp.evaluate(panel, checkLine) as string;
  await rp.screenshot(panel, join(out, "a-caveat.png"));
  check("a 回答带「未能交叉验证」、核对判做完：过程行是「已核对页面」", caveat === "已核对页面", { checkLine: caveat });

  await rp.click(panel, "#conversation-new");
  await sleep(1_500);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");
  await say(UNDONE, "订单还没能提交");
  const undone = await rp.evaluate(panel, checkLine) as string;
  await rp.screenshot(panel, join(out, "b-undone.png"));
  check("b 回答说「还没能提交」：过程行照旧写「还没做成」", undone === "还没做成", { checkLine: undone });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
