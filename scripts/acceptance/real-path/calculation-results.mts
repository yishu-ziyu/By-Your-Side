import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-calculation-results`);
await mkdir(out, { recursive: true });
const task = "房贷的本金、利率和年限都让我能调，月供和总利息一起看。";
const answer = `每月还 {=monthly}，总利息 {=interest}。
<card title="等额本息">
<input id="amount" label="贷款本金" value="1000000" min="10000" max="5000000" step="1000" unit="元" />
<input id="rate" label="年利率" value="3.2" min="0" max="20" step="0.1" unit="%" />
<input id="years" label="年限" value="30" min="1" max="40" step="1" unit="年" />
<stat id="monthly" label="月供" value="=rate==0?amount/(years*12):amount*(rate/1200)*(1+rate/1200)^(years*12)/((1+rate/1200)^(years*12)-1)" unit="¥" />
<stat id="total" label="还款总额" value="=monthly*years*12" unit="¥" />
<stat id="interest" label="总利息" value="=total-amount" unit="¥" />
</card>`;
const brokenTask = "再帮我算一下这笔房贷，利率与年限保持不变。";
const unboundTask = "再核对这笔房贷的月供，计算器和结论要一起更新。";
const unbound = answer.replace("每月还 {=monthly}，总利息 {=interest}。", "每月还 ¥4,323.54。");
const broken = answer.replace(/value="=rate==0[^\"]+"/, 'value="=Payment(amount,rate/12,years*12)"').replace("每月还 {=monthly}，总利息 {=interest}。", "每月还 ¥4,323.54。");
const model = await startScriptedModel([
  { match: "[GOAL CHECK]", steps: [{ text: answer }] },
  { match: brokenTask, steps: [{ text: broken }] },
  { match: unboundTask, steps: [{ text: unbound }] },
  { match: task, steps: [{ text: answer, chunkDelayMs: 10 }] },
]);
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;
type Seen = { values: string[]; prose: string; inputs: Array<{ id: string; value: string }> };
const expression = `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].findLast(el => el.querySelector(".gc-num")); return a ? {values:[...a.querySelectorAll(".gc-stat .v")].map(el=>el.textContent),prose:[...a.children].filter(el=>!el.matches(".gen-card,.answer-actions,.answer-panel")).map(el=>el.textContent).join(" "),inputs:[...a.querySelectorAll(".gc-num")].map(el=>({id:el.dataset.gcVar,value:el.value}))} : null; })()`;
const reference = (principal: number, rate: number, years: number) => {
  const monthlyRate = rate / 1200, months = years * 12;
  let presentValue = 0;
  for (let month = 1; month <= months; month++) presentValue += (1 + monthlyRate) ** -month;
  const monthly = principal / presentValue;
  return [monthly, monthly * months, monthly * months - principal];
};
const check = (value: Seen, principal: number, rate: number, years: number) => {
  assert.equal(value.values.length, 3, "三项结果都可见，派生结果不能丢失");
  const expected = reference(principal, rate, years);
  value.values.forEach((actual, i) => assert.ok(Math.abs(Number(actual.replace(/[^\d.-]/g, "")) - expected[i]!) < .011, `计算与独立现值校验不符：${actual} / ${expected[i]}`));
  assert.ok(value.prose.includes(value.values[0]!) && value.prose.includes(value.values[2]!), `正文与计算器结果一致：${value.prose}`);
};
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const ready = (session: string) => until(async () => await rp.evaluate(session, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  const seen = async (session = panel) => await rp.evaluate(session, expression) as Seen;
  await ready(panel);
  await rp.click(panel, "#input"); await rp.typeText(panel, task); await rp.pressEnter(panel);
  await until(async () => (await seen())?.inputs.length === 3, 30000, "三个输入显示");
  await until(async () => (await seen())?.values.length === 3, 30000, "计算结果显示");
  await sleep(500);
  const initial = await seen(); check(initial, 1000000, 3.2, 30); evidence.initial = initial;
  await rp.screenshot(panel, join(out, "initial.png"));
  const firstTarget = (await rp.targets()).find(t => t.url.includes("/sidepanel.html"))!.targetId;
  const secondWindow = Number(await rp.evaluate(panel, 'chrome.windows.create({url:"about:blank",focused:false}).then(w=>w.id)'));
  await rp.evaluate(panel, `chrome.sidePanel.open({windowId:${secondWindow}}).then(()=>true)`, { userGesture: true });
  const second = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.includes("/sidepanel.html") && t.targetId !== firstTarget), 15000, "第二个侧栏")).targetId);
  await ready(second);
  await until(async () => (await seen(second))?.values.length === 3, 15000, "第二窗口重放回答");
  const change = async (id: string, value: string) => {
    const selector = `.gc-num[data-gc-var="${id}"]`;
    await rp.evaluate(panel, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"});true`);
    await rp.click(panel, selector); await rp.evaluate(panel, `document.querySelector(${JSON.stringify(selector)}).select();true`);
    await rp.typeText(panel, value); await rp.click(panel, ".gc-title");
  };
  await change("rate", "4");
  await until(async () => (await seen()).inputs.find(x => x.id === "rate")?.value === "4", 5000, "修改利率");
  const changed = await seen(); check(changed, 1000000, 4, 30); evidence.changed = changed;
  await until(async () => (await seen(second))?.inputs.find(x => x.id === "rate")?.value === "4", 5000, "两个窗口使用同一输入");
  check(await seen(second), 1000000, 4, 30);
  await change("rate", "0");
  const zero = await seen(); check(zero, 1000000, 0, 30); evidence.zero = zero;
  await change("years", "20"); await change("amount", "500000");
  const adjusted = await seen(); check(adjusted, 500000, 0, 20); evidence.adjusted = adjusted;
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] }, panel);
  await rp.screenshot(panel, join(out, "adjusted-dark.png"));
  await rp.cdp.send("Page.reload", {}, panel); await ready(panel);
  await until(async () => (await seen())?.inputs.find(x => x.id === "amount")?.value === "500000", 15000, "重开后保留输入");
  const reopened = await seen(); check(reopened, 500000, 0, 20); evidence.reopened = reopened;
  await rp.screenshot(panel, join(out, "reopened.png"));
  await rp.click(panel, "#conversation-new"); await ready(panel);
  await rp.click(panel, "#input"); await rp.typeText(panel, brokenTask); await rp.pressEnter(panel);
  await until(async () => {
    const value = await seen();
    return value?.values.length === 3 && value.values.every(text => text !== "—") && value.prose.includes("4,324.67");
  }, 60000, "错误公式被原任务修复");
  const repaired = await seen(); check(repaired, 1000000, 3.2, 30); evidence.repaired = repaired;
  const repairs = model.requests.filter(request => request.rule === "[GOAL CHECK]").length;
  evidence.repairs = repairs;
  assert.equal(repairs, 1, "有具体公式错误时只修一次，修好不再要求重做");
  await rp.screenshot(panel, join(out, "repaired.png"));
  await rp.click(panel, "#conversation-new"); await ready(panel);
  await rp.click(panel, "#input"); await rp.typeText(panel, unboundTask); await rp.pressEnter(panel);
  await until(async () => (await seen())?.prose.includes("4,324.67"), 60000, "独立手算的结论改成绑定结果");
  const bound = await seen(); check(bound, 1000000, 3.2, 30); evidence.bound = bound;
  assert.equal(model.requests.filter(request => request.rule === "[GOAL CHECK]").length, 2, "不支持公式和未绑定数字分别只修一次");
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error }));
if (error) process.exitCode = 1;
