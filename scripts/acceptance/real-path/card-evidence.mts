/**
 * 回答卡片的「结论 / 依据」换面。
 *   npx tsx scripts/acceptance/real-path/card-evidence.mts --headless [--record]
 *
 * 隔离的无窗口 Chrome，只装扩展；模型是本机脚本模型，按时间写出一张比价卡片（卡片收尾前停一下，收尾后正文还在写）。
 * 判据（只判用户看得见的）：
 * 1. 卡片写完前没有开关（三个数都已显示、卡片还没收尾时看）；写完后有。
 * 2. 切到依据：每个数一行，结果与卡片上的数一致，算式是卡片的原算式（¥1,649 ↔ 1699 − 50），出处列是卡片 source；
 *    卡片顶边不动，高度变化 ≤ 48px；卡片收尾后正文继续写时翻开的依据面不被翻回去。
 * 3. 切回结论：数字和原来一样，还是原来那几个节点。
 * 4. 没有算式也没有出处的卡片没有开关。
 * 5. 名字对得上「切到…看」按钮的那一行有「指给我看」，点了切到那一页；其他行没有。
 * --record：判定做完后再录一段（卡片写完 → 依据 → 结论），out/…/after.webm，只给人看，不参与判定。
 * 产物：out/acceptance/real-path/<时间>-card-evidence/result.json 与截图。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule, type TextStep } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-card-evidence`);

await mkdir(artifacts, { recursive: true });

const SOURCE = "三家商品页，10-14 看的";

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>拼多多</title><h1>拼多多百亿补贴</h1><p>¥1529</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

/** 卡片收尾前停 2.5 秒（判 1），收尾后正文再分几段写（判 2 的「不被翻回去」）。 */
const priced = (tabId: number): TextStep => {
  const pieces: NonNullable<TextStep["pieces"]> = [
    { text: `拼多多最便宜。\n<card title="耳机到手价" sub="含运费和券">\n<stat label="京东自营" value="=1699" unit="¥" note="次日达" />\n<stat label="天猫旗舰店" value="=1699-50" unit="¥" note="用券后" />\n<stat label="拼多多百亿补贴" value="=1529+0" unit="¥" note="3 天到" tag="最低" />\n<source>${SOURCE}</source>\n<button action="tab" target="${tabId}" primary>切到拼多多看</button>\n<button action="say">只看官方店</button>\n` },
    { text: "</card>\n", delayMs: 2500 },
    ...["但它是第三方店铺，", "售后要找店家，", "不能找平台直接退。"].map((text) => ({ text, delayMs: 900 })),
  ];

  return { text: pieces.map((p) => p.text).join(""), pieces };
};

const rules: Rule[] = [
  { match: "比一下到手价", steps: [{ text: "" }] },
  { match: "再录一遍", steps: [{ text: "" }] },
  { match: "差多少", steps: [{ text: "", pieces: [{ text: "差这么多。\n<card>\n<stat label=\"差价\" value=\"=1699-1529\" unit=\"¥\" />\n" }, { text: "</card>", delayMs: 2000 }] }] },
  { match: "要带什么", steps: [{ text: "带这几样。\n<card title=\"出门带的\">\n<stat label=\"水\" value=\"2\" unit=\"瓶\" />\n<stat label=\"零食\" value=\"3\" unit=\"包\" />\n</card>" }] },
];

const model = await startScriptedModel(rules);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

/** 最后一张卡片现在的样子。 */
const LOOK = `(() => {
  const card = [...document.querySelectorAll("#messages .gen-card")].at(-1);
  if (!card) return null;
  const r = card.getBoundingClientRect();
  const ev = card.querySelector(".gc-evidence");
  const visible = (el) => !!el && el.getClientRects().length > 0;
  return {
    title: card.querySelector(".gc-title")?.textContent,
    stats: [...card.querySelectorAll(".gc-stat:not(.gc-ph)")].map((s) => ({ label: s.querySelector(".k span")?.textContent, value: s.querySelector(".v")?.textContent })),
    statsVisible: visible(card.querySelector(".gc-body")),
    toggle: !!card.querySelector(".gc-faces"),
    pressed: [...card.querySelectorAll(".gc-face")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.title),
    evidenceVisible: visible(ev),
    // 出处格可能跨几行（整张卡共用一句）：每行的出处取覆盖它的那一格。
    rows: visible(ev) ? (() => { let src = null, left = 0; return [...ev.querySelectorAll("tbody tr")].map((tr) => { if (tr.cells[3]) { src = tr.cells[3]; left = src.rowSpan; } left -= 1; return { label: tr.cells[0].firstChild?.textContent, value: tr.cells[1].textContent, formula: tr.cells[2].textContent, source: left >= 0 ? src?.textContent ?? "" : "", point: !!tr.querySelector(".gc-point") }; }); })() : [],
    actions: !!card.querySelector(".gc-actions"),
    top: r.top, height: r.height,
    streaming: !!document.querySelector("#messages .msg.assistant.streaming"),
  };
})()`;

type Look = { title?: string; stats: Array<{ label: string; value: string }>; statsVisible: boolean; toggle: boolean; pressed: string[]; evidenceVisible: boolean; rows: Array<{ label: string; value: string; formula: string; source: string; point: boolean }>; actions: boolean; top: number; height: number; streaming: boolean };

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/pdd` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  // SAFETY: 表达式返回数字。
  const pddTab = await until(async () => await rp.evaluate(panel, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url || "").endsWith("/pdd"))?.id ?? 0)`) as number || undefined, 10_000, "拼多多页的标签页编号");
  // SAFETY: rules 在请求到来时才读，这里填进真实的标签页编号。
  rules[0]!.steps[0] = priced(pddTab);
  rules[1]!.steps[0] = priced(pddTab);
  // SAFETY: LOOK 返回 Look 或 null。
  const look = async () => await rp.evaluate(panel, LOOK) as Look | null;
  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  /** 点最后一张卡片里的按钮：真实鼠标事件，和用户点一样。 */
  const tap = async (selector: string) => {
    // SAFETY: 表达式返回坐标或 null。
    const at = await rp.evaluate(panel, `(() => { const el = [...document.querySelectorAll("#messages .gen-card")].at(-1)?.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number } | null;

    if (!at) throw new Error(`找不到 ${selector}`);

    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, panel);
  };
  const cardCount = async () => await rp.evaluate(panel, `document.querySelectorAll("#messages .gen-card").length`) as number;

  // 1：三个数都出来、卡片还没收尾时看几次：没有开关。
  await ask("比一下到手价");
  await until(async () => { const l = await look(); return l && l.stats.filter((x) => x.value).length === 3 ? l : undefined; }, 60_000, "三个数都显示");
  const early: Look[] = [];

  for (let i = 0; i < 3; i++) { early.push((await look())!); await sleep(200); }
  evidence.early = early.map((l) => ({ toggle: l.toggle, actions: l.actions }));
  assert.ok(early.every((l) => !l.actions), `1 前提：看的时候卡片还没收尾 ${JSON.stringify(evidence.early)}`);
  assert.ok(early.every((l) => !l.toggle), `1 卡片写完前没有开关 ${JSON.stringify(evidence.early)}`);
  await rp.screenshot(panel, join(artifacts, "1-before-close.png"));

  // 1：收尾后有开关；正文还在写时就点「依据」。
  const shown = await until(async () => { const l = await look(); return l?.toggle ? l : undefined; }, 10_000, "1 写完后出现开关");
  assert.ok(shown.streaming, "2 前提：点依据时正文还在写");
  assert.deepEqual(shown.pressed, ["结论"], "1 默认是结论");
  await rp.evaluate(panel, `(() => { const c = [...document.querySelectorAll("#messages .gen-card")].at(-1); c.querySelectorAll(".gc-stat").forEach((s, i) => { s.__mark = i; }); return true; })()`);
  await tap('.gc-face[data-face="evidence"]');
  await sleep(400);
  const flipped = (await look())!;
  await until(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".gen-card")).at(-1); return !!a.querySelector(".answer-actions") && !a.dataset.revealing; })()`) || undefined, 30_000, "正文写完");
  await sleep(600);
  const after = (await look())!;
  evidence.flipped = flipped;
  evidence.afterStream = after;
  await rp.screenshot(panel, join(artifacts, "2-evidence.png"));

  // 2：每个数一行，结果与卡片一致，算式是原算式，出处是 source。
  assert.equal(after.evidenceVisible && !after.statsVisible, true, `2 正文写完后依据面还开着 ${JSON.stringify(after)}`);
  assert.deepEqual(after.pressed, ["依据"], "2 依据按钮按下");
  assert.deepEqual(after.rows.map((r) => [r.label, r.value]), shown.stats.map((s) => [s.label, s.value]), `2 每个数一行、结果和卡片一致 ${JSON.stringify(after.rows)}`);
  assert.deepEqual(after.rows.map((r) => [r.value, r.formula]), [["¥1,699", "—"], ["¥1,649", "1699 − 50"], ["¥1,529", "1529 + 0"]], `2 算式是卡片的原算式 ${JSON.stringify(after.rows)}`);
  assert.ok(after.rows.every((r) => r.source === SOURCE), `2 出处列是卡片 source ${JSON.stringify(after.rows)}`);
  assert.ok(Math.abs(flipped.top - shown.top) <= 1 && Math.abs(flipped.height - shown.height) <= 48, `2 换面不跳：顶边 ${shown.top}→${flipped.top}，高度 ${shown.height}→${flipped.height}`);

  // 3：切回结论。
  await tap('.gc-face[data-face="answer"]');
  await sleep(400);
  const back = (await look())!;
  // SAFETY: 表达式返回布尔。
  const sameNodes = await rp.evaluate(panel, `[...[...document.querySelectorAll("#messages .gen-card")].at(-1).querySelectorAll(".gc-stat")].every((s, i) => s.__mark === i)`) as boolean;
  evidence.back = back;
  await rp.screenshot(panel, join(artifacts, "3-answer.png"));
  assert.ok(back.statsVisible && !back.evidenceVisible, `3 切回结论 ${JSON.stringify(back)}`);
  assert.deepEqual(back.stats, shown.stats, "3 数字不变");
  assert.ok(sameNodes, "3 还是原来的数字格节点");
  assert.ok(Math.abs(back.height - shown.height) <= 1, `3 高度恢复 ${shown.height}→${back.height}`);

  // 5：只有名字对得上「切到拼多多看」的那一行有「指给我看」；点了切到那一页。
  assert.deepEqual(after.rows.map((r) => r.point), [false, false, true], `5 只有拼多多那一行有「指给我看」 ${JSON.stringify(after.rows)}`);
  await tap('.gc-face[data-face="evidence"]');
  await rp.evaluate(panel, `chrome.tabs.create({ url: "about:blank", active: true }).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t && t.id !== ${pddTab})`) || undefined, 5_000, "另一页在前台");
  await tap(".gc-point");
  await until(async () => await rp.evaluate(panel, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.id === ${pddTab})`) || undefined, 5_000, "5 点「指给我看」切到拼多多那一页");
  await tap('.gc-face[data-face="answer"]');

  // 深色下的依据面截图，给人看可读性，不参与判定。
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
  await tap('.gc-face[data-face="evidence"]');
  await sleep(400);
  await rp.screenshot(panel, join(artifacts, "2-evidence-dark.png"));
  await tap('.gc-face[data-face="answer"]');
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, panel);

  // 4：没有算式也没有出处的卡片：没有开关。
  await ask("要带什么");
  await until(async () => (await cardCount()) === 2 && await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".gen-card")).at(-1); return !!a.querySelector(".answer-actions") && !a.dataset.revealing; })()`) || undefined, 60_000, "第二张卡片写完");
  await sleep(600);
  const plainCard = (await look())!;
  evidence.plain = plainCard;
  await rp.screenshot(panel, join(artifacts, "4-plain.png"));
  assert.ok(plainCard.title === "出门带的" && plainCard.stats.length === 2, `4 前提：第二张卡片写完 ${JSON.stringify(plainCard)}`);
  assert.equal(plainCard.toggle, false, "4 没有算式也没有出处：没有开关");

  // 没有标题的卡片收尾时上面多出一行放开关：已显示的数字格还是原来那个节点，不重新淡入。
  await ask("差多少");
  await until(async () => (await cardCount()) === 3 && (await look())!.stats.length === 1 || undefined, 60_000, "无标题卡片的数显示");
  await rp.evaluate(panel, `([...document.querySelectorAll("#messages .gen-card")].at(-1).querySelector(".gc-stat").__mark = "t", true)`);
  const untitled = await until(async () => { const l = await look(); return l?.toggle ? l : undefined; }, 10_000, "无标题卡片出现开关");
  // SAFETY: 表达式返回布尔。
  const kept = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .gen-card")].at(-1).querySelector(".gc-stat").__mark === "t"`) as boolean;
  evidence.untitled = { ...untitled, kept };
  assert.ok(kept, "无标题卡片收尾时数字格没被重建");

  if (process.argv.includes("--record")) {
    await rp.evaluate(panel, `document.querySelector("#messages").scrollTop = 1e9, true`);
    const stop = await recordScreen(rp.cdp, panel, join(artifacts, "after.webm"));
    await ask("再录一遍");
    await until(async () => (await cardCount()) === 4 && (await look())!.toggle || undefined, 60_000, "录像：卡片写完");
    await sleep(1500);
    await tap('.gc-face[data-face="evidence"]');
    await sleep(3500);
    await tap('.gc-face[data-face="answer"]');
    await sleep(2000);
    evidence.recording = await stop();
  }
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
