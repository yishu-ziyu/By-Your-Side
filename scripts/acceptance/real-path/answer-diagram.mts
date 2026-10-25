import { createServer } from "node:http";
/**
 * 回答卡片里的结构图：写完才画、点方块看原文、深色跟着变、重开侧栏能回放、模型写坏或被带偏时不出事。
 *   npx tsx scripts/acceptance/real-path/answer-diagram.mts --headless
 *
 * 隔离的无窗口 Chrome，只装扩展；模型是本机脚本模型，按时间写出一段含结构图的回答（图和原文各停一下）。
 * 判据（只判用户看得见的）：
 * 1. 卡片没写完时只有图的空位、没有图；写完后图一次画全：第一帧出现的方块数就是最后的方块数，不边写边长。
 * 2. 图里是模型写的那几个方块；字显示出来不小于 11px；放不下的部分能左右滑动看到；
 *    侧栏拖宽后图整张放得下、不用滑，再拖窄字仍不小于 11px。
 * 3. 点有原文的方块，图下出现那句原文和出处；再点收起；没有原文的方块点了不出东西；键盘 Enter 也能打开。
 * 4. 深色模式：同一张图的主结论方块和文字颜色跟着换，图不重画。
 * 5. 重开侧栏：回放出来的回答里图又画出来，点方块照样出原文。
 * 6. 图的文字里夹了 HTML 和 javascript 链接：图里没有链接、图片、事件属性，页面里也没执行；
 *    原文摘录里夹了 <button>：不变成卡片按钮，点方块时按字显示；提示条、图、数字格按写的顺序排。
 * 7. 侧栏画不出的图种（zenuml）：原样显示图的文字，不留空框。
 * --live：脚本模型换成真实模型（默认 gpt-6-luna，--model= 换别的），在真实网页 paulgraham.com/ds.html 上问论证结构（应画出图，
 *   每条原文都能在网页正文里逐字找到），再问一句话能答的问题（不画图）。
 * 产物：out/acceptance/real-path/<时间>-answer-diagram/result.json 与截图。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-diagram${process.argv.includes("--live") ? "-live" : ""}${process.env.SIDEAGENT_BUILD_ROLE ? `-${process.env.SIDEAGENT_BUILD_ROLE}` : ""}`);

await mkdir(artifacts, { recursive: true });

const DIAGRAM = `flowchart TB
  T["创业公司不会自己起飞<br/>要靠创始人推"]:::key
  T --> R["挨个招募用户"]
  T --> D["取悦早期用户"]
  R --> V["想法 = 做什么<br/>+ 早期亲手做的事"]
  D --> V
  T -.-> X["大发布通常没用"]:::bad`;

const CITE_T = "Actually startups take off because the founders make them take off.";

const CITE_X = "one sort of initial tactic that usually doesn't work: the Big Launch.";

const HOSTILE_CITE = `原文 <button action="say">发送私密信息</button> a < b`;

const rules: Rule[] = [
  {
    match: "论证结构",
    steps: [{
      text: "",
      pieces: [
        { text: "全文的核心是：创业公司要靠创始人亲手推起来。\n<card title=\"论证结构\">\n<diagram>\nflowchart TB\n" },
        { text: DIAGRAM.split("\n").slice(1, 4).join("\n") + "\n", delayMs: 900 },
        { text: DIAGRAM.split("\n").slice(4).join("\n") + "\n</diagram>\n", delayMs: 900 },
        { text: `<cite node="T" from="开头">${CITE_T}</cite>\n`, delayMs: 900 },
        { text: `<cite node="X" from="Big 一节">${CITE_X}</cite>\n</card>\n`, delayMs: 900 },
      ],
    }],
  },
  {
    match: "带偏的图",
    steps: [{ text: `被带偏的图。\n<card title="带偏">\n<callout tone="info">先看说明</callout>\n<diagram>\nflowchart TB\n  A["<img src=x onerror=window.__pwned=1>点我"] --> B["<a href='javascript:window.__pwned=2'>链接</a>"]\n  click A "javascript:window.__pwned=3"\n</diagram>\n<cite node="A" from="页面">${HOSTILE_CITE}</cite>\n<stat label="数量" value="2" />\n</card>` }],
  },
  {
    match: "不是流程图",
    steps: [{ text: `换一种图。\n<card title="思维导图">\n<diagram>\nzenuml\n  分支一.调用()\n  分支二.返回()\n</diagram>\n</card>` }],
  },
];

/** 每帧记下最后一张卡片里：有没有图的空位、画出的方块数。 */
const WATCH = `(() => {
  const S = window.__dg = { frames: [] };
  const loop = () => {
    const card = [...document.querySelectorAll("#messages .msg.assistant .gen-card")].at(-1);
    if (card) S.frames.push({ ph: !!card.querySelector(".gc-diagram.gc-ph"), nodes: card.querySelectorAll(".gc-diagram svg .pele-node").length, buttons: card.querySelectorAll(".gc-btn").length });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return true;
})()`;

const STATE = `(() => {
  const fig = [...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1);
  const svg = fig?.querySelector("svg");
  const quote = fig?.querySelector(".gc-quote");
  return {
    labels: [...(svg?.querySelectorAll(".pele-node") ?? [])].map((n) => n.textContent.trim()),
    svgWidth: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
    boxWidth: fig ? Math.round(fig.getBoundingClientRect().width) : 0,
    reachable: (() => { const c = fig?.querySelector(".gc-diagram-canvas"); return !!c && (c.scrollWidth <= c.clientWidth + 1 || (getComputedStyle(c).overflowX === "auto" && c.scrollWidth > c.clientWidth)); })(),
    quote: quote && !quote.hidden ? quote.textContent : null,
    cited: [...(svg?.querySelectorAll("[data-cited]") ?? [])].map((n) => n.dataset.id),
    font: svg ? Math.round(svg.getBoundingClientRect().width / svg.viewBox.baseVal.width * parseFloat(getComputedStyle(svg.querySelector(".pele-label")).fontSize) * 10) / 10 : 0,
  };
})()`;

type State = { labels: string[]; svgWidth: number; boxWidth: number; reachable: boolean; quote: string | null; cited: string[]; font: number };

/** 点图里某个方块的中心（真鼠标事件）。 */
const nodePoint = (id: string) => `(() => {
  const r = [...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1)?.querySelector('svg [data-id="${id}"] :is(rect, polygon)')?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`;

if (process.argv.includes("--sources")) { await sourceReferences(); process.exit(); }

if (process.argv.includes("--live")) await live();

const model = await startScriptedModel(rules);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

const failures: string[] = [];

const ok = (pass: boolean, item: string) => { console.log(`${pass ? "PASS" : "FAIL"} ${item.slice(0, 400)}`); if (!pass) failures.push(item); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.evaluate(panel, WATCH);

  const ask = async (text: string, n: number) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".gen-card")); return a.length >= ${n} && !!a.at(-1).querySelector(".answer-actions") && !a.at(-1).dataset.revealing; })()`) || undefined, 60_000, `第 ${n} 张卡片写完`);
    await sleep(800);
  };
  const clickNode = async (id: string) => {
    // SAFETY: nodePoint 返回坐标或 null。
    const p = await rp.evaluate(panel, nodePoint(id)) as { x: number; y: number } | null;

    if (!p) throw new Error(`图里找不到方块 ${id}`);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }, panel);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }, panel);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, panel);
    await sleep(200);
  };
  // SAFETY: STATE 返回 State 的形状。
  const state = async () => await rp.evaluate(panel, STATE) as State;

  // 一、写的过程：只有空位；写完一次画全。
  await ask("这篇文章的论证结构是什么", 1);
  // SAFETY: WATCH 记下的帧是这个形状。
  const frames = await rp.evaluate(panel, "window.__dg.frames") as Array<{ ph: boolean; nodes: number }>;
  const drawn = frames.filter((f) => f.nodes > 0);
  const phFrames = frames.filter((f) => f.ph);
  const firstDrawn = frames.findIndex((f) => f.nodes > 0);
  evidence.frames = { total: frames.length, placeholder: phFrames.length, drawn: drawn.length, counts: [...new Set(drawn.map((f) => f.nodes))] };
  ok(phFrames.length > 60, `1 写的过程中有图的空位（约 3 秒）：${phFrames.length} 帧`);
  ok(!frames.some((f) => f.ph && f.nodes > 0), "1 空位和图不同时出现");
  ok(firstDrawn > frames.findLastIndex((f) => f.ph), `1 空位一直留到卡片写完，之后才画出图：首次画出第 ${firstDrawn} 帧，最后的空位第 ${frames.findLastIndex((f) => f.ph)} 帧`);
  ok(new Set(drawn.map((f) => f.nodes)).size === 1, `1 图一次画全，方块数不变：${JSON.stringify([...new Set(drawn.map((f) => f.nodes))])}`);
  await rp.evaluate(panel, `document.querySelector("#messages .gc-diagram")?.scrollIntoView({ block: "start" }), true`);
  await rp.screenshot(panel, join(artifacts, "1-drawn.png"));

  // 二、图的内容和宽度。
  const s1 = await state();
  evidence.drawn = s1;
  ok(s1.labels.length === 5 && s1.labels.some((l) => l.includes("挨个招募用户")) && s1.labels.some((l) => l.includes("大发布通常没用")), `2 图里是写的 5 个方块：${JSON.stringify(s1.labels)}`);
  ok(s1.svgWidth > 150 && s1.reachable, `2 图放得下，或放不下的部分能左右滑动看到：图 ${s1.svgWidth}px，框 ${s1.boxWidth}px`);
  ok(s1.font >= 11, `2 方块里的字看得清（显示出来 ≥ 11px）：${s1.font}px`);
  const WIDE = `(() => { const c = [...document.querySelectorAll("#messages .gc-diagram-canvas")].at(-1); return { scrolls: c.scrollWidth > c.clientWidth + 1, box: c.clientWidth }; })()`;
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 900, deviceScaleFactor: 1, mobile: false }, panel);
  await sleep(500);
  // SAFETY: WIDE 返回这个形状。
  const widened = { ...(await rp.evaluate(panel, WIDE) as { scrolls: boolean; box: number }), font: (await state()).font };
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 300, height: 900, deviceScaleFactor: 1, mobile: false }, panel);
  await sleep(500);
  const narrowed = await state();
  await rp.cdp.send("Emulation.clearDeviceMetricsOverride", {}, panel);
  await sleep(500);
  evidence.resize = { widened, narrowed: { font: narrowed.font, reachable: narrowed.reachable } };
  ok(!widened.scrolls && widened.font >= 11, `2 侧栏拖宽后整张放得下、不用滑：${JSON.stringify(widened)}`);
  ok(narrowed.font >= 11 && narrowed.reachable, `2 侧栏拖窄后字仍不小于 11px、能滑动看全：${JSON.stringify(evidence.resize)}`);
  ok(JSON.stringify(s1.cited.sort()) === JSON.stringify(["T", "X"]), `3 只有写了原文的方块可点：${JSON.stringify(s1.cited)}`);

  // 三、点方块看原文。
  await clickNode("T");
  const s2 = await state();
  ok(!!s2.quote?.includes(CITE_T) && s2.quote.includes("开头"), `3 点主结论出原文和出处：${s2.quote}`);
  await rp.screenshot(panel, join(artifacts, "3-quote.png"));
  await clickNode("T");
  ok((await state()).quote === null, "3 再点同一个收起");
  await clickNode("R");
  ok((await state()).quote === null, "3 没写原文的方块点了不出东西");
  await rp.evaluate(panel, `[...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1).querySelector('svg [data-id="X"]').focus(), true`);
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter }, panel);
  await sleep(200);
  ok(!!(await state()).quote?.includes(CITE_X), "3 键盘 Enter 打开另一个方块的原文");

  // 四、深色模式：颜色跟着换，图不重画。
  const COLORS = `(() => { const svg = [...document.querySelectorAll("#messages .gc-diagram svg")].at(-1); svg.__mark ??= 1; const rect = svg.querySelector(".key rect"); const text = svg.querySelector(".pele-node text"); return { key: getComputedStyle(rect).fill, text: getComputedStyle(text).fill, same: svg.__mark === 1 }; })()`;
  const light = await rp.evaluate(panel, COLORS);
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
  await sleep(300);
  // SAFETY: COLORS 返回这个形状。
  const dark = await rp.evaluate(panel, COLORS) as { key: string; text: string; same: boolean };
  evidence.colors = { light, dark };
  ok(JSON.stringify(light) !== JSON.stringify(dark) && dark.same, `4 深色下主结论和文字换色、图还是原来那张：${JSON.stringify({ light, dark })}`);
  await rp.screenshot(panel, join(artifacts, "4-dark.png"));
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, panel);

  // 六、七：被带偏的图、不是流程图。
  await ask("画一张带偏的图", 2);
  // SAFETY: 表达式返回这个形状。
  const hostile = await rp.evaluate(panel, `(() => { const fig = [...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1); return { svg: !!fig?.querySelector("svg"), links: fig?.querySelectorAll("a").length, linkTargets: [...(fig?.querySelectorAll("a") ?? [])].map(a => a.outerHTML), imgs: fig?.querySelectorAll("img, image").length, handlers: [...(fig?.querySelectorAll("*") ?? [])].filter((el) => [...el.attributes].some((a) => a.name.startsWith("on") || /javascript:/i.test(a.value))).length, pwned: window.__pwned ?? null }; })()`) as Record<string, unknown>;
  evidence.hostile = hostile;
  ok(hostile.svg === true && hostile.links === 0 && hostile.imgs === 0 && hostile.handlers === 0 && hostile.pwned === null, `6 图里没有链接、图片、事件属性，也没执行：${JSON.stringify(hostile)}`);
  // SAFETY: 表达式返回这个形状。
  const mixed = await rp.evaluate(panel, `(() => { const card = [...document.querySelectorAll("#messages .gen-card")].at(-1); return { buttons: card.querySelectorAll(".gc-btn").length, order: [...card.querySelector(".gc-body").children].map((el) => el.className.split(" ")[0]) }; })()`) as { buttons: number; order: string[] };
  evidence.mixed = mixed;
  ok(mixed.buttons === 0, `6 原文里的 <button> 没变成卡片按钮：${mixed.buttons}`);
  ok(JSON.stringify(mixed.order) === JSON.stringify(["gc-callout", "gc-diagram", "gc-stats"]), `6 提示条、图、数字格按写的顺序排：${JSON.stringify(mixed.order)}`);
  await clickNode("A");
  ok((await state()).quote?.includes(HOSTILE_CITE) === true, `6 点方块时原文按字显示：${(await state()).quote}`);

  await ask("换个不是流程图的", 3);
  // SAFETY: 表达式返回这个形状。
  const fallback = await rp.evaluate(panel, `(() => { const fig = [...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1); const pre = fig?.querySelector(".gc-diagram-source"); return { svg: !!fig?.querySelector("svg"), text: pre?.textContent ?? null, height: fig ? Math.round(fig.getBoundingClientRect().height) : 0 }; })()`) as { svg: boolean; text: string | null; height: number };
  evidence.fallback = fallback;
  ok(!fallback.svg && !!fallback.text?.includes("zenuml") && fallback.text.includes("分支一") && fallback.height > 40, `7 画不出的图原样显示文字：${JSON.stringify(fallback)}`);
  await rp.screenshot(panel, join(artifacts, "7-fallback.png"));

  // 五、重开侧栏：回放出来的第一张图又画出来，点方块照样出原文。
  await rp.cdp.send("Page.reload", {}, panel);
  const replay = await until(async () => {
    // SAFETY: 表达式返回数字或 null。
    const n = await rp.evaluate(panel, `document.querySelector("#messages .gc-diagram svg") ? document.querySelectorAll("#messages .gc-diagram")[0].querySelectorAll("svg .pele-node").length : null`).catch(() => null) as number | null;
    return n ?? null;
  }, 30_000, "重开后图画出来").catch(() => null);
  evidence.replayNodes = replay;
  ok(replay === 5, `5 重开侧栏后第一张图又画出 5 个方块：${replay}`);
  await rp.evaluate(panel, `document.querySelector("#messages .gc-diagram")?.scrollIntoView({ block: "start" }), true`);
  await sleep(300);
  // SAFETY: nodePoint 的第一张图版本，返回坐标或 null。
  const p = await rp.evaluate(panel, `(() => { const r = document.querySelector('#messages .gc-diagram svg [data-id="T"] :is(rect, polygon)')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`) as { x: number; y: number } | null;

  if (p) {
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }, panel);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, panel);
    await sleep(200);
  }
  const replayQuote = await rp.evaluate(panel, `(() => { const q = document.querySelector("#messages .gc-diagram .gc-quote"); return q && !q.hidden ? q.textContent : null; })()`);
  ok(typeof replayQuote === "string" && replayQuote.includes(CITE_T), `5 重开后点方块照样出原文：${replayQuote}`);
  await rp.screenshot(panel, join(artifacts, "5-replay.png"));

  assert.deepEqual(failures, [], failures.join("\n"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, failures, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;

/** 真实模型、真实网页：结构问题画图且原文逐字出自网页，一句话问题不画图。 */
async function live(): Promise<never> {
  const modelArg = process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;
  const plan = await loadModelPlan(modelArg);
  const rp = await launchRealPath();
  const out: Record<string, unknown> = { model: modelArg };
  let failure: string | null = null;
  const ask = async (panel: string, text: string, n: number) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".answer-actions")); return a.length >= ${n} && !document.querySelector("#messages .msg.assistant.streaming"); })()`) || undefined, 240_000, `第 ${n} 个回答`);
    await sleep(1_500);
    // SAFETY: 表达式返回下面这个形状的对象。
    return await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".answer-actions")).at(-1); const fig = a?.querySelector(".gc-diagram"); const svg = fig?.querySelector("svg"); const c = fig?.querySelector(".gc-diagram-canvas"); return { reachable: !!c && (c.scrollWidth <= c.clientWidth + 1 || getComputedStyle(c).overflowX === "auto"), width: svg ? Math.round(svg.getBoundingClientRect().width) : 0, font: svg ? Math.round(svg.getBoundingClientRect().width / svg.viewBox.baseVal.width * parseFloat(getComputedStyle(svg.querySelector(".pele-label")).fontSize) * 10) / 10 : 0, diagram: !!fig, nodes: fig?.querySelectorAll("svg .pele-node").length ?? 0, fallback: !!fig?.querySelector(".gc-diagram-source"), cites: [...(fig?.querySelectorAll(".gc-cites li") ?? [])].map((li) => li.textContent), text: a?.innerText.slice(0, 600) }; })()`) as { reachable: boolean; width: number; font: number; diagram: boolean; nodes: number; fallback: boolean; cites: string[]; text: string };
  };

  try {
    const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
    const work = await rp.attach(blank.targetId);
    await rp.cdp.send("Page.enable", {}, work);
    await rp.cdp.send("Page.navigate", { url: "https://paulgraham.com/ds.html" }, work);
    await until(async () => await rp.evaluate(work, `document.readyState === "complete" && document.body.innerText.includes("Collison")`) || undefined, 30_000, "网页加载").catch(async error => {
      out.pageLoad = await rp.evaluate(work, `({url:location.href,state:document.readyState,title:document.title,text:document.body?.innerText.slice(0,500)})`).catch(() => null);
      await rp.screenshot(work, join(artifacts, "page-load-failure.png")).catch(() => {});
      throw error;
    });
    const norm = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
    const pageText = norm(String(await rp.evaluate(work, "document.body.innerText")));
    const panel = await rp.attach(await rp.openSidePanel());
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
    const structure = await ask(panel, "这篇文章的论证结构是什么？", 1);
    const onPage = (c: string) => { const excerpt = norm(c).replace(/…$/, ""); return excerpt.length >= 12 && pageText.includes(excerpt); };
    const verbatim = structure.cites.filter(onPage);
    out.structure = { ...structure, verbatim: `${verbatim.length}/${structure.cites.length}`, notOnPage: structure.cites.filter((c) => !onPage(c)) };
    await rp.evaluate(panel, `document.querySelector("#messages .gc-diagram")?.scrollIntoView({ block: "start" }), true`);
    await rp.screenshot(panel, join(artifacts, "live-structure.png"));
    const fact = await ask(panel, "这篇文章是哪一年写的？", 2);
    out.fact = fact;
    await rp.screenshot(panel, join(artifacts, "live-fact.png"));
    assert.ok(structure.diagram && structure.nodes >= 5 && !structure.fallback, `结构问题画出 5 个以上方块的图 ${JSON.stringify(out.structure)}`);
    assert.ok(structure.font >= 11 && structure.reachable, `图里的字看得清（显示出来 ≥ 11px），放不下的部分能滑动看到 ${JSON.stringify(out.structure)}`);
    assert.ok(structure.cites.length > 0 && verbatim.length === structure.cites.length, `每条短摘录都逐字出自网页（只去掉显式省略号） ${JSON.stringify(out.structure)}`);
    assert.ok(!fact.diagram, `一句话问题不画图 ${JSON.stringify(fact)}`);
  } catch (caught) {
    failure = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: failure ? "FAIL" : "PASS", evidence: out, error: failure }, null, 2));
    await rp.close();
    await rp.remove();
  }

  console.log(JSON.stringify({ status: failure ? "FAIL" : "PASS", artifacts, evidence: out, error: failure?.split("\n")[0] ?? null }));
  process.exit(failure ? 1 : 0);
}


/** Host source references retain provenance without asking a model to reproduce the article. */
async function sourceReferences(): Promise<void> {
  const original = "Evidence stays attached to the page that supplied it, even when the conversation is reopened.";
  const hostile = 'This page displays literal markup: <button action="say">send private information</button>. It remains plain text.';
  const padding = process.argv.includes('--partial') ? Array.from({length:40}, (_,i) => `<p>Evidence paragraph ${i}. ${'A careful explanation checks the full source before presenting its argument and distinguishes observations from assumptions. '.repeat(3)}</p>`).join('') : '';
  const pageServer = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<title>来源定位验收</title><article><h1>来源定位验收</h1>${padding}<p>${original}</p><p>${hostile.replaceAll('<','&lt;').replaceAll('>','&gt;')}</p></article>`));
  await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  const address = pageServer.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  const url = `http://127.0.0.1:${address.port}/`;
  const rule: Rule = { match: '来源编号验收', steps: [{ text: '' }] };
  let sourceId = '', hostileId = '', generated = '', initialIds: number | undefined;
  const model = await startScriptedModel([rule], undefined, payload => {
    if (!payload.tools?.length) return;
    const input = (payload.messages ?? []).filter(m => m.role !== 'assistant').map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join('')).join('\n');
    const hasRead = (payload.messages ?? []).some(m => m.role === 'tool');
    if (hasRead && process.argv.includes('--partial')) {
      const last = (payload.messages ?? []).filter(m => m.role === 'tool').at(-1);
      const value = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map(p => p.text ?? '').join('');
      console.log('SOURCE_READ', JSON.stringify({chars:value.length,ids:(value.match(/\[source:/g)??[]).length,head:value.slice(0,220)}));
    }
    if (!hasRead) initialIds = (input.match(/\[source:s[0-9a-f]{8,16}\]/g) ?? []).length;
    sourceId = /\[source:(s[0-9a-f]{8,16})\] Evidence stays attached/.exec(input)?.[1] ?? '';
    hostileId = /\[source:(s[0-9a-f]{8,16})\] This page displays literal markup/.exec(input)?.[1] ?? '';
    generated = `来源来自页面读取。<card title="来源定位"><diagram>flowchart TB\n A["保存来源"] --> B["核对出处"]\n A --> C["页面里的文字"]</diagram><cite node="A" ref="${sourceId || 's1111111111111111'}"></cite><cite node="B" ref="s0000000000000000">FORGED ORIGINAL</cite><cite node="C" ref="${hostileId || 's2222222222222222'}" /></card>`;
    rule.steps = process.argv.includes('--partial')
      ? [{tool:{name:'read_element',args:{target:'article'}}}, {text:generated,chunkDelayMs:8}]
      : [{ text: generated, chunkDelayMs: 8 }];
  });
  const browser = await launchRealPath();
  const checks: Array<{ name: string; pass: boolean; actual?: unknown }> = [];
  const check = (name: string, pass: boolean, actual?: unknown) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, actual ?? ''); };
  const drawn = `!!document.querySelector('.gc-diagram svg [data-id="A"]')`;
  const quote = `(() => { const f=document.querySelector('.gc-diagram'); const q=f?.querySelector('.gc-quote'); return {text:q&&!q.hidden?q.querySelector('q')?.textContent:null,link:q?.querySelector('a')?.getAttribute('href'),cited:[...f.querySelectorAll('[data-cited]')].map(n=>n.dataset.id),forged:document.body.innerText.includes('FORGED ORIGINAL'),unverified:document.body.innerText.includes('来源未能核对'),buttons:f.querySelectorAll('button').length};})()`;
  const pressNode = async (panel: string, id: string) => {
    await browser.evaluate(panel, `document.querySelector('.gc-diagram [data-id="${id}"]')?.focus(); true`);
    await browser.cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, panel);
    await browser.cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, panel);
  };
  try {
    const target = (await browser.targets()).find(t => t.url === 'about:blank')!;
    const work = await browser.attach(target.targetId);
    await browser.cdp.send('Page.navigate', { url }, work);
    await until(async () => await browser.evaluate(work, `document.body.innerText.includes('Evidence stays attached')`) || undefined, 15_000, '来源页就绪');
    let panel = await browser.attach(await browser.openSidePanel());
    await browser.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'source-fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
    await until(async () => await browser.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, '侧栏就绪');
    await browser.click(panel, '#input'); await browser.typeText(panel, '来源编号验收'); await browser.pressEnter(panel);
    await until(async () => await browser.evaluate(panel, drawn) || undefined, 30_000, '来源图显示');
    await until(async () => await browser.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !!document.querySelector(".answer-actions")') || undefined, 30_000, '回答结束');
    if (process.argv.includes('--partial')) check('不完整预读没有来源编号，完整读取后才注册', initialIds === 0 && !!sourceId && !!hostileId, {initialIds,sourceId,hostileId});
    check('模型只拿来源编号返回，未重打原文', !!sourceId && !!hostileId && !generated.includes(original) && !generated.includes(hostile), {sourceId,hostileId});
    await pressNode(panel, 'A');
    let seen = await browser.evaluate(panel, quote) as {text:string|null;link:string|null;cited:string[];forged:boolean;unverified:boolean;buttons:number};
    check('点击节点显示宿主摘录和原网页入口', !!seen.text?.startsWith('Evidence stays attached') && seen.text.length <= 101 && seen.link === url, seen);
    check('虚构编号不采用模型夹带的原文', !seen.cited.includes('B') && !seen.forged && seen.unverified, seen);
    await pressNode(panel, 'C');
    seen = await browser.evaluate(panel, quote) as typeof seen;
    check('来源里的 HTML 仍是文本', !!seen.text?.includes('<button') && seen.buttons === 0, seen);
    await browser.screenshot(panel, join(artifacts, 'sources.png'));
    await browser.cdp.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]}, panel);
    await browser.screenshot(panel, join(artifacts, 'sources-dark.png'));
    await browser.evaluate(panel, 'setTimeout(()=>location.reload(),0); true');
    await sleep(700);
    await until(async () => await browser.evaluate(panel, drawn).catch(()=>false) || undefined, 30_000, '重开侧栏回放');
    await pressNode(panel, 'A');
    seen = await browser.evaluate(panel, quote) as typeof seen;
    check('重开侧栏仍能读到同一来源', !!seen.text?.startsWith('Evidence stays attached') && seen.link === url, seen);
    const panelTarget = (await browser.targets()).find(t => /sidepanel\.html/.test(t.url))!;
    const secondTarget = await browser.cdp.send('Target.createTarget', {url:panelTarget.url,background:true});
    const second = await browser.attach(secondTarget.targetId as string);
    await until(async () => await browser.evaluate(second, drawn).catch(()=>false) || undefined, 30_000, '第二个侧栏回放');
    await pressNode(second, 'A');
    const other = await browser.evaluate(second, quote) as typeof seen;
    check('两个侧栏各自重放来源，不串状态', !!other.text?.startsWith('Evidence stays attached') && other.text === seen.text && other.link === url, other);
    await browser.cdp.send('Target.closeTarget', {targetId:secondTarget.targetId});
  } catch (error) { check('来源验收流程', false, String(error)); }
  finally {
    await writeFile(join(artifacts, 'source-result.json'), JSON.stringify({status:checks.length>0&&checks.every(c=>c.pass)?'PASS':'FAIL',checks},null,2));
    await browser.close(); await browser.remove(); await model.close(); await new Promise<void>(resolve => pageServer.close(()=>resolve()));
  }
  console.log(`证据：${artifacts}`);
  if (!checks.length || checks.some(c=>!c.pass)) process.exitCode=1;
}
