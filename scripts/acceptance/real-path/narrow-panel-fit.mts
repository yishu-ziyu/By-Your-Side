/**
 * 窄侧栏不遮不切（docs/evals/20261015-narrow-panel-fit.md）。
 *   npx tsx scripts/acceptance/real-path/narrow-panel-fit.mts --headless        （OUT=/dir 可改产物目录）
 * 只装扩展、隔离构建、本机脚本模型（连续 429 出错误卡）、本机练习页。
 * 在 400、320、280 px 三个宽度上，判据只看侧栏里用户看得到的东西：
 *   一 滚到底后，最后一张卡里每个按钮整个落在对话区可见范围内，按钮中心点到的就是这个按钮（没被输入框盖住）。
 *   二 上翻后出现的「回到底部」整个在对话区里，中心点到的就是它。
 *   三 输入框底栏一行放下：底栏和其中各组 scrollWidth <= clientWidth，按钮在同一行、互不重叠；400 px 时能看到的按钮，窄了也都还在；
 *      模型按钮不被挤没，读屏名字是模型全名。空闲时量一遍，任务在跑（接管、插话发送、停止都在）时再量一遍。
 * 产物：OUT/<宽度>-bottom.png、OUT/<宽度>-jump.png、OUT/<宽度>-running.png、OUT/result.json。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const OUT = process.env.OUT ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-narrow-panel-fit`);
await mkdir(OUT, { recursive: true });

const WIDTHS = [400, 320, 280];
const LONG = "窄栏长回答";
const FAIL = "窄栏出错";
const SLOW = "窄栏慢任务";
const longAnswer = Array.from({ length: 14 }, (_, i) => `${i + 1}. 第 ${i + 1} 点：一段用来撑长对话的说明文字，让对话区需要滚动。`).join("\n");
const limited = { status: 429, body: JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }) };
const model = await startScriptedModel([
  { match: LONG, steps: [{ text: longAnswer }] },
  { match: FAIL, steps: Array.from({ length: 6 }, () => limited) },
  // 第二步让模型晚 30 秒才回：这段时间任务在跑，底栏露出「接管」和停止。
  { match: SLOW, steps: [{ text: "", thenTool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} }, delayMs: 30_000 }, { text: "看完了。" }] },
]);
const site = createServer((_q, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>示例耳机</title><h1>示例耳机 ¥299</h1>"));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));

const evidence: Record<string, Json> = {};
let failure: string | null = null;
const rp = await launchRealPath();
let panel = "";
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  // 名字够长，窄宽下模型按钮要收短才放得下。
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "openai-codex/gpt-6-luna-preview", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "k" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "ready");
  const resize = async (width: number) => { await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 640, deviceScaleFactor: 2, mobile: false }, panel); await sleep(500); };
  await resize(400);
  await rp.cdp.send("Page.bringToFront", {}, work);
  const send = async (ask: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, ask); await rp.pressEnter(panel); };

  await send(LONG);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages").textContent.includes("第 14 点")`) || undefined, 60_000, "long answer");
  await sleep(800);
  await send(FAIL);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector(".error-card:not(.is-retired) .error-card-actions button")`) || undefined, 90_000, "error card");
  await sleep(1200);

  /** 最后一张卡里每个看得见的按钮：是否整个在对话区可见范围内、中心点到的是不是它自己。 */
  const cardButtons = () => rp.evaluate(panel, `(() => {
    const m = document.querySelector("#messages");
    const box = m.getBoundingClientRect();
    const view = { top: box.top, bottom: box.top + m.clientHeight, left: box.left, right: box.left + m.clientWidth };
    const card = [...m.children].filter(el => el.getClientRects().length).at(-1);
    return { card: card.className, view, buttons: [...card.querySelectorAll("button")].filter(b => b.getClientRects().length).map(b => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: b.textContent.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
        inside: r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5 && r.left >= view.left - 0.5 && r.right <= view.right + 0.5,
        hit: !!hit && (hit === b || b.contains(hit)), hitBy: hit ? (hit.id ? "#" + hit.id : hit.className || hit.tagName) : null };
    }) };
  })()`) as Promise<{ card: string; buttons: Array<{ text: string; inside: boolean; hit: boolean } & Record<string, Json>> } & Record<string, Json>>;
  /** 底栏：有没有横向溢出、按钮是不是一行、看得见哪些按钮。 */
  const bar = () => rp.evaluate(panel, `(() => {
    const bar = document.querySelector("#composer-bar");
    const rows = [bar, ...bar.querySelectorAll(":scope > *, #composer-bar-inner > *")].filter(el => el.getClientRects().length);
    const overflow = rows.filter(el => el.scrollWidth > el.clientWidth).map(el => (el.id || el.className) + " " + el.scrollWidth + ">" + el.clientWidth);
    const b = bar.getBoundingClientRect();
    const items = [...bar.querySelectorAll("button")].filter(el => el.getClientRects().length && el.getBoundingClientRect().width > 0);
    const mids = items.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
    const outside = items.filter(el => { const r = el.getBoundingClientRect(); return r.left < b.left - 0.5 || r.right > b.right + 0.5; }).map(el => el.id || el.className);
    const rects = items.map(el => [el.id || el.className, el.getBoundingClientRect()]);
    const overlaps = rects.flatMap(([a, r], i) => rects.slice(i + 1).filter(([, q]) => Math.min(r.right, q.right) - Math.max(r.left, q.left) > 0.5).map(([c]) => a + "×" + c));
    const chip = document.querySelector("#think-chip");
    return { overflow, outside, overlaps, oneRow: Math.max(...mids) - Math.min(...mids) <= 2, visible: items.map(el => el.id || el.className), height: Math.round(b.height),
      chipWidth: Math.round(chip.getBoundingClientRect().width), chipName: chip.getAttribute("aria-label"),
      nameWidth: (() => { const n = chip.querySelector(".think-model"); return n && n.getClientRects().length ? Math.round(n.getBoundingClientRect().width) : null; })() };
  })()`) as Promise<{ overflow: string[]; outside: string[]; overlaps: string[]; oneRow: boolean; visible: string[]; height: number; chipWidth: number; chipName: string | null; nameWidth: number | null }>;
  /** 底栏各项判据：不溢出、不出框、不互相压、一行、和 400 px 时同一组按钮、模型按钮不被挤没且读得出全名。 */
  const checkBar = (tag: string, composer: Awaited<ReturnType<typeof bar>>, wide: string[]) => {
    assert.deepEqual(composer.overflow, [], `三 ${tag}：底栏没有横向溢出`);
    assert.deepEqual(composer.outside, [], `三 ${tag}：底栏按钮都在底栏里`);
    assert.deepEqual(composer.overlaps, [], `三 ${tag}：底栏按钮互不重叠`);
    assert.ok(composer.oneRow, `三 ${tag}：底栏按钮在同一行：${JSON.stringify(composer)}`);
    assert.deepEqual(composer.visible, wide, `三 ${tag}：400 px 时能看到的按钮都还在`);
    assert.ok(composer.chipWidth >= 24, `三 ${tag}：模型按钮没被挤没（宽 ${composer.chipWidth}px）`);
    // 名字要么完整收起只留图标，要么至少露出几个字；被挤成一两个字母的半截名字认不出是哪个模型。
    assert.ok(composer.nameWidth === null || composer.nameWidth >= 48, `三 ${tag}：模型名不被挤成几个字母（露出 ${composer.nameWidth}px）`);
    assert.match(composer.chipName ?? "", /gpt-6-luna-preview/, `三 ${tag}：模型按钮的名字说出全名`);
  };
  const jump = () => rp.evaluate(panel, `(() => {
    const btn = document.querySelector("#to-bottom");
    if (!btn || btn.hidden) return null;
    const f = document.querySelector("#messages").getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), frameBottom: Math.round(f.bottom), inside: r.top >= f.top && r.bottom <= f.bottom && r.right <= f.right,
      hit: !!hit && (hit === btn || btn.contains(hit)), hitBy: hit ? (hit.id ? "#" + hit.id : hit.className || hit.tagName) : null };
  })()`) as Promise<{ inside: boolean; hit: boolean } & Record<string, Json> | null>;

  let wide: string[] = [];
  // 三个宽度都量完再判，改前改后都有整套截图。
  const misses: string[] = [];
  for (const width of WIDTHS) {
    await resize(width);
    // 只记录不判：改宽后对话区离底部还差多少（停在底部的人改宽后是否还在底部）。
    const gapAfterResize = await rp.evaluate(panel, `(() => { const m = document.querySelector("#messages"); return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight); })()`) as number;
    await rp.evaluate(panel, `(() => { const m = document.querySelector("#messages"); m.scrollTop = m.scrollHeight; return true; })()`);
    await sleep(600);
    await rp.screenshot(panel, join(OUT, `${width}-bottom.png`));
    const card = await cardButtons();
    const composer = await bar();
    await rp.evaluate(panel, `(() => { const m = document.querySelector("#messages"); m.scrollTop = 0; return true; })()`);
    const btn = await until(jump, 5_000, `jump button at ${width}`);
    await sleep(300);
    await rp.screenshot(panel, join(OUT, `${width}-jump.png`));
    evidence[String(width)] = { gapAfterResize, card, composer, jump: btn };
    if (width === WIDTHS[0]) wide = composer.visible;

    try {
      assert.match(card.card, /error-card/, `${width}：最后一张卡是错误卡`);
      assert.ok(card.buttons.length >= 2, `${width}：错误卡有按钮`);
      for (const b of card.buttons) {
        assert.ok(b.inside, `一 ${width}px：「${b.text}」整个在对话区可见范围内：${JSON.stringify(b)} 可见范围 ${JSON.stringify(card.view)}`);
        assert.ok(b.hit, `一 ${width}px：「${b.text}」中心点到的是它自己，不是 ${b.hitBy}`);
      }
      assert.ok(btn.inside, `二 ${width}px：回到底部整个在对话区里：${JSON.stringify(btn)}`);
      assert.ok(btn.hit, `二 ${width}px：回到底部中心点到的是它自己，不是 ${btn.hitBy}`);
      checkBar(`${width}px`, composer, wide);
      // 点「回到底部」回到底，下一个宽度从「停在底部」开始改宽。
      await rp.click(panel, "#to-bottom");
      await until(async () => await rp.evaluate(panel, `document.querySelector("#to-bottom").hidden`) || undefined, 5_000, `二 ${width}px：点回到底部后回到底`);
    } catch (e) { misses.push(e instanceof Error ? e.message : String(e)); }
    await rp.evaluate(panel, `(() => { const m = document.querySelector("#messages"); m.scrollTop = m.scrollHeight; return true; })()`);
  }

  // 任务在跑：「接管」、停止都露出来，再打一句插话让插话发送键也出现。
  await resize(400);
  await send(SLOW);
  await until(async () => await rp.evaluate(panel, `(() => { const t = document.querySelector("#takeover-btn"); return !!t && !t.hidden && t.getClientRects().length > 0; })()`) || undefined, 30_000, "接管出现");
  await rp.click(panel, "#input"); await rp.typeText(panel, "顺便看下价格");
  await until(async () => await rp.evaluate(panel, `(() => { const b = document.querySelector("#steer-send-btn"); return !!b && !b.hidden; })()`) || undefined, 5_000, "插话发送键出现");
  let running: string[] = [];
  for (const width of WIDTHS) {
    await resize(width);
    await rp.screenshot(panel, join(OUT, `${width}-running.png`));
    const composer = await bar();
    evidence[`${width}-running`] = composer;
    if (width === WIDTHS[0]) running = composer.visible;
    try { checkBar(`运行中 ${width}px`, composer, running); } catch (e) { misses.push(e instanceof Error ? e.message : String(e)); }
  }
  assert.ok(running.includes("takeover-btn") && running.includes("steer-send-btn"), `运行中底栏有接管和插话发送：${JSON.stringify(running)}`);
  assert.deepEqual(misses, [], "三个宽度都不遮不切");
} catch (e) {
  failure = String(e);
  console.error(e);
  await rp.screenshot(panel, join(OUT, "failure.png")).catch(() => {});
} finally {
  await writeFile(join(OUT, "result.json"), JSON.stringify({ status: failure ? "FAIL" : "PASS", evidence, failure }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}
console.log(failure ? "FAIL" : "PASS", OUT);
if (failure) process.exitCode = 1;
