/**
 * 诊断探针：用户让助手解释文章里的一段，助手写到一半时用户说「不是定义，我想知道为什么」。
 * 看两条入口：页内阅读卡（A）与侧栏改方向（B）。新回答要仍指向同一段，旧回答不能在纠正后回来。
 *
 * 真扩展、隔离无头 Chrome、本机练习文章、本机脚本模型。FAIL 是可能的产品结论，不是脚本错误；
 * 流程本身走不通（等待超时等）才记 flow 错误并 exit 1。
 *
 *   npx tsx scripts/probes/reading-correction.mts --headless
 *
 * 证据：out/probes/reading-correction/<时间>/result.json 与截图。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "../acceptance/real-path/harness.mts";
import { configureViaSettings } from "../acceptance/real-path/inproc-config.mts";
import { startScriptedModel } from "../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/reading-correction", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(out, { recursive: true });

// ── 练习文章：#para 开头是全页唯一的标记句 ──
const MARKER = "The lighthouse keeper logged every storm in violet ink so that later sailors could trust the record.";

const FILLER = [
  "Coastal towns kept their own weather books long before national services existed.",
  "Harbour masters compared notes each spring to decide which channels were still safe.",
  "Many of those books were lost in fires, floods, or simple neglect over the following century.",
];

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Weather books of the coast</title>
<style>body{font:17px/1.7 Georgia,serif;max-width:640px;margin:40px 24px;padding:0}</style></head><body>
<h1>Weather books of the coast</h1>
<p id="p0">${FILLER.join(" ")}</p>
<p id="para"><span id="para-text">${MARKER} The colour was chosen because ordinary black ink faded in salt air within a few winters, while the violet dye stayed legible for decades.</span></p>
<p id="p2">${FILLER.slice().reverse().join(" ")}</p>
<p id="p3">${FILLER[1]} ${FILLER[0]}</p>
</body></html>`;

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ARTICLE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const articleUrl = `http://127.0.0.1:${siteAddress(site).port}/article`;

// ── 脚本模型：纠正规则放第一位（阅读卡第二次请求的 JSON 里同时含旧问题与纠正原话） ──
const CORRECTION = "我想知道为什么";

const CARD_OLD_TAIL = "旧定义的最后一句话到此为止。";

const CARD_OLD = Array.from({ length: 160 }, (_, i) => `旧定义第${String(i).padStart(3, "0")}句。`).join("") + CARD_OLD_TAIL;

const PANEL_OLD_TAIL = "旧解释的最后一句话到此为止。";

const PANEL_OLD = Array.from({ length: 160 }, (_, i) => `旧解释第${String(i).padStart(3, "0")}句。`).join("") + PANEL_OLD_TAIL;

const WHY = "新原因：作者用紫色墨水，是因为普通黑墨水在海风里几个冬天就褪色，而紫色染料几十年后仍清楚可读。";

const READING_SYSTEM = "你是用户在网页旁的阅读助手";

type Msg = { role: string; content?: string | Array<{ type?: string; text?: string }> | null };

type Captured = { at: number; tools: boolean; reading: boolean; messages: Msg[] };

/** 脚本模型每段 12 字；旧回答在服务端写完的时刻，加 1.5 s 余量。迟到片段只可能在这之前出现。 */
const oldStreamEnd = (startAt: number, text: string, delayMs: number) => startAt + Math.ceil(text.length / 12) * delayMs + 1500;

const textOf = (c: Msg["content"]): string => Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : c ?? "";

const captured: Captured[] = [];

const model = await startScriptedModel([
  { match: CORRECTION, steps: [{ text: WHY }] },
  { match: "解释这段选中的文字", steps: [{ text: CARD_OLD, chunkDelayMs: 150 }] },
  { match: "解释这一段", steps: [{ text: PANEL_OLD, chunkDelayMs: 200 }] },
], undefined, (payload) => {
  const messages = (payload.messages ?? []) as Msg[];
  captured.push({ at: Date.now(), tools: !!payload.tools?.length, reading: messages.some((m) => m.role === "system" && textOf(m.content).startsWith(READING_SYSTEM)), messages });
});

const rp = await launchRealPath();

type Check = { id: string; name: string; pass: boolean; detail: Json };

const checks: Check[] = [];

const record: Record<string, Json> = {};

const check = (id: string, name: string, pass: boolean, detail: Json) => {
  checks.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} ${JSON.stringify(detail)}`);
};

const excerpt = (c: Captured) => ({
  atMs: c.at,
  tools: c.tools,
  reading: c.reading,
  messages: c.messages.map((m) => ({ role: m.role, chars: textOf(m.content).length, text: textOf(m.content).slice(0, 800) + (textOf(m.content).length > 800 ? "…" : "") })),
});

let flowError: string | null = null;

type DomNode = { nodeName: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  const workTargetId = (await rp.targets()).find((t) => t.url === "about:blank")!.targetId;
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("DOM.enable", {}, work);

  const openArticle = async () => {
    await rp.cdp.send("Page.navigate", { url: articleUrl }, work);
    await until(async () => (await rp.evaluate(work, `location.href === ${JSON.stringify(articleUrl)} && document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "练习文章与阅读卡宿主");
  };

  await openArticle();
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  const settings = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  record.settings = { save: settings.saveStatus, test: settings.testStatus };
  await rp.cdp.send("Target.closeTarget", { targetId: settings.settingsTargetId }).catch(() => {});
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);

  // ── 阅读卡封闭 shadow root：CDP 穿透拿到它，再在里面执行函数 ──
  const shadowObject = async (): Promise<string> => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
    const find = (n: DomNode): DomNode | null => {
      if ((n.attributes ?? []).includes("data-sideagent-ask") && n.shadowRoots?.length) return n.shadowRoots[0]!;

      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) { const hit = find(c); if (hit) return hit; }

      return null;
    };
    const shadow = find(root);

    if (!shadow) throw new Error("找不到阅读卡 shadow root");
    const { object } = await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work);

    return String(object.objectId);
  };

  let shadowId = await shadowObject();
  const inCard = async <T,>(fn: string): Promise<T> => {
    // SAFETY: callFunctionOn 以 returnByValue 返回函数结果。
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId: shadowId, functionDeclaration: fn, returnByValue: true }, work);

    if (reply.exceptionDetails) throw new Error(`阅读卡脚本出错：${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);

    return reply.result.value as T;
  };

  type CardState = { turns: Array<{ question: string; answer: string; status: string }>; hint: { hidden: boolean; text: string }; textarea: string; focused: boolean; sendLabel: string | null; text: string };

  const CARD_STATE = `function(){
    const turns=[...this.querySelectorAll('.turn')].map(t=>({question:t.querySelector('.question')?.textContent??'',answer:t.querySelector('.answer')?.textContent??'',status:t.querySelector('.status')?.textContent??''}));
    const e=this.querySelector('.error');
    const ta=this.querySelector('textarea');
    return {turns,hint:{hidden:!!e?.hidden,text:e?.textContent??''},textarea:ta?.value??'',focused:this.activeElement===ta,sendLabel:this.querySelector('.send')?.getAttribute('aria-label')??null,text:this.querySelector('.surface')?.innerText??''};
  }`;

  const card = () => inCard<CardState>(CARD_STATE);
  const cardPoint = (selector: string) => inCard<{ x: number; y: number } | null>(`function(){const e=this.querySelector(${JSON.stringify(selector)});if(!e||e.closest('[hidden]'))return null;const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null}`);

  const mouseClick = async (point: { x: number; y: number }) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point }, work);
  };

  const selectPara = async () => {
    // SAFETY: 页面脚本返回段落文字首尾坐标。
    const span = await rp.evaluate(work, `(() => { document.querySelector("#para").scrollIntoView({block:"center"}); const r = document.querySelector("#para-text").getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1, y: span.y1 }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, work);

    for (let i = 1; i <= 10; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 10, y: span.y1 + ((span.y2 - span.y1) * i) / 10, button: "left", buttons: 1 }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, work);
    const selected = String(await rp.evaluate(work, "getSelection().toString()"));

    if (!selected.includes(MARKER)) throw new Error(`划选没有覆盖标记句：${selected.slice(0, 120)}`);

    return selected;
  };

  /** 像用户一样点进卡片输入框；点完确认焦点真的在输入框里。 */
  const focusCardInput = async () => {
    const point = await until(() => cardPoint("textarea"), 5_000, "阅读卡输入框可见");
    await mouseClick(point);
    const focused = await until(async () => (await card()).focused || undefined, 3_000, "阅读卡输入框获得焦点").catch(() => false);
    const outerFocus = await rp.evaluate(work, `document.activeElement?.hasAttribute("data-sideagent-ask") ?? false`);

    return { focused: !!focused, outerFocus };
  };

  const readingRequestsWith = (needle: string, after: number) => captured.filter((c) => c.reading && c.at >= after && c.messages.some((m) => textOf(m.content).includes(needle)));

  // ═════════ Segment A：阅读卡 ═════════
  await selectPara();
  const explain = await until(() => cardPoint('[data-act="explain"]'), 15_000, "页内「解释」按钮显示");
  await sleep(400);
  const tExplain = Date.now();
  await mouseClick(explain);
  const generating = await until(async () => {
    const s = await card();
    const t = s.turns[0];

    return t && t.status.includes("正在生成") && t.answer.length > 20 ? s : undefined;
  }, 30_000, "阅读卡正在生成且已写出 20 字以上", 100);
  record.cardFirstTextAfterExplainMs = Date.now() - tExplain;
  await rp.screenshot(work, join(out, "A1-card-generating.png"));

  const focusA = await focusCardInput();
  await rp.typeText(work, `不是定义，${CORRECTION}`);
  const lenAtEnter = (await card()).turns[0]!.answer.length;
  const tEnter = Date.now();
  await rp.pressEnter(work);
  const timeline: Array<{ ms: number; len: number; status: string }> = [];
  let after1500: CardState | null = null;

  while (Date.now() - tEnter < 2600) {
    const s = await card();
    timeline.push({ ms: Date.now() - tEnter, len: s.turns[0]?.answer.length ?? 0, status: s.turns[0]?.status ?? "" });

    if (!after1500 && Date.now() - tEnter >= 1500) after1500 = s;
    await sleep(100);
  }

  await rp.screenshot(work, join(out, "A2-card-after-enter.png"));
  const reqA1 = readingRequestsWith(CORRECTION, tEnter)[0];
  const lenAt1s = [...timeline].reverse().find((p) => p.ms <= 1000)?.len ?? lenAtEnter;
  const lenEnd = timeline.at(-1)?.len ?? lenAtEnter;
  check("A1", "阅读卡：生成中按 Enter 发出纠正，1.5 s 内模型收到含「我想知道为什么」的请求", !!reqA1 && reqA1.at - tEnter <= 1500,
    { requestAfterEnterMs: reqA1 ? reqA1.at - tEnter : null, focus: focusA, readingRequestsSoFar: captured.filter((c) => c.reading).length });
  check("A2", "阅读卡：Enter 后 1 s 内旧定义停止变长", lenEnd === lenAt1s,
    { lenAtEnter, lenAt1s, lenAt2600ms: lenEnd, statusAt2600ms: timeline.at(-1)?.status ?? null });
  record.A_afterEnter = { textareaStillHolds: after1500?.textarea ?? null, hintVisible: after1500 ? !after1500.hint.hidden : null, hintText: after1500?.hint.text ?? null, sendButtonLabel: after1500?.sendLabel ?? null, turns: after1500?.turns.length ?? null };
  console.log("INFO A after Enter", JSON.stringify(record.A_afterEnter));

  // 两步绕行：点停止，再按 Enter。
  const stopPoint = await until(async () => (await card()).sendLabel === "停止回答" ? cardPoint(".send") : undefined, 3_000, "停止键");
  const tStop = Date.now();
  await mouseClick(stopPoint);
  const stopped = await until(async () => { const s = await card(); return s.turns[0]?.status.includes("已停止") ? s : undefined; }, 8_000, "阅读卡显示已停止", 100);
  record.cardStopMs = Date.now() - tStop;
  const stoppedLen = stopped.turns[0]!.answer.length;
  await rp.screenshot(work, join(out, "A3-card-after-stop.png"));
  const focusB = await focusCardInput();
  const draftAfterStop = (await card()).textarea;
  record.A_draftAfterStop = draftAfterStop;

  if (!draftAfterStop.includes(CORRECTION)) await rp.typeText(work, `不是定义，${CORRECTION}`);
  const tSend2 = Date.now();
  await rp.pressEnter(work);
  const reqA3 = await until(async () => readingRequestsWith(CORRECTION, tSend2)[0], 8_000, "停止后再发的纠正请求").catch(() => undefined);
  const doneA = await until(async () => {
    const s = await card();
    const t = s.turns[1];

    return t && t.answer.includes("新原因") && !/正在/.test(t.status) ? s : undefined;
  }, 20_000, "纠正后的新回答写完", 150).catch(() => undefined);
  // 一直看到旧回答在服务端写完为止：期间旧回答不能再变长。
  const cardOldStart = captured.find((c) => c.reading)!.at;
  const cardOldEnd = Math.max(Date.now() + 2500, oldStreamEnd(cardOldStart, CARD_OLD, 150));
  let oldMaxAfterStop = stoppedLen;

  while (Date.now() < cardOldEnd) {
    oldMaxAfterStop = Math.max(oldMaxAfterStop, (await card()).turns[0]?.answer.length ?? 0);
    await sleep(250);
  }

  record.cardWatchedUntilOldStreamEndMs = cardOldEnd - tStop;
  const finalA = await card();
  await rp.screenshot(work, join(out, "A4-card-done.png"));
  record.A_retry = { focus: focusB, requestAfterEnterMs: reqA3 ? reqA3.at - tSend2 : null, newAnswerDone: !!doneA, finalTurns: finalA.turns.map((t) => ({ question: t.question, answerChars: t.answer.length, answerHead: t.answer.slice(0, 80), status: t.status })) };

  let a3Detail: Json = { request: false };
  let a4Pass = false;
  let a4Detail: Json = { request: false };

  if (reqA3) {
    const content = textOf(reqA3.messages.find((m) => m.role === "user")?.content);
    let parsed: { source?: { text?: string; surrounding?: string }; conversation?: Array<{ question: string; answer: string; state: string }> } = {};

    try { parsed = JSON.parse(content); } catch { /* 不是 JSON 时下面按原文判断 */ }
    a3Detail = { inSourceText: !!parsed.source?.text?.includes(MARKER), inSurrounding: !!parsed.source?.surrounding?.includes(MARKER), anywhere: content.includes(MARKER) };
    const prior = parsed.conversation?.[0];
    a4Pass = prior?.state === "stopped" && !!prior.answer && CARD_OLD.startsWith(prior.answer) && parsed.conversation?.at(-1)?.question.includes(CORRECTION) === true;
    a4Detail = { turns: (parsed.conversation ?? []).map((t) => ({ question: t.question.slice(0, 40), state: t.state, answerChars: t.answer.length })), priorIsPrefixOfOld: !!prior?.answer && CARD_OLD.startsWith(prior.answer) };
  }

  check("A3", "阅读卡：停止后再发，新请求到达且含段落标记句", !!reqA3 && reqA3.messages.some((m) => textOf(m.content).includes(MARKER)), a3Detail);
  check("A4", "阅读卡：新请求里带上一轮并标为 stopped", a4Pass, a4Detail);
  const oldFinal = finalA.turns[0]?.answer ?? "";
  const newFinal = finalA.turns[1]?.answer ?? "";
  check("A5", "阅读卡：停止后旧回答不再变长，新回答里没有旧回答的迟到片段", oldFinal.length === stoppedLen && oldMaxAfterStop === stoppedLen && !newFinal.includes("旧定义") && !finalA.text.includes(CARD_OLD_TAIL) && finalA.turns.length === 2,
    { stoppedLen, oldMaxAfterStop, oldLenAtEnd: oldFinal.length, newHasOldText: newFinal.includes("旧定义"), oldTailAnywhere: finalA.text.includes(CARD_OLD_TAIL), turns: finalA.turns.length });
  check("A6", "阅读卡：请求不带工具（按设计，仅记录）", !!reqA3 && !reqA3.tools, { tools: reqA3?.tools ?? null, note: "agent/src/session.ts streamReading: 没有工具" });

  // ═════════ Segment B：侧栏 ═════════
  // 重开文章：阅读卡回到初始状态（选区工具条），用「转入侧栏」把这段带进侧栏。
  await openArticle();
  shadowId = await shadowObject();
  await selectPara();
  const transfer = await until(() => cardPoint('[data-act="transfer"]'), 15_000, "「转入侧栏」按钮显示");
  await sleep(400);
  await mouseClick(transfer);
  const cite = await until(async () => (await rp.evaluate(panel, `(() => { const c = document.querySelector("#ask-cite"); return c && !c.hidden ? c.innerText : null; })()`)) || undefined, 15_000, "侧栏出现引用条").catch(() => null);
  record.B_cite = cite;

  if (!cite) throw new Error("「转入侧栏」后侧栏没有出现引用条 #ask-cite");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "解释这一段");
  const tStart = Date.now();
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn").classList.contains("stopping") && (document.querySelector(".msg.assistant.streaming")?.textContent.length ?? 0) > 20`) || undefined, 30_000, "侧栏旧解释写到一半", 100);
  record.panelFirstTextAfterSendMs = Date.now() - tStart;
  await rp.screenshot(panel, join(out, "B1-panel-streaming.png"));
  await rp.click(panel, "#input");
  await rp.typeText(panel, `不是定义，${CORRECTION}`);
  await until(async () => await rp.evaluate(panel, `!document.querySelector("#steer-send-btn").hidden`) || undefined, 3_000, "插话发送键出现");
  const PANEL_READ = `(() => { const m = document.querySelector("#messages"); const t = m?.innerText ?? ""; return { oldCount: (t.match(/旧解释第/g) ?? []).length, why: t.includes("新原因"), tail: t.includes(${JSON.stringify(PANEL_OLD_TAIL)}) }; })()`;
  const tClick = Date.now();
  await rp.click(panel, "#steer-send-btn");
  const samples: Array<{ ms: number; oldCount: number; why: boolean; tail: boolean }> = [];
  let firstWhyMs: number | null = null;
  let doneMs: number | null = null;
  const panelOldStart = captured.find((c) => c.tools && c.messages.some((m) => m.role === "user" && textOf(m.content).includes("解释这一段")))?.at ?? tStart;
  // 一直看到旧解释在服务端写完为止，迟到片段只可能在这之前出现。
  const panelOldEnd = oldStreamEnd(panelOldStart, PANEL_OLD, 200);

  while (Date.now() - tClick < 40_000) {
    const s = await rp.evaluate(panel, PANEL_READ);
    samples.push({ ms: Date.now() - tClick, ...s });

    if (s.why) firstWhyMs ??= Date.now() - tClick;
    const done = await rp.evaluate(panel, `!!document.querySelector(".answer-actions") && !document.querySelector("#send-btn").classList.contains("stopping")`);

    if (done && firstWhyMs !== null && doneMs === null) {
      doneMs = Date.now() - tClick;
      await rp.screenshot(panel, join(out, "B2-panel-after-steer.png"));
    }

    if (doneMs !== null && Date.now() > Math.max(panelOldEnd, tClick + doneMs + 3000)) break;
    await sleep(200);
  }

  record.B_doneAfterClickMs = doneMs;
  record.B_watchedUntilOldStreamEndMs = panelOldEnd - tClick;
  await rp.screenshot(panel, join(out, "B3-panel-done.png")); if (process.env.DUMP_DOM) await writeFile(join(out, "B3-panel-done.html"), String(await rp.evaluate(panel, "document.documentElement.outerHTML")));
  const reqB = captured.find((c) => c.tools && c.at >= tClick && c.messages.some((m) => m.role === "user" && textOf(m.content).includes(CORRECTION)));
  const at1s = [...samples].reverse().find((s) => s.ms <= 1000)?.oldCount ?? 0;
  const grewAfter1s = samples.some((s) => s.ms > 1000 && s.oldCount > at1s);
  const lastOldGrowthMs = samples.reduce<number | null>((acc, s, i) => (i > 0 && s.oldCount > samples[i - 1]!.oldCount ? s.ms : acc), null);
  const modelRecord = model.requests.find((r) => r.tools && r.rule === CORRECTION);
  check("B1", "侧栏：插话后 1.5 s 内模型收到含「我想知道为什么」的请求，且旧解释 1 s 内停止变长", !!reqB && reqB.at - tClick <= 1500 && !grewAfter1s,
    { requestAfterClickMs: reqB ? reqB.at - tClick : null, firstNewTextVisibleMs: firstWhyMs, modelFirstTextAfterClickMs: modelRecord?.firstTextAt ? modelRecord.firstTextAt - tClick : null, oldCountAtClick: samples[0]?.oldCount ?? null, oldCountAt1s: at1s, grewAfter1s, lastOldGrowthMs });

  if (reqB) {
    const users = reqB.messages.map((m, i) => ({ i, role: m.role, text: textOf(m.content) })).filter((m) => m.role === "user");
    const newest = [...users].reverse().find((m) => m.text.includes(CORRECTION))!;
    const history = users.filter((m) => m.i < newest.i);
    const anywhere = reqB.messages.some((m) => textOf(m.content).includes(MARKER));
    check("B2", "侧栏：纠正请求仍带段落标记句", anywhere,
      { inNewestUserMessage: newest.text.includes(MARKER), inEarlierUserMessage: history.some((m) => m.text.includes(MARKER)), earlierWithSelectedBlock: history.some((m) => m.text.includes("[User's selected text]") && m.text.includes(MARKER)), newestHead: newest.text.slice(0, 200) });
    check("B3", "侧栏：最新用户消息里有 [User's selected text]", newest.text.includes("[User's selected text]"), { newestChars: newest.text.length, newestHasPageObservation: newest.text.includes("FRESH PAGE OBSERVATION"), markerOnlyInsideObservation: newest.text.includes(MARKER) && newest.text.indexOf(MARKER) > newest.text.indexOf("FRESH PAGE OBSERVATION") && newest.text.includes("FRESH PAGE OBSERVATION") });
  } else {
    check("B2", "侧栏：纠正请求仍带段落标记句", false, { request: null });
    check("B3", "侧栏：最新用户消息里有 [User's selected text]", false, { request: null });
  }

  const view = await rp.evaluate(panel, `(() => {
    const users = [...document.querySelectorAll("#messages .msg.user")];
    const chipsOf = (b) => { const n = b.nextElementSibling; return n && n.matches(".ctx-chips") ? [...n.querySelectorAll(".ctx-chip")].map((c) => c.innerText.trim()) : []; };
    const assistants = [...document.querySelectorAll("#messages .msg.assistant")];
    const all = [...document.querySelector("#messages").children];
    const lastNew = [...all].reverse().find((n) => n.innerText?.includes("新原因"));
    const afterNew = lastNew ? all.slice(all.indexOf(lastNew) + 1).map((n) => n.innerText ?? "").join("\\n") : null;
    return {
      users: users.map((b) => ({ text: b.innerText.slice(0, 60), chips: chipsOf(b) })),
      lastAssistant: assistants.at(-1)?.innerText.slice(0, 200) ?? null,
      assistantCount: assistants.length,
      afterNewHasOld: afterNew === null ? null : afterNew.includes("旧解释"),
      tail: document.querySelector("#messages").innerText.includes(${JSON.stringify(PANEL_OLD_TAIL)}),
      steerTag: document.querySelector(".steer-tag")?.textContent ?? null,
      errors: [...document.querySelectorAll(".msg.error")].map((e) => e.textContent),
    };
  })()`);
  record.B_view = view;
  const correctionBubble = view.users.find((u: { text: string }) => u.text.includes(CORRECTION));
  check("B4", "侧栏：纠正气泡下显示引用条（「…」）", !!correctionBubble?.chips.some((c: string) => c.includes("「")), { correctionChips: correctionBubble?.chips ?? null, firstBubbleChips: view.users[0]?.chips ?? null });
  const whyAt = firstWhyMs ?? Number.POSITIVE_INFINITY;
  const oldGrewAfterNew = samples.some((s, i) => i > 0 && s.ms > whyAt && s.oldCount > samples[i - 1]!.oldCount);
  const tailEverSeen = samples.some((s) => s.tail);
  check("B5", "侧栏：新回答写完后没有旧解释的迟到片段", !!view.lastAssistant?.includes("新原因") && !view.lastAssistant.includes("旧解释") && view.afterNewHasOld === false && !view.tail && !oldGrewAfterNew && !tailEverSeen,
    { oldGrewAfterNew, tailEverSeen, samples: samples.length, lastAssistantHead: view.lastAssistant, afterNewHasOld: view.afterNewHasOld, oldTailAnywhere: view.tail, steerTag: view.steerTag, errors: view.errors });
  record.panelOldSamples = samples.filter((_, i) => i % 10 === 0).map((s) => `${s.ms}:${s.oldCount}${s.why ? "+why" : ""}`).join(" ");
} catch (error) {
  flowError = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1500);
  console.error("FLOW ERROR", flowError);
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({
    checks,
    flowError,
    record,
    requests: captured.map(excerpt),
    modelRequests: model.requests,
  }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>((done) => site.close(() => done()));
}

console.log("\n| id | result | check |\n|---|---|---|");

for (const c of checks) console.log(`| ${c.id} | ${c.pass ? "PASS" : "FAIL"} | ${c.name} |`);
console.log(`\nflowError: ${flowError ?? "none"}\nevidence: ${out}`);

if (flowError) process.exitCode = 1;
