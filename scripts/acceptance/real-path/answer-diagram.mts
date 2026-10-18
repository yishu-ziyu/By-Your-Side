/**
 * 回答卡片里的结构图：写完才画、点方块看原文、深色跟着变、重开侧栏能回放、模型写坏或被带偏时不出事。
 *   npx tsx scripts/acceptance/real-path/answer-diagram.mts --headless
 *
 * 隔离的无窗口 Chrome，只装扩展；模型是本机脚本模型，按时间写出一段含结构图的回答（图和原文各停一下）。
 * 判据（只判用户看得见的）：
 * 1. 卡片没写完时只有图的空位、没有图；写完后图一次画全：第一帧出现的方块数就是最后的方块数，不边写边长。
 * 2. 图里是模型写的那几个方块，宽度不超出侧栏。
 * 3. 点有原文的方块，图下出现那句原文和出处；再点收起；没有原文的方块点了不出东西；键盘 Enter 也能打开。
 * 4. 深色模式：同一张图的主结论方块和文字颜色跟着换，图不重画。
 * 5. 重开侧栏：回放出来的回答里图又画出来，点方块照样出原文。
 * 6. 图的文字里夹了 HTML 和 javascript 链接：图里没有链接、图片、事件属性，页面里也没执行。
 * 7. 不是流程图（mindmap）：原样显示图的文字，不留空框。
 * 产物：out/acceptance/real-path/<时间>-answer-diagram/result.json 与截图。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-diagram`);

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
    steps: [{ text: `被带偏的图。\n<card title="带偏">\n<diagram>\nflowchart TB\n  A["<img src=x onerror=window.__pwned=1>点我"] --> B["<a href='javascript:window.__pwned=2'>链接</a>"]\n  click A "javascript:window.__pwned=3"\n</diagram>\n<cite node="A" from="页面">原文</cite>\n</card>` }],
  },
  {
    match: "不是流程图",
    steps: [{ text: `换一种图。\n<card title="思维导图">\n<diagram>\nmindmap\n  root((中心))\n    分支一\n    分支二\n</diagram>\n</card>` }],
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
    quote: quote && !quote.hidden ? quote.textContent : null,
    cited: [...(svg?.querySelectorAll("[data-cited]") ?? [])].map((n) => n.dataset.id),
  };
})()`;

type State = { labels: string[]; svgWidth: number; boxWidth: number; quote: string | null; cited: string[] };

/** 点图里某个方块的中心（真鼠标事件）。 */
const nodePoint = (id: string) => `(() => {
  const r = [...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1)?.querySelector('svg [data-id="${id}"] :is(rect, polygon)')?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`;

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
  ok(firstDrawn > 0 && frames.slice(0, firstDrawn).every((f) => f.nodes === 0), "1 卡片写完前没有画出任何方块");
  ok(new Set(drawn.map((f) => f.nodes)).size === 1, `1 图一次画全，方块数不变：${JSON.stringify([...new Set(drawn.map((f) => f.nodes))])}`);
  await rp.evaluate(panel, `document.querySelector("#messages .gc-diagram")?.scrollIntoView({ block: "start" }), true`);
  await rp.screenshot(panel, join(artifacts, "1-drawn.png"));

  // 二、图的内容和宽度。
  const s1 = await state();
  evidence.drawn = s1;
  ok(s1.labels.length === 5 && s1.labels.some((l) => l.includes("挨个招募用户")) && s1.labels.some((l) => l.includes("大发布通常没用")), `2 图里是写的 5 个方块：${JSON.stringify(s1.labels)}`);
  ok(s1.svgWidth > 150 && s1.svgWidth <= s1.boxWidth, `2 图不超出侧栏：图 ${s1.svgWidth}px，框 ${s1.boxWidth}px`);
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
  const hostile = await rp.evaluate(panel, `(() => { const fig = [...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1); return { svg: !!fig?.querySelector("svg"), links: fig?.querySelectorAll("a").length, imgs: fig?.querySelectorAll("img, image").length, handlers: [...(fig?.querySelectorAll("*") ?? [])].filter((el) => [...el.attributes].some((a) => a.name.startsWith("on") || /javascript:/i.test(a.value))).length, pwned: window.__pwned ?? null }; })()`) as Record<string, unknown>;
  evidence.hostile = hostile;
  ok(hostile.svg === true && hostile.links === 0 && hostile.imgs === 0 && hostile.handlers === 0 && hostile.pwned === null, `6 图里没有链接、图片、事件属性，也没执行：${JSON.stringify(hostile)}`);

  await ask("换个不是流程图的", 3);
  // SAFETY: 表达式返回这个形状。
  const fallback = await rp.evaluate(panel, `(() => { const fig = [...document.querySelectorAll("#messages .gc-diagram:not(.gc-ph)")].at(-1); const pre = fig?.querySelector(".gc-diagram-source"); return { svg: !!fig?.querySelector("svg"), text: pre?.textContent ?? null, height: fig ? Math.round(fig.getBoundingClientRect().height) : 0 }; })()`) as { svg: boolean; text: string | null; height: number };
  evidence.fallback = fallback;
  ok(!fallback.svg && !!fallback.text?.includes("mindmap") && fallback.text.includes("分支一") && fallback.height > 40, `7 画不出的图原样显示文字：${JSON.stringify(fallback)}`);
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
