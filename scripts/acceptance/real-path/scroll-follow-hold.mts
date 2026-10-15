/**
 * 回答还在往下写时，用户往上滚一点就停在那里，不被拉回底部；滚回离底部 40px 以内、或发新消息，就重新跟着写。
 *   npx tsx scripts/acceptance/real-path/scroll-follow-hold.mts --headless [--record]
 * 脚本模型慢慢写长回答，全用真实输入事件（CDP 滚轮、按键）：
 * - 写到一半往上滚一格（滚轮 -40、-60、-100；在回答上点一下再按 PageUp）：之后 1.5 秒画面不动，“回到底部”圆钮出来；
 *   再滚回底部，一直跟到写完。
 * - 写完后往上滚一点再发新消息：回到底部，跟着新回答写。
 * - 新回答先思考、再跑一段程序：点开过程块，在过程窗上往上滚，过程窗自己滚、对话区不动，后面的回答照样跟到底。
 * - 停在底部时把侧栏从 400px 拉窄到 300px：仍贴着底部。
 * 不点圆钮：回答还在写时输入框盖住了圆钮的中心，点上去落在输入框上（evidence.json 里的 buttonHit 记着）。
 * docs/evals/20261015-scroll-follow-hold.md。--record：同时录屏到 out/…/scroll.mp4，只给人看，不参与判定。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const record = process.argv.includes("--record");
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-scroll-follow-hold`);

await mkdir(artifacts, { recursive: true });

const TASK = "把这几款扫地机器人的续航和价格逐段比一下";
const AGAIN = "再按噪音从小到大排一遍";
const LONG = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：按售价除以续航，B7 每分钟约 11.9 元，A1 约 12.7 元，C3 约 13.7 元；B7 的尘盒更大，A1 更安静。`).join("\n\n");
// 一整段不分段：它就是浏览器的滚动锚点，侧栏变窄时它在锚点下面变高，画面才会明显漂离底部。
const ONE_PARAGRAPH = LONG.replace(/\n\n/g, "");
const REASONING = Array.from({ length: 30 }, (_, i) => `想法 ${i + 1}：先读评测页里每款的噪音分贝，再和续航放在一起看。`).join("\n");

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>评测合集</title><h1>扫地机器人评测合集</h1>"));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const model = await startScriptedModel([
  { match: TASK, steps: [{ text: LONG, chunkDelayMs: 40 }] },
  { match: AGAIN, steps: [
    { text: "", reasoning: REASONING, thenTool: { name: "browser_run", args: { label: "读评测页", code: "await new Promise((done) => setTimeout(done, 5000)); return 1;" } } },
    { text: ONE_PARAGRAPH, chunkDelayMs: 40 },
  ] },
]);
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;
let stopRecording: (() => Promise<string | null>) | null = null;

type Sample = { t: number; top: number; gap: number; button: boolean; streaming: boolean };

/** answers：这一轮写完时应有几个带操作条的回答；少于它就是还在写。 */
const SAMPLE = (answers: number) => `(() => { const m = document.querySelector("#messages");
  return { top: Math.round(m.scrollTop), gap: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), button: !document.querySelector("#to-bottom").hidden,
    streaming: document.querySelectorAll("#messages .answer-actions").length < ${answers} }; })()`;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  if (record) stopRecording = await recordScreen(rp.cdp, panel, join(artifacts, "scroll.mp4"));

  const sample = async (t0: number, answers: number): Promise<Sample> => ({ t: Date.now() - t0, ...(await rp.evaluate(panel, SAMPLE(answers)) as Omit<Sample, "t">) });
  const center = await rp.evaluate(panel, `(() => { const r = document.querySelector("#messages").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`) as { x: number; y: number };
  const wheel = (deltaY: number, at = center) => rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY }, panel);
  // 对话区不接焦点：先在回答文字上点一下（焦点落到 body，键盘滚动认这个滚动区），再按 PageUp。
  const pageUp = async () => {
    for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: center.x, y: center.y, button: "left", clickCount: 1 }, panel);
    evidence.pageUpFocus = await rp.evaluate(panel, `document.activeElement?.tagName`);
    for (const type of ["rawKeyDown", "keyUp"]) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 }, panel);
  };
  const send = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
  };
  /** 从现在跟到第 answers 个回答写完：开头 200ms 是让开用户输入的那一会儿，之后每次读数都离底部不超过 40px。 */
  const followUntilDone = async (label: string, answers: number) => {
    const t1 = Date.now();
    const followed: Sample[] = [];
    for (let s = await sample(t1, answers); ; s = await sample(t1, answers)) { followed.push(s); if (!s.streaming) break; await sleep(50); }
    evidence[`follow-${label}`] = followed;
    assert.deepEqual(followed.filter((s) => s.t >= 200 && s.gap > 40), [], `${label}：之后一直跟到回答写完`);
    assert.ok(followed.length > 5, `${label}：之后回答还写了一阵，跟随确实被检查到`);
  };

  const rounds: Array<[string, () => Promise<unknown>]> = [["wheel-40", () => wheel(-40)], ["wheel-60", () => wheel(-60)], ["wheel-100", () => wheel(-100)], ["pageup", pageUp]];

  for (const [turn, [label, scrollUp]] of rounds.entries()) {
    if (turn > 0) {
      await rp.click(panel, "#conversation-new");
      await until(async () => (await rp.evaluate(panel, `!document.querySelector("#messages .msg.assistant") && document.querySelector("#send-btn")?.disabled === false`)) || undefined, 10_000, "新对话就绪");
    }

    await send(TASK);
    // 对话区已经能滚、离写完还早时才滚。
    await until(async () => { const s = await sample(0, 1); return s.streaming && s.top > 600; }, 60_000, `${label} 回答写到可滚`, 50);

    const t0 = Date.now();
    const before = await sample(t0, 1);
    await scrollUp();
    const held: Sample[] = [before];
    while (Date.now() - t0 < 1500) { held.push(await sample(t0, 1)); await sleep(50); }
    await rp.screenshot(panel, join(artifacts, `held-${label}.png`));
    evidence[label] = held;
    const after = held.slice(1).filter((s) => s.t >= 300);
    const moved = before.top - after[0]!.top;
    assert.ok(after.every((s) => s.streaming), `${label}：滚动后 1.5 秒内回答还在写，不然判不了`);
    assert.ok(moved >= 30, `${label}：真的往上滚了（${moved}px）`);
    assert.ok(after.every((s) => s.top === after[0]!.top && s.gap >= moved - 1), `${label}：停在原处，不被拉回底部：${held.map((s) => `${s.t}ms top=${s.top} gap=${s.gap}`).join(" | ")}`);
    assert.ok(after.every((s) => s.button), `${label}：“回到底部”圆钮出来`);
    const newDot = `(() => { const b = document.querySelector("#to-bottom"); const d = b.querySelector(".to-bottom-dot"); return { hasNew: b.classList.contains("has-new"), dot: d ? new DOMMatrix(getComputedStyle(d).transform).a : 0 }; })()`;
    evidence[`newDot-${label}`] = await until(async () => { const r = await rp.evaluate(panel, newDot); return r.hasNew && r.dot > 0.9 ? r : undefined; }, 3_000, `${label}：下面写出新内容，圆钮带上小点`, 50);

    evidence[`buttonHit-${label}`] = await rp.evaluate(panel, `(() => { const b = document.querySelector("#to-bottom"), r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { rect: [r.x, r.y, r.width, r.height].map(Math.round), hit: hit ? hit.tagName + "#" + hit.id + "." + hit.className : null, ok: !!hit && b.contains(hit) }; })()`);
    await wheel(100_000);
    await followUntilDone(`${label} 滚回底部`, 1);
    assert.equal((await rp.evaluate(panel, newDot)).hasNew, false, `${label}：回到底部后小点消失`);
    await rp.screenshot(panel, join(artifacts, `followed-${label}.png`));
  }

  // 写完后往上滚一点，再发新消息：回到底部重新跟随。
  await sleep(300);
  await wheel(-60);
  await until(async () => (await sample(0, 1)).button || undefined, 3_000, "写完后往上滚一点，圆钮出来");
  await send(AGAIN);
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.user").length === 2`)) || undefined, 10_000, "新消息出现");
  await sleep(250);
  const sent = await sample(0, 2);
  evidence.sent = sent;
  assert.ok(sent.gap <= 40, `发新消息后回到底部（离底部 ${sent.gap}px）`);

  // 过程窗里思考很长、程序还在跑：在过程窗上往上滚。
  // 过程块默认收着，用户点开才是可滚的过程窗。
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#messages details.run-steps:not(.done) > summary")`)) || undefined, 20_000, "过程块出现", 50);
  await rp.click(panel, "#messages details.run-steps:not(.done) > summary");
  // 点开后过程块还在长高：位置连续两次读数不变、滚动到它自己的底部，才在它上面滚。
  type Box = { x: number; y: number; top: number; key: string };
  const readBox = async () => await rp.evaluate(panel, `(() => { const b = [...document.querySelectorAll("#messages .run-body.overflowing")].pop(); if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), top: b.scrollTop,
      key: [r.x, r.y, r.width, r.height, b.scrollTop, b.scrollHeight - b.clientHeight].map(Math.round).join() }; })()`) as Box | null;
  let last: Box | null = null;
  const box = await until(async () => { const now = await readBox(); const ok = now && now.top > 0 && last?.key === now.key ? now : null; last = now; return ok; }, 20_000, "过程窗可滚且停稳", 100);
  const outer = (await sample(0, 2)).top;
  await wheel(-100, box);
  await sleep(300);
  const nested = await rp.evaluate(panel, `({ box: [...document.querySelectorAll("#messages .run-body")].pop().scrollTop, outer: document.querySelector("#messages").scrollTop, answerStarted: document.querySelectorAll("#messages .msg.assistant").length })`) as { box: number; outer: number };
  evidence.nested = { before: { box: box.top, outer }, after: nested };
  assert.ok(nested.box < box.top && nested.outer === outer, `在过程窗上滚动只滚过程窗，对话区不动：${JSON.stringify(evidence.nested)}`);
  await followUntilDone("过程窗里滚过", 2);
  await rp.screenshot(panel, join(artifacts, "followed-after-nested.png"));

  // 停在底部时把侧栏拉窄：仍贴着底部。
  const height = await rp.evaluate(panel, "window.innerHeight") as number;
  const resized: Sample[] = [];
  for (const width of [400, 300]) {
    await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, panel);
    await sleep(400);
    resized.push(await sample(0, 2));
  }
  evidence.resized = resized;
  await rp.screenshot(panel, join(artifacts, "narrowed.png"));
  // 浏览器的滚动锚定会吃掉大部分漂移，无头里只漂十几像素，所以要求严丝合缝贴着底部。
  assert.ok(resized.every((s) => s.gap <= 1), `侧栏 400→300px 后仍贴着底部：${resized.map((s) => s.gap).join("/")}px`);
  await rp.cdp.send("Emulation.clearDeviceMetricsOverride", {}, panel);
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
} finally {
  if (stopRecording) evidence.video = await stopRecording();
  await writeFile(join(artifacts, "evidence.json"), JSON.stringify({ error, ...evidence }, null, 2));
  await rp.close();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(error ? `FAIL ${error}` : "PASS scroll-follow-hold", "\n证据：", artifacts);
if (error) process.exitCode = 1;
