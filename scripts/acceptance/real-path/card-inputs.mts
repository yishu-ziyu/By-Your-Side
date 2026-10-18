/**
 * 卡片里可调的数（docs/evals/20261018-card-inputs.md R1–R3）。
 *   npx tsx scripts/acceptance/real-path/card-inputs.mts --headless
 * 脚本模型写一张订阅卡：月数（加减）、人数（加减 + 滑块）、引用它们的数字格 / 选项 / 表格 / 正文 {=total}，外加另一张只有清单的卡。
 * 点加号、打字超出范围、点滑块，看卡片和正文当场重算；勾一项后重开侧栏，看调过的数和勾选都还在、另一张卡不受影响。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-card-inputs`);

await mkdir(artifacts, { recursive: true });

const TASK = "订阅按月数算一共多少，几个人分";

const ANSWER = `一共花 {=total}。
<card title="订阅按月数算">
<input id="months" label="月数" value="12" min="1" max="20" unit="个月" />
<input id="people" label="人数" value="2" min="1" max="50" unit="人" />
<stat label="Notion" value="=68*months" unit="¥" note="月付" />
<stat label="Duolingo" value="398" unit="¥" />
<stat id="total" label="合计" value="=68*months+398" unit="¥" />
<stat label="每人" value="=(68*months+398)/people" unit="¥" />
<option name="Notion 年付" value="=48*months" unit="¥" why="折合每月 48" />
<table cols="订阅|费用"><tr cells="Notion|=68*months" /><tr cells="Duolingo|398" /></table>
<checklist><check text="取消 Calm" /><check text="Notion 改年付" /></checklist>
</card>
另外：
<card title="别的清单"><checklist><check text="另一张卡的项" /></checklist></card>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>订阅</title><h1>订阅</h1><p>Notion ¥68/月；Duolingo ¥398/年</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const model = await startScriptedModel([{ match: TASK, steps: [{ text: ANSWER, chunkDelayMs: 40 }] }]);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

type Seen = { months: string; people: string; slider: string | null; monthsSlider: boolean; stats: string[]; formula: string; option: string; cells: string[]; evidence: string[]; prose: string; checks: boolean[]; otherChecks: boolean[] };

/** 第一张卡和它所在回答的现状。 */
const SEEN = `(() => {
  const a = [...document.querySelectorAll("#messages .msg.assistant")].find(m => m.querySelector(".gen-card"));
  const [card, other] = a?.querySelectorAll(".gen-card") ?? [];
  const num = id => card?.querySelector('.gc-num[data-gc-var="' + id + '"]');
  return {
    months: num("months")?.value, people: num("people")?.value,
    slider: card?.querySelector('.gc-range[data-gc-var="people"]')?.value ?? null,
    monthsSlider: !!card?.querySelector('.gc-range[data-gc-var="months"]'),
    stats: [...card.querySelectorAll(".gc-stat .v")].map(v => v.textContent),
    formula: card.querySelectorAll(".gc-stat .n")[2]?.textContent ?? "",
    option: card.querySelector(".gc-option .price")?.textContent,
    cells: [...card.querySelectorAll(".gc-table td")].map(td => td.textContent),
    evidence: [...card.querySelectorAll(".gc-evidence td.r")].map(td => td.textContent),
    prose: [...a.children].filter(n => !n.classList.contains("gen-card") && !n.classList.contains("answer-actions")).map(n => n.textContent).join(" "),
    checks: [...card.querySelectorAll(".gc-check input")].map(i => i.checked),
    otherChecks: [...(other?.querySelectorAll(".gc-check input") ?? [])].map(i => i.checked),
  };
})()`;

const yuan = (n: number) => `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/subs` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector("#messages .msg.assistant .answer-actions") && !!document.querySelector("#messages .gen-card[data-gc-card] .gc-num") && !document.querySelector("#messages .msg.assistant.streaming")`) || undefined, 60_000, "回答写完");
  await sleep(500);
  const seen = async () => await rp.evaluate(panel, SEEN) as Seen;
  // 用户先把要点的东西滚到眼前再点。
  const tap = async (selector: string) => {
    await rp.evaluate(panel, `document.querySelector(${JSON.stringify("#messages " + selector)})?.scrollIntoView({ block: "center" }), true`);
    await sleep(100);
    await rp.click(panel, `#messages ${selector}`);
  };

  // R1：画出来了，初始值算对；月数档位少只有加减，人数档位多另有滑块。
  const first = await seen();
  evidence.first = first;
  await rp.screenshot(panel, join(artifacts, "1-drawn.png"));
  assert.equal(first.months, "12", "R1: months input drawn with its value");
  assert.equal(first.people, "2", "R1: people input drawn");
  assert.ok(!first.monthsSlider && first.slider === "2", `R1: slider only for the input with many steps: ${JSON.stringify(first)}`);
  assert.deepEqual(first.stats, ["¥816", "¥398", "¥1,214", "¥607"], "R1: initial values computed");

  // R2：点两下月数的加号 → 14 个月，所有引用它的地方都重算。
  const plus = '.gen-card .gc-input:nth-child(1) .gc-step[data-gc-step="1"]';
  await tap(plus);
  await tap(plus);
  await sleep(200);
  const after = await seen();
  evidence.after = after;
  await rp.screenshot(panel, join(artifacts, "2-months-14.png"));
  assert.equal(after.months, "14", "R1: plus twice gives 14");
  assert.deepEqual(after.stats, ["¥952", "¥398", "¥1,350", "¥675"], `R2: stats recomputed, 合计仍是 ${after.stats[2]}`);
  assert.ok(after.formula.includes("68 × 14 + 398"), `R2: formula follows the input: ${after.formula}`);
  assert.equal(after.option, "¥672", "R2: option value recomputed");
  assert.deepEqual(after.cells, ["Notion", "952", "Duolingo", "398"], "R2: table cell recomputed");
  assert.ok(after.evidence.includes("¥1,350"), `R2: evidence face recomputed: ${after.evidence}`);
  assert.ok(after.prose.includes("一共花 ¥1,350"), `R2: prose {=total} recomputed: ${after.prose}`);

  // R1：打字超出范围，失焦后夹回 20；在 20 上再点加号仍是 20；再打回 14。
  const months = '.gen-card .gc-num[data-gc-var="months"]';
  const typeInto = async (text: string) => {
    await tap(months);
    await rp.evaluate(panel, `document.querySelector(${JSON.stringify(months)}).select(), true`);
    await rp.typeText(panel, text);
    await tap(".gen-card .gc-title");
    await sleep(200);
  };
  await typeInto("99");
  assert.equal((await seen()).months, "20", "R1: typed 99 clamps to max 20");
  await tap(plus);
  await sleep(200);
  assert.equal((await seen()).months, "20", "R1: plus at max stays 20");
  await typeInto("14");
  assert.equal((await seen()).stats[2], "¥1,350", "R2: typed value recomputes");

  // R2：点滑块中间 → 数字框跟着变，每人按新人数算。
  await tap('.gen-card .gc-range[data-gc-var="people"]');
  await sleep(200);
  const slid = await seen();
  evidence.slid = slid;
  const people = Number(slid.people);
  assert.ok(people > 2 && slid.slider === slid.people, `R2: slider moves the number: ${JSON.stringify(slid)}`);
  assert.equal(slid.stats[3], yuan(Math.round(1350 / people * 100) / 100), "R2: per person follows the slider");

  // R3：勾第一项，重开侧栏，调过的数和勾选都还在；另一张卡不受影响。
  await tap(".gen-card .gc-check:first-child label");
  await sleep(500);
  assert.deepEqual((await seen()).checks, [true, false], "R3: ticked");
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector("#messages .gen-card .gc-num")`).catch(() => false) || undefined, 30_000, "重开后卡片回放");
  await sleep(1_000);
  const replay = await seen();
  evidence.replay = replay;
  await rp.screenshot(panel, join(artifacts, "3-reopened.png"));
  assert.equal(replay.months, "14", "R3: months kept after reopening");
  assert.equal(replay.people, String(people), "R3: people kept after reopening");
  assert.equal(replay.stats[2], "¥1,350", "R3: total recomputed after reopening");
  assert.ok(replay.prose.includes("一共花 ¥1,350"), `R3: prose recomputed after reopening: ${replay.prose}`);
  assert.deepEqual(replay.checks, [true, false], "R3: tick kept after reopening");
  assert.deepEqual(replay.otherChecks, [false], "R3: the other card is untouched");
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
