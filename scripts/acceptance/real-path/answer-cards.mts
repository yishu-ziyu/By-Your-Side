/**
 * 回答里的卡片。
 *   npx tsx scripts/acceptance/real-path/answer-cards.mts --headless [--live] [--model=服务商/模型]
 * 脚本模型分段写出一张订阅卡：边写边看侧栏不露出标签原文；写完后看算式算出的数、正文 {total} 填数、
 * 心算的错金额换掉、不合格的组件不画；再点三个按钮：替我说一句、切到那一页、切到已关掉的页。
 * --live（R4）：主模型换成真实模型（默认 gpt-6-luna，本机 ChatGPT 登录；--model= 换别的），在练习页上问一道比价题（应画出带标记的卡片）
 * 和一道一句话题（不应画卡片）。只证明这一个模型在这两道题上的表现，不代表其他模型。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

if (process.argv.includes("--live")) await live();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-cards`);

await mkdir(artifacts, { recursive: true });

const TASK = "我的订阅一年一共花多少";

const FOLLOW = "只看月付的";

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>订阅</title><h1>订阅</h1><p>Notion ¥68/月；Duolingo ¥398/年；Calm 140 天没打开</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const card = (tabId: number) => `一年共花 {=total}；心算的 ¥2,714 不对，Calm 已经 140 天没打开，预算 ¥3000 以内；模板里的 {id} 不动。
<card title="订阅一年花多少" sub="按页面价格年化">
<stat label="Notion" value="=68*12" unit="¥" note="月付" />
<stat label="Duolingo" value="398" unit="¥" />
<stat id="total" label="一年合计" value="=68*12+398" unit="¥" tag="合计" />
<stat label="算不出来" value="=68*abc" />
<option name="缺理由的选项" />
<option name="Notion 年付" value="=68*12-100" unit="¥" why="比月付一年省 100" />
<table cols="订阅|一年"><tr cells="Notion|=68*12" /><tr cells="Duolingo|398" /><tr cells="Calm|=¥12*12" /></table>
<checklist><check text="取消 Calm" note="140 天没打开" /><check text="" /></checklist>
<marquee>不在目录里</marquee>
<button action="say" primary>${FOLLOW}</button>
<button action="tab" target="${tabId}">切到订阅页看</button>
<button action="tab" target="987654">切到已关掉的页</button>
</card>`;

const rules: Rule[] = [
  { match: TASK, steps: [{ text: "", chunkDelayMs: 120 }] },
  { match: FOLLOW, steps: [{ text: "好的，只看月付的。" }] },
];

const asked: string[] = [];

const model = await startScriptedModel(rules, undefined, (payload) => {
  // 主任务请求里所有用户角色的消息（产品会在用户原话后面附状态说明）。
  const users = (payload.messages ?? []).filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : (m.content ?? []).map(p => p.text ?? "").join(""));

  if (payload.tools?.length) asked.push(users.some(t => t.includes(FOLLOW)) ? FOLLOW : "（这次请求里没有按钮上的话）");
});

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/subs` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  // SAFETY: 表达式返回数字。
  const subsTab = await until(async () => await rp.evaluate(panel, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || "").endsWith("/subs"))?.id ?? 0)`) as number || undefined, 10_000, "订阅页的标签页编号");
  // SAFETY: rules 在请求到来时才读，这里填进真实的标签页编号。
  (rules[0]!.steps[0] as { text: string }).text = card(subsTab);

  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);

  // R1：写的过程中反复看，侧栏任何时候都不露出标签原文。
  const leaks: string[] = [];
  const end = Date.now() + 60_000;

  while (Date.now() < end) {
    // SAFETY: 表达式返回字符串。
    const text = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].map(m => m.innerText).join("\\n")`) as string;

    if (/<\/?(card|stat|option|button|marquee)|&lt;|\{=total\}/.test(text)) leaks.push(text.slice(0, 200));

    if (await rp.evaluate(panel, `!!document.querySelector("#messages .gen-card .gc-actions")`) && !(await rp.evaluate(panel, `!!document.querySelector("#messages .msg.assistant.streaming")`))) break;
    await sleep(60);
  }

  await sleep(800);
  await rp.screenshot(panel, join(artifacts, "card.png"));
  // SAFETY: 表达式返回下面这个形状的对象。
  const seen = await rp.evaluate(panel, `(() => {
    const a = [...document.querySelectorAll("#messages .msg.assistant")].find(m => m.querySelector(".gen-card"));
    const card = a?.querySelector(".gen-card");
    const prose = [...(a?.children ?? [])].filter(n => !n.classList.contains("gen-card") && !n.classList.contains("answer-actions")).map(n => n.innerText).join(" ");
    return {
      title: card?.querySelector(".gc-title")?.textContent,
      stats: [...(card?.querySelectorAll(".gc-stat") ?? [])].map(s => ({ label: s.querySelector(".k span")?.textContent, value: s.querySelector(".v")?.textContent, note: s.querySelector(".n")?.textContent, best: s.classList.contains("best") })),
      options: [...(card?.querySelectorAll(".gc-option") ?? [])].map(o => ({ name: o.querySelector(".name")?.textContent, price: o.querySelector(".price")?.textContent })),
      cells: [...(card?.querySelectorAll(".gc-table td") ?? [])].map(td => td.textContent),
      checks: [...(card?.querySelectorAll(".gc-check") ?? [])].map(c => ({ text: c.querySelector(".t")?.textContent, box: c.querySelector("input[type=checkbox]") ? "checkbox" : "none" })),
      buttons: [...(card?.querySelectorAll(".gc-btn") ?? [])].map(b => b.textContent),
      cardText: card?.innerText ?? "",
      prose,
    };
  })()`) as { title?: string; stats: Array<{ label: string; value: string; note: string; best: boolean }>; options: Array<{ name: string; price?: string }>; cells: string[]; checks: Array<{ text: string; box: string }>; buttons: string[]; cardText: string; prose: string };
  Object.assign(evidence, { leaks: leaks.length, seen });

  assert.equal(leaks.length, 0, `R1: tag text leaked while streaming: ${leaks[0]}`);
  assert.equal(seen.title, "订阅一年花多少", "R1: card drawn");
  assert.deepEqual(seen.stats.map(s => s.label), ["Notion", "Duolingo", "一年合计"], "R1: invalid stat dropped, valid ones kept in order");
  assert.deepEqual(seen.options.map(o => o.name), ["Notion 年付"], "R1: option without a reason is not drawn");
  assert.deepEqual(seen.checks, [{ text: "取消 Calm", box: "checkbox" }], `R1: checklist drawn with a tickable box, empty item dropped: ${JSON.stringify(seen.checks)}`);
  assert.ok(!seen.cardText.includes("不在目录里"), "R1: unknown tag not drawn");
  assert.equal(seen.stats[0]!.value, "¥816", "R2: formula computed");
  assert.equal(seen.stats[2]!.value, "¥1,214", "R2: total computed");
  assert.ok(seen.stats[2]!.note.includes("68 × 12 + 398"), `R2: formula shown: ${seen.stats[2]!.note}`);
  assert.ok(seen.stats[2]!.best, "R2: tagged stat marked");
  assert.ok(seen.prose.includes("一年共花 ¥1,214"), `R2: {total} filled: ${seen.prose}`);
  assert.ok(!seen.prose.includes("2,714") && seen.prose.includes("见下方卡片"), `R2: head-math amount replaced: ${seen.prose}`);
  assert.ok(seen.prose.includes("140 天"), "R2: non-currency page number kept");
  assert.ok(seen.prose.includes("预算 ¥3000 以内"), `R2: the user's budget is not replaced: ${seen.prose}`);
  assert.ok(seen.prose.includes("{id}"), `R2: ordinary braces in prose are untouched: ${seen.prose}`);
  assert.equal(seen.stats[1]!.value, "¥398", "R2: currency unit goes before a plain value");
  // 模型也会把算式写进选项的价和表格格子（10-14 真模型比价卡片露出「=1699-50」）：这些地方同样算出来。
  assert.equal(seen.options[0]!.price, "¥716", `R2: formula in an option value computed: ${JSON.stringify(seen.options)}`);
  assert.deepEqual(seen.cells, ["Notion", "816", "Duolingo", "398", "Calm", "¥144"], `R2: formula in a table cell computed: ${JSON.stringify(seen.cells)}`);
  assert.ok(!/=\s*\d/.test(seen.cardText), `R2: no raw formula shown anywhere in the card: ${seen.cardText}`);
  assert.deepEqual(seen.buttons, [FOLLOW, "切到订阅页看", "切到已关掉的页"], "R3: buttons drawn");

  // R3：切到已关掉的页 → 提示，不切页。
  await rp.evaluate(panel, `[...document.querySelectorAll(".gen-card .gc-btn")].find(b => b.textContent === "切到已关掉的页").click(), true`);
  const closedToast = await until(async () => await rp.evaluate(panel, `document.querySelector(".source-toast")?.textContent`) as string || undefined, 5_000, "已关页提示");
  assert.equal(closedToast, "那一页已经关掉了", "R3: closed tab tells the user");

  // R3：先让另一页在前台，再点「切到订阅页看」→ 订阅页回到前台。
  await rp.evaluate(panel, `chrome.tabs.create({ url: "about:blank", active: true }).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t && t.id !== ${subsTab})`) || undefined, 5_000, "另一页在前台");
  await rp.evaluate(panel, `[...document.querySelectorAll(".gen-card .gc-btn")].find(b => b.textContent === "切到订阅页看").click(), true`);
  await until(async () => await rp.evaluate(panel, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.id === ${subsTab})`) || undefined, 5_000, "R3: switched to the subscriptions tab");

  // R3：替我说一句 → 侧栏出现这句用户消息，模型收到它。
  await rp.evaluate(panel, `[...document.querySelectorAll(".gen-card .gc-btn")].find(b => b.textContent === ${JSON.stringify(FOLLOW)}).click(), true`);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes(${JSON.stringify(FOLLOW)}))`) || undefined, 10_000, "R3: user message shown");
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].some(m => m.textContent.includes("好的，只看月付的"))`) || undefined, 60_000, "R3: follow-up answered");
  evidence.asked = asked;
  assert.ok(asked.some(t => t.includes(FOLLOW)), `R3: model received the button text: ${JSON.stringify(asked)}`);
  await rp.screenshot(panel, join(artifacts, "after-say.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;

async function live(): Promise<never> {
  const dir = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-cards-live`);
  await mkdir(dir, { recursive: true });
  const shop = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>耳机比价</title><h1>AirPods Pro 2 三家报价</h1>
<ul><li>京东自营 ¥1699，免运费，次日达</li><li>天猫 Apple 官方旗舰店 ¥1699，店铺券满1500减50，包邮，2天到</li><li>拼多多百亿补贴 ¥1529，运费 ¥0，第三方店铺，3天到</li></ul>
<footer>© 2026 比价小站 由 Lumen Labs, Inc. 运营</footer>`));
  await new Promise<void>(resolve => shop.listen(0, "127.0.0.1", resolve));
  const modelArg = process.argv.find(a => a.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;
  const plan = await loadModelPlan(modelArg);
  const rp = await launchRealPath();
  const out: Record<string, unknown> = { model: modelArg };
  let failure: string | null = null;
  const ask = async (panel: string, text: string, n: number) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    // 第 n 个回答写完（不再流式、出现文末一排）。
    await until(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter(m => m.querySelector(".answer-actions")); return a.length >= ${n} && !document.querySelector("#messages .msg.assistant.streaming"); })()`) || undefined, 180_000, `第 ${n} 个回答`);
    await sleep(1_000);
    // SAFETY: 表达式返回下面这个形状的对象。
    return await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter(m => m.querySelector(".answer-actions")).at(-1); const c = a?.querySelector(".gen-card"); return { card: !!c, marked: !!c?.querySelector(".gc-stat.best, .gc-option.pick, tr.best"), buttons: [...(c?.querySelectorAll(".gc-btn") ?? [])].map(b => b.textContent), text: a?.innerText.slice(0, 400) }; })()`) as { card: boolean; marked: boolean; buttons: string[]; text: string };
  };

  try {
    const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
    const work = await rp.attach(blank.targetId);
    await rp.cdp.send("Page.enable", {}, work);
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(shop).port}/` }, work);
    const panel = await rp.attach(await rp.openSidePanel());
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
    out.compare = await ask(panel, "这三家哪家到手最便宜？算上运费", 1);
    await rp.screenshot(panel, join(dir, "compare.png"));
    out.fact = await ask(panel, "这个网站是哪家公司运营的？", 2);
    await rp.screenshot(panel, join(dir, "fact.png"));
    const compare = out.compare as { card: boolean; marked: boolean };
    const fact = out.fact as { card: boolean };
    assert.ok(compare.card && compare.marked, `R4: comparison drawn as a marked card ${JSON.stringify(out.compare)}`);
    assert.ok(!fact.card, `R4: one-sentence answer has no card ${JSON.stringify(out.fact)}`);
  } catch (caught) {
    failure = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    await writeFile(join(dir, "result.json"), JSON.stringify({ status: failure ? "FAIL" : "PASS", evidence: out, error: failure }, null, 2));
    await rp.close();
    await rp.remove();
    shop.close();
  }

  console.log(JSON.stringify({ status: failure ? "FAIL" : "PASS", artifacts: dir, evidence: out, error: failure?.split("\n")[0] ?? null }));
  process.exit(failure ? 1 : 0);
}
