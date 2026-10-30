/**
 * 拖短过的回答展开「来源」面板：面板顶部的「读过的网页」节标题不能被文末一排盖住。
 * 出把手的回答（≥3 行）那一排带贴底底色带；来源面板就开在它的正下方，底色带压住面板顶部时标题上半截被裁掉。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/answer-sources-grip.mts --headless
 * 判定：回答带拖把手；点「来源」后面板展开、节标题完整露出；
 *   几何不变量：文末一排的下沿不压面板（overlap ≤ 0），节标题没有被盖住的部分（h3Covered = 0）。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-sources-grip`);

await mkdir(out, { recursive: true });

const TASK = "这个比价页里三家到手价各是多少？顺带说说值不值得等双十一。";
const FIRST = "三家里拼多多百亿补贴到手最低，¥1529 含运费。";
const ANSWER = `${FIRST}天猫官方店用券后 ¥1649，京东自营 ¥1699，两家都包邮。

### 各家特点
- 拼多多百亿补贴：第三方店铺，3 天到，价格最低。
- 天猫 Apple 官方旗舰店：用券后 ¥1649，2 天到，售后走 Apple。
- 京东自营：¥1699，次日达，退换最省事。

### 细节
天猫的店铺券今晚 24 点过期；京东自营次日达，退换最省事。拼多多的「百亿补贴」是平台补贴，价格可能随时调整。只看价格现在就买拼多多，在意售后选京东自营。`;

const DONE_JSON = JSON.stringify({ items: [{ text: "三家到手价", done: true }], status: "done", remaining: "" });

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>耳机比价</title><body><main><h1>AirPods Pro 2 三家报价</h1><ul><li>京东自营 ¥1699，免运费，次日达</li><li>天猫 Apple 官方旗舰店 ¥1699，店铺券满1500减50，包邮，2天到</li><li>拼多多百亿补贴 ¥1529，运费 ¥0，第三方店铺，3天到</li></ul></main></body></html>`));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const PAGE = `http://127.0.0.1:${siteAddress(site).port}/`;

const model = await startScriptedModel([
  // 目标核对的输入带 lastReply 字段，排在前面先匹配。
  { match: `"lastReply"`, steps: [{ text: DONE_JSON }] },
  { match: TASK, steps: [
    { tool: { name: "navigate", args: { url: PAGE } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "send_user_message", args: { kind: "finding", content: ANSWER } } },
    { text: "" },
  ] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");

  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("拼多多百亿补贴到手最低"))`) || undefined, 60_000, "回答交付");
  await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  await sleep(5_000);

  const grip = await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll(".msg.assistant")].pop(); return !!(a?.querySelector(":scope > .answer-actions .shorten-grip")); })()`) ?? false;
  check("回答够长、挂了拖把手（本用例的前置条件）", grip === true, { grip });

  await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].pop()?.querySelector(":scope > .answer-actions .answer-sources-btn")?.click() ?? true`);
  await sleep(1_500); // 面板展开 + 平滑滚动落定

  const geo = await rp.evaluate(panel, `(() => {
    const answer = [...document.querySelectorAll(".msg.assistant")].pop();
    const actions = answer?.querySelector(":scope > .answer-actions");
    const panelEl = answer?.querySelector(":scope > .answer-panel");
    const h3 = panelEl?.querySelector("h3");
    if (!actions || !panelEl || !h3) return null;
    const ab = actions.getBoundingClientRect(), pb = panelEl.getBoundingClientRect(), hb = h3.getBoundingClientRect();
    return {
      panelOpen: !panelEl.hidden,
      title: h3.textContent,
      overlap: +(ab.bottom - pb.top).toFixed(1),
      h3Covered: +Math.max(0, ab.bottom - hb.top).toFixed(1),
    };
  })()`);

  await rp.screenshot(panel, join(out, "sources-panel.png"));
  check("来源面板展开，节标题是「读过的网页」", geo?.panelOpen === true && geo?.title === "读过的网页", geo);
  check("文末一排不压面板顶（overlap ≤ 0）", typeof geo?.overlap === "number" && geo.overlap <= 0.5, geo);
  check("节标题上半截不被盖住（h3Covered = 0）", geo?.h3Covered === 0, geo);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
