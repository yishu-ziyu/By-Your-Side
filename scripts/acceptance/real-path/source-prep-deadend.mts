/**
 * 「来源未就绪」死胡同：正文提取器取空但无障碍树有内容的页面（线上在 ChatGPT 会话页碰到），
 * 任务被推进 sourcePreparationOnly——send_user_message 被拦、正文被吞、继续原任务继承标志，
 * 每次必报「没有读到同一页面的完整正文，也未登记有效等待条件」。
 *   npx tsx scripts/acceptance/real-path/source-prep-deadend.mts --headless
 *
 * 隔离的无窗口 Chrome，只装扩展；模型是本机脚本模型。
 * 判据（只判用户看得见的）：
 * 1. 提取器空、无障碍树有内容的页面：提问出正常回答，不出现「没有读到同一页面的完整正文」。
 * 2. 两条通道都空的页面 + 判定要整篇：仍进入来源未就绪，但模型能发说明，说明送达、不补红错；
 *    模型什么都不说时仍报错。
 * 3. 来源未就绪报错后页面有了内容，点「继续原任务」：恢复的运行不被旧标志吞回答。
 * 产物：out/acceptance/real-path/<时间>-source-prep-deadend/result.json 与截图。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-source-prep-deadend${process.env.SIDEAGENT_BUILD_ROLE ? `-${process.env.SIDEAGENT_BUILD_ROLE}` : ""}`);

await mkdir(artifacts, { recursive: true });

/** 夹具 A：正文在 shadow root 里——DOM 遍历进不去（提取器空），无障碍树照样取到（ChatGPT 会话页同型：page_text 空、snapshot 有全文）。 */
const PAGE_A = `<title>跨境服务电商化</title><body><div id="h"></div><script>document.getElementById("h").attachShadow({mode:"open"}).innerHTML="<article><h1>跨境服务电商化</h1><p>${"跨境服务是把跨越国界的服务放到线上，像商品一样展示、比较和购买。".repeat(10)}</p></article>";</script></body>`;

/** 夹具 B：唯一内容 hidden——正文提取器和无障碍树都拿不到（树里只剩扩展自己的注入噪声）。 */
const PAGE_B = `<title></title><body><div hidden><article><p>对两条读取通道都不可见的正文。</p></article></div></body>`;

const ANSWER_A = "这页讲的是跨境服务电商化：把跨国界的服务像商品一样在线上展示和购买。";
const EXPLAIN_B = "这一页的正文我没能完整读到，分析还没开始。";
const RESUMED = "恢复后读到的答案：页面内容已经拿到了。";

const ASK_A = "这页讲的是什么，解释一下";
const ASK_B = "这一页说了什么";
const ASK_B2 = "再试一次读懂这页";
const ERROR_LINE = "没有读到同一页面的完整正文";

const rules: Rule[] = [
  // scope 判定的旁路请求体开头是 {"requests":[…]，主任务消息不含这串。
  { match: '{"requests":', steps: [{ text: JSON.stringify({ scope: "whole" }) }] },
  // 恢复运行的提示词里带 [… CONTINUATION]；放在任务规则前，先匹配。
  { match: "CONTINUATION]", steps: [{ tool: { name: "send_user_message", args: { kind: "finding", content: RESUMED } } }, { text: "" }] },
  { match: ASK_A, steps: [{ text: ANSWER_A }] },
  // 夹具 B 第一轮：在受限模式下用 send_user_message 发说明。
  { match: ASK_B, steps: [{ tool: { name: "send_user_message", args: { kind: "finding", content: EXPLAIN_B } } }, { text: "" }] },
  // 夹具 B 第二轮：模型一言不发，仍然要报出来源没就绪。
  { match: ASK_B2, steps: [{ text: "" }] },
];

const model = await startScriptedModel(rules);
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
const failures: string[] = [];
const ok = (pass: boolean, item: string) => { console.log(`${pass ? "PASS" : "FAIL"} ${item.slice(0, 400)}`); if (!pass) failures.push(item); };
let error: string | null = null;

const pageServer = createServer((req, res) => {
  const which = req.url === "/b" ? PAGE_B : PAGE_A;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(which);
});
await new Promise<void>(resolve => pageServer.listen(0, "127.0.0.1", resolve));
const address = pageServer.address();
if (!address || typeof address === "string") throw new Error("fixture address missing");
const urlA = `http://127.0.0.1:${address.port}/a`;
const urlB = `http://127.0.0.1:${address.port}/b`;

/** 该 target 的无障碍树里所有名字拼起来（验证夹具前提）。 */
const axNames = (nodes: Array<{ name?: { value?: string } }>) => (nodes ?? []).map(n => n.name?.value ?? "").join("\n");

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
    sideagent_self_use: { until: Date.now() + 600_000 },
    continuousDelegation: true,
  })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "侧栏就绪");

  const ask = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
  };
  const panelText = async () => String(await rp.evaluate(panel, "document.body.innerText") ?? "");

  // ── 夹具前提：A 的正文提取器取不到（querySelector 进不了 shadow）但在无障碍树里；B 对两条通道都空。
  await rp.cdp.send("Page.navigate", { url: urlA }, work);
  await until(async () => await rp.evaluate(work, `document.readyState === "complete" && !!document.getElementById("h")?.shadowRoot?.querySelector("article")`) || undefined, 15_000, "夹具 A 加载");
  const fixtureA = {
    domVisible: await rp.evaluate(work, `!!document.querySelector("article") || document.body.innerText.includes("跨境服务")`),
    ax: axNames(((await rp.cdp.send("Accessibility.getFullAXTree", {}, work)) as { nodes?: Array<{ name?: { value?: string } }> }).nodes ?? []),
  };
  ok(fixtureA.domVisible === false && fixtureA.ax.includes("跨境服务是把跨越国界的服务"), `前提 A：正文提取器取空、无障碍树有内容（domVisible=${fixtureA.domVisible}，ax ${fixtureA.ax.length} 字）`);

  await rp.cdp.send("Page.navigate", { url: urlB }, work);
  await until(async () => await rp.evaluate(work, `document.readyState === "complete"`) || undefined, 15_000, "夹具 B 加载");
  const fixtureB = axNames(((await rp.cdp.send("Accessibility.getFullAXTree", {}, work)) as { nodes?: Array<{ name?: { value?: string } }> }).nodes ?? []);
  ok(!fixtureB.includes("两条读取通道"), `前提 B：无障碍树也拿不到隐藏正文（ax ${fixtureB.length} 字）`);

  // ── 一、夹具 A：提取器空、树有内容的页面正常回答。
  await rp.cdp.send("Page.navigate", { url: urlA }, work);
  await until(async () => await rp.evaluate(work, `document.readyState === "complete" && !!document.getElementById("h")?.shadowRoot?.querySelector("article")`) || undefined, 15_000, "夹具 A 就绪");
  await ask(ASK_A);
  await until(async () => { const text = await panelText(); return text.includes(ANSWER_A) || text.includes(ERROR_LINE) || undefined; }, 60_000, "夹具 A 出现回答或错误");
  await sleep(500);
  const afterA = await panelText();
  evidence.stageA = { answer: afterA.includes(ANSWER_A), error: afterA.includes(ERROR_LINE) };
  ok(afterA.includes(ANSWER_A) && !afterA.includes(ERROR_LINE), `1 提取器空但树有内容：出回答不出红错（${JSON.stringify(evidence.stageA)}）`);
  await rp.screenshot(panel, join(artifacts, "1-ax-fallback.png"));

  // ── 二、夹具 B：真读不到时模型发的说明要送达，不再叠一条红错。
  await rp.cdp.send("Page.navigate", { url: urlB }, work);
  await until(async () => await rp.evaluate(work, `document.readyState === "complete"`) || undefined, 15_000, "夹具 B 就绪");
  await ask(ASK_B);
  await until(async () => { const text = await panelText(); return text.includes(EXPLAIN_B) || text.includes(ERROR_LINE) || undefined; }, 60_000, "夹具 B 出现说明或错误");
  await sleep(500);
  const afterB = await panelText();
  evidence.stageB = { explain: afterB.includes(EXPLAIN_B), error: afterB.includes(ERROR_LINE) };
  ok(afterB.includes(EXPLAIN_B) && !afterB.includes(ERROR_LINE), `2 受限模式的说明送达、不补「未登记等待条件」红错（${JSON.stringify(evidence.stageB)}）`);
  await rp.screenshot(panel, join(artifacts, "2-explain.png"));

  // ── 三、同页模型一言不发：仍报错、任务可恢复；注入正文后「继续原任务」不再被吞。
  await ask(ASK_B2);
  await until(async () => (await panelText()).includes(ERROR_LINE) || undefined, 60_000, "一言不发仍报出来源未就绪");
  evidence.stageC1 = { error: true };
  ok(true, "3 模型一言不发时报「没有读到同一页面的完整正文」");
  await rp.screenshot(panel, join(artifacts, "3a-error.png"));

  await rp.evaluate(work, `(() => { document.querySelector("[hidden]")?.removeAttribute("hidden"); const p = document.querySelector("article p"); if (p) p.textContent = "恢复后能看到这页正文：跨境服务电商化的解释。"; return true; })()`);
  await until(async () => await rp.evaluate(panel, `(() => { const r = document.querySelector("#resume-entry-root"); return !!r && !r.hidden && !!r.querySelector(".resume-action"); })()`) || undefined, 15_000, "侧栏出现「继续原任务」");
  await rp.click(panel, "#resume-entry-root .resume-action");
  await until(async () => (await panelText()).includes(RESUMED) || undefined, 60_000, "恢复的一轮出回答");
  await sleep(500);
  const afterResume = await panelText();
  evidence.stageC2 = { resumed: afterResume.includes(RESUMED), errorAgain: (afterResume.match(new RegExp(ERROR_LINE, "g")) ?? []).length > 1 };
  ok(afterResume.includes(RESUMED) && !(evidence.stageC2 as { errorAgain: boolean }).errorAgain, `3 「继续原任务」恢复后回答送达、不重复同一红错（${JSON.stringify(evidence.stageC2)}）`);
  await rp.screenshot(panel, join(artifacts, "3b-resumed.png"));

  assert.deepEqual(failures, [], failures.join("\n"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, failures, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>(resolve => pageServer.close(() => resolve()));
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
