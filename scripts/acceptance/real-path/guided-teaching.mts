/**
 * 一步一步教我：圈出该点的地方，等用户自己点完再带下一步（docs/evals/20261011-guided-teaching.md）。
 * 只装扩展、隔离构建、本机三步练习页（Settings → Display → Dark theme）。默认用本机脚本模型按顺序调 guide_step；
 * 用户的点击和移动都是 CDP 派发的真实输入（isTrusted），按网页上圈出来的位置点。
 *   npx tsx scripts/acceptance/real-path/guided-teaching.mts --headless [--model=provider/id]
 *   N) R1：三步依次点中才推进；没点之前工具不返回；侧栏标题「第 N 步 · 等你操作」；最后页面是深色；网页收到的点击数等于用户点的次数（助手 0 次）。
 *      光标飞过去（第一次读到圈时光标还不在目标旁），停在目标右下角。正常页面上点中后不出现「没有生效」。
 *   M) R2：点在目标外：工具不返回，圈旁改成「这里不是要点的位置…」，光标停在目标右下角；用户一动鼠标，光标松开、离开目标；再点中才推进，结果里 misses=1。
 *   R) R2 反例：减少动态效果时，第一次读到圈时光标已经在目标旁（不飞行）。
 *   B) R3：开关点了没反应：3 秒左右圈旁改成「好像没有生效…」，侧栏出现「点了「Dark theme」，页面没有变化」；第二次仍没变化，这一步按「没完成」结束（guide_no_change），侧栏写「点了两次，页面都没有变化」，不画成失败。
 *   Q) 网页按下就切换并重画面板（像 Radix 标签）：点中照样算完成，三步走完、页面是深色。
 *   S) R4：等用户点的时候点侧栏「停」：等待马上结束，圈和停住的光标都清掉；之后再点原目标，网页上什么都不出现；模型收到「用户停下了」。
 * --model：换成真实模型（~/.sideagent/providers.local.json），只跑 N 的自然说法；用户按圈出来的位置点，最多 6 步。
 * 失败方式：去掉「点中才返回」，N 的「没点之前不返回」失败；去掉点错提示或让开，M 失败；
 * 停下后不撤监听，S 再点原目标时会重新出圈或光标。实测抓到过：只听 click 时 Q 第 2 步一直不返回（按下就重画，浏览器不发 click）；
 * 画圈后的 resize 打断飞行时，N 的「半路」判据失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-guided-teaching`);

await mkdir(out, { recursive: true });

const modelArg = process.argv.find(arg => arg.startsWith("--model="))?.slice(8);

/** 练习页：?broken 时 Dark theme 开关点了什么都不变；?rerender 时标签在按下时就切换，并整块重画面板。网页记下收到的每一次点击。 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>主题练习页</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;background:#fff;color:#111}body.dark{background:#16181d;color:#eee}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid #ccc}main{padding:20px 20px;max-width:520px}
#panel{position:absolute;right:20px;top:64px;width:300px;border:1px solid #bbb;background:inherit;padding:12px 16px;border-radius:8px}
.tabs button{margin-right:8px;font:inherit}.tabs .sel{font-weight:700}
.switch{display:inline-block;width:40px;height:22px;border-radius:11px;background:#bbb;border:0;vertical-align:middle;margin-left:8px}.switch[aria-checked=true]{background:#2d6}</style></head>
<body><header><b>My App</b><button id="settings" type="button">⚙ Settings</button></header>
<main><h1>欢迎</h1><p id="intro">这是一段正文，和设置无关。主题在右上角的设置里。</p></main>
<div id="panel" hidden></div>
<script>
const q = new URLSearchParams(location.search), broken = q.has("broken"), rerender = q.has("rerender");
window.clicks = [];
document.addEventListener("click", e => clicks.push({ id: e.target.id || e.target.tagName, trusted: e.isTrusted }), true);
const panel = document.getElementById("panel");
let tab = "general";
const pane = t => t === "general" ? '<section id="pane-general"><p>Language: English</p></section>'
  : '<section id="pane-display"><p><label for="dark">Dark theme</label><button id="dark" type="button" class="switch" role="switch" aria-label="Dark theme" aria-checked="' + document.body.classList.contains("dark") + '"></button></p></section>';
function render() { panel.innerHTML = '<div class="tabs" role="tablist"><button id="t-general" type="button" role="tab" class="' + (tab === "general" ? "sel" : "") + '">General</button><button id="t-display" type="button" role="tab" class="' + (tab === "display" ? "sel" : "") + '">Display</button></div>' + (rerender ? pane(tab) : pane("general") + pane("display")); if (!rerender) document.getElementById("pane-display").hidden = tab !== "display"; }
render();
document.getElementById("settings").addEventListener("click", () => { panel.hidden = false; });
const pick = e => { const id = e.target.id; if (id !== "t-general" && id !== "t-display") return; tab = id.slice(2);
  if (rerender) { render(); return; }
  document.getElementById("t-general").classList.toggle("sel", tab === "general"); document.getElementById("t-display").classList.toggle("sel", tab === "display");
  document.getElementById("pane-general").hidden = tab !== "general"; document.getElementById("pane-display").hidden = tab !== "display"; };
panel.addEventListener(rerender ? "pointerdown" : "click", pick);
panel.addEventListener("click", e => { if (e.target.id !== "dark" || broken) return; document.body.classList.toggle("dark"); e.target.setAttribute("aria-checked", String(document.body.classList.contains("dark"))); });
</script></body></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const pageUrl = (query: string) => `http://127.0.0.1:${siteAddress(site).port}/${query}`;

const SAY = ["点右上角的「⚙ Settings」，打开设置。", "点「Display」标签，主题选项在这里。", "点「Dark theme」开关，打开深色主题。"];

const TARGETS = ["#settings", "#t-display", "#dark"];

const guideCall = (i: number) => ({ tool: { name: "guide_step", args: { target: TARGETS[i]!, say: SAY[i]!, step: i + 1 } } });

const MISS_TEXT = "这里不是要点的位置。请点圈出来的「⚙ Settings」。";

const NO_CHANGE_TEXT = "好像没有生效：点了之后页面没有变化。再点一次试试；还不行就告诉我。";

const ASK = {
  n: "案例N：教我打开深色主题，一步一步指给我看，我自己点。",
  m: "案例M：教我打开深色主题，一步一步指给我看，我自己点。",
  r: "案例R：教我打开设置。",
  b: "案例B：教我打开深色主题，开关在这里。",
  q: "案例Q：教我打开深色主题，一步一步指给我看，我自己点。",
  s: "案例S：教我打开深色主题，一步一步指给我看，我自己点。",
};

const REAL_ASK = "教我打开深色主题，一步一步指给我看，我自己点。";

const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });

/** 模型收到的工具结果，按调用编号去重（每次请求都带着全部历史）。 */
const toolTexts: string[] = [];

const toolIds = new Set<string>();

const scripted = modelArg ? null : await startScriptedModel([
  // 目标核对的请求里带着用户原话：先认它，直接判完成，免得它匹配到下面的用例。
  { match: '"goalPage"', steps: [{ text: DONE }] },
  { match: ASK.n, steps: [guideCall(0), guideCall(1), guideCall(2), { text: "N 完成。" }] },
  { match: ASK.m, steps: [guideCall(0), guideCall(1), guideCall(2), { text: "M 完成。" }] },
  { match: ASK.r, steps: [guideCall(0), { text: "R 完成。" }] },
  { match: ASK.b, steps: [guideCall(2), { text: "B 完成。" }] },
  { match: ASK.q, steps: [guideCall(0), guideCall(1), guideCall(2), { text: "Q 完成。" }] },
  { match: ASK.s, steps: [guideCall(0), { text: "S 不该出现。" }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    if (m.role === "tool" && !toolIds.has(id)) { toolIds.add(id); toolTexts.push(text); }
  }
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const measured: Record<string, Json> = {};

type Hold = { holding: boolean; pressing: boolean; hidden: boolean; x: number; y: number; guide: { label: string; misses: number; parkedAtTarget: boolean; checking: boolean } | null };

type Box = { left: number; top: number; right: number; bottom: number };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);

  // 扩展内容脚本的读数在扩展的隔离环境里，网页自己的环境读不到：记下这页上的隔离环境，逐个试。
  const isolated = new Set<number>();

  rp.cdp.onEvent("Runtime.executionContextCreated", (message: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (message.sessionId === work && message.params.context.auxData?.type === "isolated" && message.params.context.origin.startsWith("chrome-extension://")) isolated.add(message.params.context.id);
  });
  rp.cdp.onEvent("Runtime.executionContextDestroyed", (message: { sessionId?: string; params: { executionContextId: number } }) => { if (message.sessionId === work) isolated.delete(message.params.executionContextId); });
  rp.cdp.onEvent("Runtime.executionContextsCleared", (message: { sessionId?: string }) => { if (message.sessionId === work) isolated.clear(); });
  await rp.cdp.send("Runtime.enable", {}, work);
  await rp.cdp.send("Page.enable", {}, work);

  const probe = async <T,>(expression: string): Promise<T | null> => {
    for (const contextId of [...isolated]) {
      // SAFETY: CDP Runtime.evaluate 返回 { result: { value } }；读数是可序列化的普通对象。
      const res = await rp.cdp.send("Runtime.evaluate", { expression: `(() => { const ns = globalThis.__sideagent; return ns?.holdState ? (${expression}) : undefined; })()`, contextId, returnByValue: true }, work).catch(() => null) as { result?: { value?: T } } | null;

      if (res?.result && res.result.value !== undefined) return res.result.value;
    }

    return null;
  };

  const hold = () => probe<Hold>("ns.holdState()");

  const markCount = async () => (await probe<number>("ns.markLayerCount()")) ?? 0;

  /** 圈在视口里的中心：用户按圈出来的位置点。 */
  const markCenter = async () => {
    const box = await probe<{ x: number; y: number; width: number; height: number }>("ns.markLayout()[0] ?? null");

    if (!box) return null;
    const scroll = await rp.evaluate(work, "[scrollX, scrollY]") as [number, number];

    return { x: box.x + box.width / 2 - scroll[0], y: box.y + box.height / 2 - scroll[1] };
  };

  const rectOf = async (selector: string) => await rp.evaluate(work, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null; })()`) as Box | null;

  let userClicks = 0;

  const userMove = (at: { x: number; y: number }) => rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, work);

  const userClick = async (at: { x: number; y: number }) => {
    await userMove(at);
    userClicks += 1;

    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, work);
  };

  const userClickOn = async (selector: string) => {
    const r = await rectOf(selector);

    if (!r) throw new Error(`练习页上找不到 ${selector}`);
    await userClick({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
  };

  const pageClicks = async () => Number(await rp.evaluate(work, "window.clicks.length"));

  const dark = async () => Boolean(await rp.evaluate(work, 'document.body.classList.contains("dark")'));

  const nearCorner = (h: Hold | null, r: Box | null) => !!h && !!r && Math.abs(h.x - (r.right - 6)) <= 3 && Math.abs(h.y - (r.bottom - 6)) <= 3;

  const panel = await rp.attach(await rp.openSidePanel());
  const items = modelArg ? modelStorageItems(await loadModelPlan(modelArg)) : { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: scripted!.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  const answered = (text: string, ms = 60_000) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, ms, `回答「${text}」`);

  const idle = () => until(async () => !(await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")')), 15_000, "侧栏回到空闲", 50);

  const runTitle = async () => String(await rp.evaluate(panel, '[...document.querySelectorAll(".run-steps")].at(-1)?.querySelector(".run-title")?.textContent ?? ""'));

  const warnRow = async () => String(await rp.evaluate(panel, '[...document.querySelectorAll(".run-trail .trail-aside.warn")].at(-1)?.textContent ?? ""'));

  /** 打开练习页的新文档，等扩展的光标脚本就位。 */
  const openPage = async (query: string) => {
    await rp.cdp.send("Page.navigate", { url: pageUrl(query) }, work);
    await until(async () => (await rp.evaluate(work, '!!document.querySelector("#settings") && document.readyState === "complete"').catch(() => false)) || undefined, 15_000, "练习页加载");
    await until(async () => (await hold()) !== null || (await probe<boolean>("true")) || undefined, 15_000, "扩展光标脚本就位");
    await rp.cdp.send("Page.bringToFront", {}, work);
  };

  /** 等第 step 步出现在网页上（圈旁写着 say），接着连续记下光标 600 毫秒内的位置（看它是飞过去还是直接到位）。 */
  const guideShown = async (say: string) => {
    const first = await until(async () => { const h = await hold(); return h?.guide?.label === say ? h : null; }, 30_000, `网页上出现「${say}」`, 0);
    const path: Array<{ ms: number; x: number; y: number }> = [{ ms: 0, x: first.x, y: first.y }];
    const startedAt = Date.now();

    while (Date.now() - startedAt < 600) { const h = await hold(); if (h) path.push({ ms: Date.now() - startedAt, x: h.x, y: h.y }); }

    return { first, path };
  };

  const toolsSince = (from: number) => toolTexts.slice(from);

  if (modelArg) {
    // ── 真实模型：只跑自然说法，用户按圈出来的位置点 ──
    await openPage("");
    const clicksBefore = await pageClicks();
    const userBefore = userClicks;
    await ask(REAL_ASK);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")'), 15_000, "任务开始");
    let steps = 0;

    for (; steps < 6; steps++) {
      const center = await until(async () => {
        if (!(await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")'))) return "idle" as const;
        const h = await hold();

        return h?.guide ? await markCenter() : null;
      }, 180_000, "下一步圈出来或任务结束", 200);

      if (center === "idle") break;
      await rp.screenshot(work, join(out, `real-step-${steps + 1}.png`));
      await sleep(600);
      await userClick(center);
      await until(async () => !(await hold())?.guide || undefined, 10_000, "这一步收起", 100).catch(() => null);
    }

    await idle().catch(() => {});
    await rp.screenshot(panel, join(out, "real-panel.png"));
    const transcript = String(await rp.evaluate(panel, 'document.querySelector("#messages").innerText'));
    measured.realTranscript = transcript;
    check("真实模型：页面最后是深色", await dark(), { steps });
    check("真实模型：正常页面上没有出现「页面没有变化」的误报", !transcript.includes("页面没有变化") && !transcript.includes("点了两次"), { steps });
    check("真实模型：网页收到的点击数等于用户点的次数（助手没替用户点）", (await pageClicks()) - clicksBefore === userClicks - userBefore, { page: (await pageClicks()) - clicksBefore, user: userClicks - userBefore });
  } else {
    // ── N：正常走完三步 ──
    await openPage("");
    let from = toolTexts.length;
    let clicksBefore = await pageClicks();
    let userBefore = userClicks;
    await ask(ASK.n);
    const titles: string[] = [];
    let sawWarn = false;

    for (let i = 0; i < 3; i++) {
      const { path } = await guideShown(SAY[i]!);
      const r = await rectOf(TARGETS[i]!);
      const atCorner = (p: { x: number; y: number }) => nearCorner({ ...p } as Hold, r);

      // 半路：既不在出发点，也不在目标旁。只看到出发点和终点就是跳过去的。
      const midway = path.filter(p => !atCorner(p) && Math.hypot(p.x - path[0]!.x, p.y - path[0]!.y) > 5);

      if (i === 0) check("N 光标飞过去：圈出现后能看到光标在半路，最后停到目标旁", midway.length >= 2 && atCorner(path.at(-1)!), { midway: midway.slice(0, 8), samples: path.length, start: path[0]!, target: r });
      await sleep(1500);
      const parked = await hold();
      titles.push(await runTitle());
      check(`N 第 ${i + 1} 步：圈在目标上，光标停在目标右下角，没点之前工具不返回`, nearCorner(parked, r) && !!parked?.guide?.parkedAtTarget && toolsSince(from).length === i, { hold: parked, target: r, toolResults: toolsSince(from).length });
      check(`N 第 ${i + 1} 步：侧栏标题「第 ${i + 1} 步 · 等你操作」`, titles.at(-1)!.includes(`第 ${i + 1} 步 · 等你操作`), { title: titles.at(-1)! });

      if (i === 0) await rp.screenshot(work, join(out, "n-step1-page.png"));
      if (i === 0) await rp.screenshot(panel, join(out, "n-step1-panel.png"));
      await userClick((await markCenter())!);
      await until(async () => toolsSince(from).length > i || undefined, 10_000, `第 ${i + 1} 步点中后工具返回`, 50);
      const h = await hold();
      sawWarn ||= h?.guide?.label === NO_CHANGE_TEXT || (await warnRow()).length > 0;
    }

    await answered("N 完成。");
    const toolN = toolsSince(from);
    check("N 三步都等用户点中、页面有变化后才返回（done）", toolN.length === 3 && toolN.every((t, i) => t.includes(`Step ${i + 1} done`)), { tool: toolN });
    check("N 正常页面：点中后没有「没有生效」提示", !sawWarn && toolN.every(t => t.includes("noChangeClicks=0")), { sawWarn });
    check("N 最后页面是深色；网页收到的点击数等于用户点的次数（助手 0 次）", (await dark()) && (await pageClicks()) - clicksBefore === userClicks - userBefore, { dark: await dark(), page: (await pageClicks()) - clicksBefore, user: userClicks - userBefore });
    check("N 结束后：网页上没有圈、光标没有停住", (await markCount()) === 0 && !(await hold())?.holding && !(await hold())?.guide, { marks: await markCount(), hold: await hold() });
    await idle();
    await rp.screenshot(work, join(out, "n-done-page.png"));

    // ── M：点错 ──
    await openPage("");
    from = toolTexts.length;
    await ask(ASK.m);
    await guideShown(SAY[0]!);
    await sleep(1500);
    await userClickOn("#intro");
    await sleep(800);
    const missed = await hold();
    const settingsRect = await rectOf("#settings");
    check("M 点在目标外：工具不返回，圈旁改成点错提示，光标停在目标右下角", toolsSince(from).length === 0 && missed?.guide?.label === MISS_TEXT && missed.guide.misses === 1 && nearCorner(missed, settingsRect), { hold: missed, target: settingsRect, toolResults: toolsSince(from).length });
    await rp.screenshot(work, join(out, "m-miss.png"));
    await userMove({ x: 400, y: 500 });
    await sleep(1500);
    const gaveWay = await hold();
    const far = !!gaveWay && !!settingsRect && Math.hypot(gaveWay.x - settingsRect.right, gaveWay.y - settingsRect.bottom) > 100;
    check("M 用户移动鼠标后：光标松开、离开目标，圈还在", !!gaveWay && !gaveWay.holding && !gaveWay.guide?.parkedAtTarget && far && gaveWay.guide?.label === MISS_TEXT && toolsSince(from).length === 0, { hold: gaveWay });
    await rp.screenshot(work, join(out, "m-gave-way.png"));

    for (let i = 0; i < 3; i++) {
      if (i > 0) { await guideShown(SAY[i]!); await sleep(500); }
      await userClick((await markCenter())!);
      await until(async () => toolsSince(from).length > i || undefined, 10_000, `M 第 ${i + 1} 步点中后工具返回`, 50);
    }

    await answered("M 完成。");
    check("M 再点中才推进：第 1 步结果是 done、misses=1", !!toolsSince(from)[0]?.includes("Step 1 done") && toolsSince(from)[0]!.includes("misses=1"), { tool: toolsSince(from) });
    await idle();

    // ── R：减少动态效果 ──
    await openPage("");
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, work);
    await ask(ASK.r);
    const reduced = await guideShown(SAY[0]!);
    const rRect = await rectOf("#settings");
    check("R 减少动态效果：圈出现时光标已经在目标右下角，之后一直不动（不飞行）", reduced.path.every(p => nearCorner({ ...p } as Hold, rRect)), { path: reduced.path.filter((_, k) => k % 5 === 0), samples: reduced.path.length, target: rRect });
    await userClick((await markCenter())!);
    await answered("R 完成。");
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [] }, work);
    await idle();

    // ── B：开关点了没反应 ──
    await openPage("?broken=1");
    await userClickOn("#settings");
    await userClickOn("#t-display");
    from = toolTexts.length;
    await ask(ASK.b);
    await guideShown(SAY[2]!);
    await sleep(1000);
    await userClick((await markCenter())!);
    const clickedAt = Date.now();
    await until(async () => (await hold())?.guide?.label === NO_CHANGE_TEXT || undefined, 6_000, "圈旁出现「好像没有生效」", 50);
    const hintMs = Date.now() - clickedAt;
    measured.noChangeHintMs = hintMs;
    check("B 点了没变化：3 秒左右圈旁改成「好像没有生效…」，这一步不算完成", hintMs >= 2500 && hintMs <= 3600 && toolsSince(from).length === 0, { hintMs, toolResults: toolsSince(from).length });
    const warn = await until(async () => (await warnRow()) || undefined, 5_000, "侧栏出现「页面没有变化」", 100).catch(() => "");
    check("B 侧栏出现「点了「Dark theme」，页面没有变化」（教学状态传到了助手）", warn.includes("点了「Dark theme」，页面没有变化") && (await runTitle()).includes("第 3 步 · 等你操作"), { warn, title: await runTitle() });
    await rp.screenshot(work, join(out, "b-no-change-page.png"));
    await rp.screenshot(panel, join(out, "b-no-change-panel.png"));
    await userClick((await markCenter())!);
    await answered("B 完成。", 15_000);
    check("B 第二次仍没变化：这一步没完成，模型收到「页面都没有变化」", !!toolsSince(from)[0]?.includes("页面都没有变化"), { tool: toolsSince(from) });
    const bChip = await rp.evaluate(panel, '(() => { const c = [...document.querySelectorAll(".chip:not(.prep)")].at(-1); return c ? { text: c.textContent.trim(), error: c.classList.contains("error") || !!c.querySelector(".act-failed") } : null; })()') as { text: string; error: boolean } | null;
    check("B 侧栏这一步写「点了两次，页面都没有变化」，不画成失败", !!bChip?.text.includes("点了两次，页面都没有变化") && !bChip.error, { chip: bChip });
    check("B 结束后：网页上没有圈、光标没有停住", (await markCount()) === 0 && !(await hold())?.guide, { marks: await markCount(), hold: await hold() });
    await idle();

    // ── Q：按下就切换、整块重画 ──
    await openPage("?rerender=1");
    from = toolTexts.length;
    await ask(ASK.q);

    for (let i = 0; i < 3; i++) {
      await guideShown(SAY[i]!);
      await sleep(500);
      await userClick((await markCenter())!);
      await until(async () => toolsSince(from).length > i || undefined, 10_000, `Q 第 ${i + 1} 步点中后工具返回`, 50);
    }

    await answered("Q 完成。");
    check("Q 网页按下就切换并重画：三步都算完成，页面是深色", toolsSince(from).length === 3 && toolsSince(from).every((t, i) => t.includes(`Step ${i + 1} done`)) && (await dark()), { tool: toolsSince(from), dark: await dark() });
    await idle();

    // ── S：等用户点的时候点「停」──
    await openPage("");
    clicksBefore = await pageClicks();
    userBefore = userClicks;
    await ask(ASK.s);
    await guideShown(SAY[0]!);
    await sleep(1000);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")'), 10_000, "侧栏出现停止按钮");
    const stopAt = Date.now();
    await rp.click(panel, "#send-btn");
    await until(async () => { const h = await hold(); return (await markCount()) === 0 && h && !h.guide && !h.holding ? h : null; }, 5_000, "停下后圈和停住的光标清掉", 50);
    const cleanMs = Date.now() - stopAt;
    await idle();
    measured.stopCleanMs = cleanMs;
    check("S 点「停」：2 秒内圈清掉、光标松开", cleanMs <= 2000, { cleanMs });
    await userClickOn("#settings");
    await sleep(1500);
    const after = await hold();
    check("S 停下以后再点原目标：网页上不再出圈、光标不停住，网页照常处理这次点击", (await markCount()) === 0 && !after?.guide && !after?.holding && (await pageClicks()) - clicksBefore === userClicks - userBefore && !(await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("S 不该出现。"))`)), { marks: await markCount(), hold: after });
    await rp.screenshot(work, join(out, "s-after-stop.png"));
    measured.stopStepChips = await rp.evaluate(panel, '[...document.querySelectorAll(".run-steps")].at(-1)?.querySelectorAll(".chip:not(.prep)") ? [...[...document.querySelectorAll(".run-steps")].at(-1).querySelectorAll(".chip:not(.prep)")].map(c => ({ text: c.textContent.trim(), error: c.classList.contains("error") || !!c.querySelector(".act-failed") })) : null');
    await rp.screenshot(panel, join(out, "s-panel.png"));
    const stopChips = (measured.stopStepChips ?? []) as Array<{ text: string; error: boolean }>;
    check("S 侧栏把停下的那一步写成「你停下了，这一步没做完」，不画成失败", stopChips.some(c => c.text.includes("你停下了，这一步没做完") && !c.error), { chips: stopChips });
    // S 停下后没有下一次模型请求；它的工具结果随下一次请求的历史送到模型这边。
    await openPage("");
    await ask(ASK.r);
    await guideShown(SAY[0]!);
    await userClick((await markCenter())!);
    await answered("R 完成。");
    const stopped = toolTexts.find(t => t.includes("用户停下了任务或接管了页面"));
    check("S 模型收到的结果写明用户停下、工具没有替用户点", !!stopped?.includes("没有替用户点"), { tool: stopped ?? null });
  }
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", model: modelArg ?? "scripted", checks, measured, toolTexts, notCovered: ["2 分钟没点（timeout）：产品没有缩短等待的开关，也不为测试加", "接管、关页、离开网页：与停下走同一条收场路径，这里只跑停下", "跨源 iframe 里的目标"], modelRequests: scripted?.requests ?? null }, null, 2));
  await rp.close(); await rp.remove(); await scripted?.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
