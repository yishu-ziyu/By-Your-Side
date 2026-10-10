/**
 * 阅读卡里中途改口：解释还在写时，用户在卡片输入框打一句改口并按回车。
 * 旧回答马上停在原处（折叠、可展开），新回答立刻开始，仍对着同一段（docs/evals/20261010-reading-companion-check.md 的 T1、R1）。
 * 由诊断探针 scripts/probes/reading-correction.mts 的 A 段改成用例。
 *
 * 真扩展、隔离无头 Chrome、本机练习文章、本机脚本模型；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/reading-correction.mts --headless
 *
 * 判据只读模型收到的请求原文和阅读卡里用户看得到的界面：
 *   请求  回车后 1.5 s 内模型收到含改口原话的请求，请求里有段落标记句、有一轮 state 为 stopped 的旧回答。
 *   取消  回车后 1.5 s 内，模型那边旧请求的连接没写完就关了（产品真的取消了旧请求，不只是界面不再显示）。
 *   停止  旧回答在回车后 1 s 内停止变长，一直看到旧回答在服务端写完为止也不再变长；新回答里没有旧回答的文字。
 *   界面  旧回答显示「已停止，内容已保留」并折叠，「展开/收起」能用、点完焦点不丢、不在状态播报区里；新回答带「已改口」；段落高亮回车前后都在。
 *   按钮  生成中输入框空时是停止键；输入了文字时是发送键（改口）。
 * 失败方式：生成中回车被吞掉（T1 之前的 main），请求、停止、界面、按钮都失败；改口时不取消旧请求，取消一项失败。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-reading-correction`);

await mkdir(out, { recursive: true });

// ── 练习文章：#para 开头是全页唯一的标记句 ──
const MARKER = "The lighthouse keeper logged every storm in violet ink so that later sailors could trust the record.";

const FILLER = "Coastal towns kept their own weather books long before national services existed. Harbour masters compared notes each spring to decide which channels were still safe.";

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Weather books of the coast</title>
<style>body{font:17px/1.7 Georgia,serif;max-width:640px;margin:40px 24px;padding:0}</style></head><body>
<h1>Weather books of the coast</h1>
<p id="p0">${FILLER}</p>
<p id="para"><span id="para-text">${MARKER} The colour was chosen because ordinary black ink faded in salt air within a few winters, while the violet dye stayed legible for decades.</span></p>
<p id="p2">${FILLER}</p>
</body></html>`;

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ARTICLE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const articleUrl = `http://127.0.0.1:${siteAddress(site).port}/article`;

// ── 脚本模型：改口规则放第一位，因为改口请求的 JSON 里同时含旧问题与改口原话 ──
const CORRECTION = "我想知道为什么";

const OLD_TAIL = "旧定义的最后一句话到此为止。";

const OLD = Array.from({ length: 160 }, (_, i) => `旧定义第${String(i).padStart(3, "0")}句。`).join("") + OLD_TAIL;

const WHY = "新原因：作者用紫色墨水，是因为普通黑墨水在海风里几个冬天就褪色，而紫色染料几十年后仍清楚可读。";

const READING_SYSTEM = "你是用户在网页旁的阅读助手";

const HIGHLIGHT = "by-your-side-reading";

type Msg = { role: string; content?: string | Array<{ type?: string; text?: string }> | null };

type Captured = { at: number; reading: boolean; messages: Msg[] };

const textOf = (c: Msg["content"]): string => Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : c ?? "";

const captured: Captured[] = [];

const OLD_DELAY_MS = 150;

const model = await startScriptedModel([
  { match: CORRECTION, steps: [{ text: WHY }] },
  { match: "解释这段选中的文字", steps: [{ text: OLD, chunkDelayMs: OLD_DELAY_MS }] },
], undefined, (payload) => {
  const messages = (payload.messages ?? []) as Msg[];
  captured.push({ at: Date.now(), reading: messages.some((m) => m.role === "system" && textOf(m.content).startsWith(READING_SYSTEM)), messages });
});

const rp = await launchRealPath();

type Check = { name: string; pass: boolean; detail: Json };

const checks: Check[] = [];

const record: Record<string, Json> = {};

const check = (name: string, pass: boolean, detail: Json) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

type DomNode = { nodeName: string; backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

type Turn = { question: string; tag: string; answer: string; status: string; folded: boolean; clipped: boolean; fold: string | null; expanded: string | null; foldInStatus: boolean; foldFocused: boolean };

type CardState = { turns: Turn[]; textarea: string; focused: boolean; sendLabel: string | null; sendIcon: "stop" | "send" | null; text: string };

const CARD_STATE = `function(){
  const turns=[...this.querySelectorAll('.turn')].map(t=>{const a=t.querySelector('.answer');const f=t.querySelector('.fold');return {question:t.querySelector('.question')?.textContent??'',tag:t.querySelector('.question .tag')?.textContent??'',answer:a?.textContent??'',status:t.querySelector('.status')?.textContent??'',folded:t.classList.contains('folded'),clipped:!!a&&a.scrollHeight>a.clientHeight+4,fold:f&&!f.hidden?f.textContent:null,expanded:f?.getAttribute('aria-expanded')??null,foldInStatus:!!t.querySelector('[role=status] button'),foldFocused:!!f&&this.activeElement===f};});
  const ta=this.querySelector('textarea');
  const send=this.querySelector('.send');
  const svg=send?.querySelector('svg');
  return {turns,textarea:ta?.value??'',focused:this.activeElement===ta,sendLabel:send?.getAttribute('aria-label')??null,sendIcon:svg?(svg.querySelector('rect')?'stop':'send'):null,text:this.querySelector('.surface')?.innerText??''};
}`;

try {
  const workTargetId = (await rp.targets()).find((t) => t.url === "about:blank")!.targetId;
  const work = await rp.attach(workTargetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("DOM.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: articleUrl }, work);
  await until(async () => (await rp.evaluate(work, `location.href === ${JSON.stringify(articleUrl)} && document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "练习文章与阅读卡宿主");

  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  const settings = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  record.settings = { save: settings.saveStatus, test: settings.testStatus };
  await rp.cdp.send("Target.closeTarget", { targetId: settings.settingsTargetId }).catch(() => {});
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);
  // 扩展安装时会给已打开的网页补装一份网页脚本（background/reinject.ts），可能和第一次打开文章撞在一起，页里就有两份阅读卡脚本。
  // 设置完再重新打开文章，页里只有一份，和用户平常打开网页一样。
  await rp.cdp.send("Page.navigate", { url: articleUrl }, work);
  await until(async () => (await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("[data-sideagent-ask]")`)) || undefined, 15_000, "重新打开练习文章");

  // ── 阅读卡在封闭 shadow root 里：CDP 穿透拿到它，再在里面执行函数 ──
  // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
  const find = (n: DomNode): DomNode | null => {
    if ((n.attributes ?? []).includes("data-sideagent-ask") && n.shadowRoots?.length) return n.shadowRoots[0]!;

    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) { const hit = find(c); if (hit) return hit; }

    return null;
  };
  const shadow = find(root);

  if (!shadow) throw new Error("找不到阅读卡 shadow root");
  const shadowId = String((await rp.cdp.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, work)).object.objectId);
  const inCard = async <T,>(fn: string): Promise<T> => {
    // SAFETY: callFunctionOn 以 returnByValue 返回函数结果。
    const reply = await rp.cdp.send("Runtime.callFunctionOn", { objectId: shadowId, functionDeclaration: fn, returnByValue: true }, work);

    if (reply.exceptionDetails) throw new Error(`阅读卡脚本出错：${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);

    return reply.result.value as T;
  };
  const card = () => inCard<CardState>(CARD_STATE);
  const cardPoint = (selector: string) => inCard<{ x: number; y: number } | null>(`function(){const e=this.querySelector(${JSON.stringify(selector)});if(!e||e.closest('[hidden]'))return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null}`);
  const mouseClick = async (point: { x: number; y: number }) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point }, work);
  };
  const highlighted = async () => Boolean(await rp.evaluate(work, `CSS.highlights?.has(${JSON.stringify(HIGHLIGHT)}) ?? false`));

  // ── 划选这一段，点「解释」，等旧解释写到一半 ──
  // SAFETY: 页面脚本返回段落文字首尾坐标。
  const span = await rp.evaluate(work, `(() => { document.querySelector("#para").scrollIntoView({block:"center"}); const r = document.querySelector("#para-text").getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1, y: span.y1 }, work);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, work);

  for (let i = 1; i <= 10; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 10, y: span.y1 + ((span.y2 - span.y1) * i) / 10, button: "left", buttons: 1 }, work);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, work);
  const selected = String(await rp.evaluate(work, "getSelection().toString()"));

  if (!selected.includes(MARKER)) throw new Error(`划选没有覆盖标记句：${selected.slice(0, 120)}`);
  const explain = await until(() => cardPoint('[data-act="explain"]'), 15_000, "页内「解释」按钮显示");
  await sleep(400);
  await mouseClick(explain);
  await until(async () => {
    const t = (await card()).turns[0];

    // 写出几行再改口：旧回答要比折叠后的高度长，折叠才看得出来。
    return t && t.status.includes("正在生成") && t.answer.length > 120 ? t : undefined;
  }, 30_000, "阅读卡正在生成且已写出 120 字以上", 100);
  const oldStart = captured.find((c) => c.reading)!.at;
  const highlightBefore = await highlighted();
  const emptyInput = await card();
  await rp.screenshot(work, join(out, "1-generating.png"));

  // ── 点进输入框，打改口 ──
  const inputPoint = await until(() => cardPoint("textarea"), 5_000, "阅读卡输入框可见");
  await mouseClick(inputPoint);
  await until(async () => (await card()).focused || undefined, 3_000, "阅读卡输入框获得焦点");
  await rp.typeText(work, `不是定义，${CORRECTION}`);
  const typed = await until(async () => { const s = await card(); return s.textarea.includes(CORRECTION) ? s : undefined; }, 3_000, "改口已输入");
  check("按钮：生成中输入框空时是停止键，输入改口后是发送键",
    emptyInput.sendIcon === "stop" && emptyInput.sendLabel === "停止回答" && typed.sendIcon === "send" && !!typed.sendLabel?.includes("改口") && typed.turns[0]!.status.includes("正在生成"),
    { empty: { icon: emptyInput.sendIcon, label: emptyInput.sendLabel }, withText: { icon: typed.sendIcon, label: typed.sendLabel }, stillGenerating: typed.turns[0]!.status });
  await rp.screenshot(work, join(out, "2-typed.png"));

  // ── 回车：从这一刻起看旧回答，一直看到它在服务端本来会写完的时刻（每段 12 字，加 1.5 s 余量） ──
  const lenAtEnter = (await card()).turns[0]!.answer.length;
  const tEnter = Date.now();
  await rp.pressEnter(work);
  const watchUntil = Math.max(tEnter + 4000, oldStart + Math.ceil(OLD.length / 12) * OLD_DELAY_MS + 1500);
  const timeline: Array<{ ms: number; len: number }> = [];

  while (Date.now() < watchUntil) {
    timeline.push({ ms: Date.now() - tEnter, len: (await card()).turns[0]?.answer.length ?? 0 });

    if (timeline.length === 10) await rp.screenshot(work, join(out, "3-after-enter.png"));
    await sleep(100);
  }

  record.watchedAfterEnterMs = watchUntil - tEnter;
  const lenAt1s = [...timeline].reverse().find((p) => p.ms <= 1000)?.len ?? lenAtEnter;
  const lenMaxAfter1s = Math.max(lenAt1s, ...timeline.filter((p) => p.ms > 1000).map((p) => p.len));

  // ── 旧请求被取消：模型那边的连接没写完就关了。只看界面分不出来，因为界面也会丢掉旧请求的迟到片段。 ──
  const oldRequest = model.requests.find((r) => r.rule === "解释这段选中的文字");
  check("取消：回车后 1.5 s 内旧请求的连接没写完就关了",
    !!oldRequest?.closedAt && oldRequest.closedAt - tEnter <= 1500 && oldRequest.finished === false,
    { closedAfterEnterMs: oldRequest?.closedAt ? oldRequest.closedAt - tEnter : null, finished: oldRequest?.finished ?? null });

  // ── 请求 ──
  const req = captured.find((c) => c.reading && c.at >= tEnter && c.messages.some((m) => textOf(m.content).includes(CORRECTION)));
  let requestDetail: Json = { request: null };
  let requestPass = false;

  if (req) {
    const content = textOf(req.messages.find((m) => m.role === "user")?.content);
    let parsed: { source?: { text?: string }; conversation?: Array<{ question: string; answer: string; state: string }> } = {};

    try { parsed = JSON.parse(content); } catch { /* 不是 JSON 时下面的判据都不成立 */ }
    const prior = parsed.conversation?.[0];
    const marker = !!parsed.source?.text?.includes(MARKER);
    const stopped = prior?.state === "stopped" && !!prior.answer && OLD.startsWith(prior.answer);
    const last = parsed.conversation?.at(-1)?.question.includes(CORRECTION) === true;
    requestPass = req.at - tEnter <= 1500 && marker && stopped && last;
    requestDetail = { requestAfterEnterMs: req.at - tEnter, markerInSource: marker, priorStoppedPrefixOfOld: stopped, lastQuestionIsCorrection: last, turns: (parsed.conversation ?? []).map((t) => ({ question: t.question.slice(0, 40), state: t.state, answerChars: t.answer.length })) };
  }

  check("请求：回车后 1.5 s 内模型收到改口，带这一段和已停止的上一轮", requestPass, requestDetail);

  // ── 停止 ──
  const done = await until(async () => {
    const s = await card();
    const t = s.turns[1];

    return t && t.answer.includes("新原因") && !/正在/.test(t.status) ? s : undefined;
  }, 10_000, "改口后的新回答写完", 150).catch(() => undefined);
  const final = done ?? await card();
  const oldFinal = final.turns[0]?.answer ?? "";
  const newFinal = final.turns[1]?.answer ?? "";
  check("停止：旧回答 1 s 内停止变长且之后不再变长，新回答里没有旧回答的文字",
    !!done && lenMaxAfter1s === lenAt1s && oldFinal.length === lenAt1s && !newFinal.includes("旧定义") && !final.text.includes(OLD_TAIL) && final.turns.length === 2,
    { lenAtEnter, lenAt1s, lenMaxAfter1s, oldLenAtEnd: oldFinal.length, newAnswerDone: !!done, newHasOldText: newFinal.includes("旧定义"), oldTailAnywhere: final.text.includes(OLD_TAIL), turns: final.turns.length });
  await rp.screenshot(work, join(out, "4-done.png"));

  // ── 界面：旧回答停住并折叠，展开/收起能用；新回答带「已改口」；高亮还在 ──
  const old = final.turns[0];
  const before = { status: old?.status ?? null, folded: old?.folded ?? false, clipped: old?.clipped ?? false, fold: old?.fold ?? null, expanded: old?.expanded ?? null, foldInStatus: old?.foldInStatus ?? null };
  let opened: Partial<Turn> | null = null;
  let closed: Partial<Turn> | null = null;
  const toggle = async () => {
    const point = await cardPoint(".turn .fold:not([hidden])");

    if (!point) return null;
    await mouseClick(point);
    await sleep(200);
    const t = (await card()).turns[0]!;

    return { folded: t.folded, clipped: t.clipped, fold: t.fold, expanded: t.expanded, foldFocused: t.foldFocused };
  };

  if (before.fold) {
    opened = await toggle();
    await rp.screenshot(work, join(out, "5-unfolded.png"));
    closed = await toggle();
  }

  const highlightAfter = await highlighted();
  // 展开键不在状态播报区里（读屏只念「已停止，内容已保留」），点完焦点还在它上面，aria-expanded 跟着变。
  check("界面：旧回答「已停止，内容已保留」并折叠，展开/收起能用；新回答带「已改口」；高亮回车前后都在",
    before.status === "已停止，内容已保留" && before.folded && before.clipped && before.fold === "展开" && before.expanded === "false" && before.foldInStatus === false
      && opened?.folded === false && opened.clipped === false && opened.fold === "收起" && opened.expanded === "true" && opened.foldFocused === true
      && closed?.folded === true && closed.fold === "展开" && closed.expanded === "false" && closed.foldFocused === true
      && final.turns[1]?.tag === "已改口" && highlightBefore && highlightAfter,
    { old: before, afterFirstClick: opened, afterSecondClick: closed, newTag: final.turns[1]?.tag ?? null, newQuestion: final.turns[1]?.question ?? null, highlightBefore, highlightAfter });
  record.finalTurns = final.turns.map((t) => ({ question: t.question, tag: t.tag, answerChars: t.answer.length, answerHead: t.answer.slice(0, 80), status: t.status, folded: t.folded }));
  record.timeline = timeline.filter((_, i) => i % 5 === 0).map((p) => `${p.ms}:${p.len}`).join(" ");
} catch (error) {
  check("流程完成", false, String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1500));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({
    status: checks.every((c) => c.pass) ? "PASS" : "FAIL",
    dependency: "isolated real extension/offscreen Agent; scripted local model; local practice article",
    checks,
    record,
    requests: captured.map((c) => ({ atMs: c.at, reading: c.reading, messages: c.messages.map((m) => ({ role: m.role, text: textOf(m.content).slice(0, 800) })) })),
    modelRequests: model.requests,
  }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", out }, null, 2));

if (checks.some((c) => !c.pass)) process.exitCode = 1;
