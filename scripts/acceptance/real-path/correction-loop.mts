/**
 * 纠正闭环（docs/evals/20261016-correction-loop.md）：任务中途插话纠正 → 这一轮结束后「记下了：以后在这个网站……」并给撤销；
 * 新开对话再到这个网站做事，发给模型的内容带着这条做法；到别的网站不带；撤销后不再带。
 *   npx tsx scripts/acceptance/real-path/correction-loop.mts --headless
 * 脚本模型：学指代的旁路判断按纠正原话回写好的结论；页面是本机两个网站（127.0.0.1 与 localhost）。
 * 失败方式：中途纠正没被学到；只是补充要求也被学了；下次在这个网站没带上；别的网站也带上了；撤销后还带；网页上写的「不对」被学了。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-correction-loop`);
await mkdir(artifacts, { recursive: true });

const SHOP = `<!doctype html><meta charset="utf-8"><title>选择套餐</title><p class="notice">不对，应该先登录再选套餐。</p>
<div><h3>基础版</h3><button id="basic">加入购物车</button></div><div><h3>标准版</h3><button id="standard">加入购物车</button></div><div><h3>专业版</h3><button id="pro">加入购物车</button></div>`;
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(SHOP));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const port = siteAddress(site).port;
const SHOP_A = `http://127.0.0.1:${port}/`;
const SHOP_B = `http://localhost:${port}/`;

const RULE_1 = "以后在这个网站有几个同名按钮时，我按你说的卡片标题去找对应的按钮";
const RULE_2 = "以后在这个网站你说专业版，我先找专业版那张卡片";
const ASK = { first: "甲：把标准版加入购物车", steer: "不对，我要的是标准版那张卡上的按钮", add: "然后把结果也发给 Gemini", second: "乙：把专业版加入购物车", other: "丙：看看这一页", third: "丁：再加一次专业版", steer2: "不对，应该点专业版那张卡", fourth: "戊：最后看一眼" };
const slow = (name: string, args: Record<string, string>, delayMs = 4000) => ({ tool: { name, args }, delayMs });

const mainPayloads: string[] = [];
const sidePayloads: string[] = [];
const model = await startScriptedModel([
  // 学指代的旁路判断：按纠正原话回结论。
  { match: `"correction":"${ASK.steer}"`, steps: [{ text: JSON.stringify({ lesson: true, rule: RULE_1, evidence: "我要的是标准版那张卡上的按钮" }) }] },
  { match: `"correction":"${ASK.steer2}"`, steps: [{ text: JSON.stringify({ lesson: true, rule: RULE_2, evidence: "应该点专业版那张卡" }) }] },
  // 最后一句插话若是纠正，会先走现有的「要我记住吗」判断：它判成不可复用，再交给学指代的判断。
  { match: `"userMessage":"${ASK.steer2}"`, steps: [{ text: JSON.stringify({ correction: true, reusable: false, about: "site", rule: "", evidence: "不对", replaces: null, personalEvidence: "" }) }] },
  { match: `"correction":"${ASK.add}"`, steps: [{ text: JSON.stringify({ lesson: false, rule: "", evidence: "" }) }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  // 主任务。
  { match: ASK.steer, steps: [{ tool: { name: "click", args: { target: "loc=css:#standard" } } }, { text: "改好了，加的是标准版。" }] },
  { match: ASK.add, steps: [{ text: "好的，稍后发。" }] },
  { match: ASK.first, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, slow("snapshot", {}), slow("snapshot", {}), { text: "加好了。" }] },
  { match: ASK.second, steps: [{ text: "乙做完了。" }] },
  { match: ASK.other, steps: [{ text: "丙看过了。" }] },
  { match: ASK.steer2, steps: [{ text: "改成专业版了。" }] },
  { match: ASK.third, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, slow("snapshot", {}), { text: "丁做完了。" }] },
  { match: ASK.fourth, steps: [{ text: "戊看过了。" }] },
], undefined, (payload) => {
  const messages = JSON.stringify(payload.messages ?? []);
  if (payload.tools?.length) mainPayloads.push(messages);
  else if (messages.includes("correction")) sidePayloads.push(messages.slice(0, 1500));
});

const evidence: Record<string, unknown> = {};
let error: string | null = null;
const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: SHOP_A }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector('#send-btn')?.disabled===false") || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  const text = async () => String(await rp.evaluate(panel, "document.querySelector('#messages')?.innerText ?? ''"));
  const shows = (needle: string, label: string, ms = 60_000) => until(async () => (await text()).includes(needle) || undefined, ms, label);
  const send = async (say: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, say); await rp.pressEnter(panel); };
  const cards = () => rp.evaluate(panel, `[...document.querySelectorAll("[data-memory-ask]")].map((c) => ({ state: c.dataset.state, line: c.querySelector(".memory-ask-line")?.textContent ?? "", undo: !!c.querySelector("[data-memory-ask-undo]") }))`) as Promise<Array<{ state: string; line: string; undo: boolean }>>;
  const fresh = async () => { await rp.click(panel, "#conversation-new"); await until(async () => await rp.evaluate(panel, "!document.querySelector('#messages .msg.user') && document.querySelector('#send-btn')?.disabled===false") || undefined, 10_000, "新对话就绪"); };
  const lastMain = () => mainPayloads.at(-1) ?? "";

  // 甲：任务中途插话纠正，另插一句只是补充。
  await send(ASK.first);
  await until(async () => await rp.evaluate(panel, "!!document.querySelector('details.run-steps:not(.done)')") || undefined, 20_000, "甲：任务在跑");
  await sleep(800);
  await send(ASK.steer);
  await sleep(600);
  await send(ASK.add);
  const learned = await until(async () => (await cards()).find((c) => c.line.includes("记下了")), 60_000, "甲：出现「记下了」");
  evidence.learned = learned;
  await rp.screenshot(panel, join(artifacts, "learned.png"));
  assert.ok(learned.line.includes(RULE_1.replace(/。$/, "")) && learned.state === "remembered" && learned.undo, `R1 中途纠正学成这个网站的一条做法，带撤销：${JSON.stringify(learned)}`);
  await sleep(1500);
  const afterFirst = await cards();
  evidence.cardsAfterFirst = afterFirst;
  assert.equal(afterFirst.filter((c) => c.line.includes("记下了")).length, 1, `R1 补充要求不学、网页上写的「不对」不学：只有一条：${JSON.stringify(afterFirst)}`);

  // 乙：新对话，同一个网站：模型收到的内容带着这条做法。
  await fresh();
  await send(ASK.second);
  await shows("乙做完了。", "乙：回答");
  evidence.secondHas = lastMain().includes(RULE_1);
  assert.ok(evidence.secondHas, "R2 同一个网站，新对话里模型收到这条做法");

  // 丙：另一个网站（localhost）：不带。
  await rp.cdp.send("Page.navigate", { url: SHOP_B }, work);
  await until(async () => await rp.evaluate(work, "document.readyState==='complete'") || undefined, 10_000, "丙：另一个网站打开");
  await fresh();
  await send(ASK.other);
  await shows("丙看过了。", "丙：回答");
  evidence.otherHas = lastMain().includes(RULE_1);
  assert.equal(evidence.otherHas, false, "R2 别的网站不带这条做法");

  // 丁：回到第一个网站，再纠正一次，当场撤销；戊：新对话里不再带这一条，第一条仍在。
  await rp.cdp.send("Page.navigate", { url: SHOP_A }, work);
  await until(async () => await rp.evaluate(work, "document.readyState==='complete'") || undefined, 10_000, "丁：回到第一个网站");
  await fresh();
  await send(ASK.third);
  await until(async () => await rp.evaluate(panel, "!!document.querySelector('details.run-steps:not(.done)')") || undefined, 20_000, "丁：任务在跑");
  await sleep(800);
  await send(ASK.steer2);
  const second = await until(async () => (await cards()).find((c) => c.line.includes("专业版那张卡")), 60_000, "丁：出现第二条「记下了」");
  assert.ok(second.undo, "R3 第二条也带撤销");
  await rp.click(panel, "[data-memory-ask-undo]");
  await until(async () => (await cards()).some((c) => c.state === "undone") || undefined, 10_000, "丁：撤销完成");
  await rp.screenshot(panel, join(artifacts, "undone.png"));
  await fresh();
  await send(ASK.fourth);
  await shows("戊看过了。", "戊：回答");
  evidence.afterUndo = { rule2: lastMain().includes(RULE_2), rule1: lastMain().includes(RULE_1) };
  assert.deepEqual(evidence.afterUndo, { rule2: false, rule1: true }, "R3 撤销的那条不再带，另一条还在");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "diagnostics")).catch(() => null);

  if (diag) await writeFile(join(artifacts, "traces.jsonl"), diag.traces);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error, sidePayloads, requests: model.requests.map((r) => ({ rule: r.rule, step: r.step })) }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(error ? `FAIL ${error.split("\n")[0]}` : "PASS correction-loop");
console.log(`证据：${artifacts}`);
if (error) process.exitCode = 1;
