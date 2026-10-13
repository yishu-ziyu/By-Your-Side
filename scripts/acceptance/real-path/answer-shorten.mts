/**
 * 回答写完后拖短：全文 / 要点 / 一句。
 *   npx tsx scripts/acceptance/real-path/answer-shorten.mts --headless [--live] [--model=服务商/模型]
 * 脚本模型写一份带比价卡片、小标题列表和“细节”段的回答。用真实鼠标拖把手、点把手、按上下键，
 * 读每层用户看得到的字：每层都从全文里截出、一句层等于第一句、层越短字越少；复制和“复制为 Markdown”拿到的是当前层。
 * 再问一句一句话的问题：不出把手。剪贴板只记下产品交给 navigator.clipboard 的字，不读系统剪贴板。
 * --record：判定做完后再录一段正常速度的拖动（out/…/drag.mp4），只给人看，不参与判定。
 * --live：主模型换成真实模型（默认 gpt-6-luna），问一道比价题，截图看第一句是不是结论；只证明这一个模型在这一道题上的表现。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const live = process.argv.includes("--live");
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-shorten${live ? "-live" : ""}`);

await mkdir(artifacts, { recursive: true });

const TASK = "这三家哪家到手最便宜？算上运费，再看看值不值得等双十一。";
const SHORT = "这个网站是哪家公司运营的？";
const FIRST = "拼多多百亿补贴到手最便宜，¥1529（含运费）。";

// 加粗跨过第一句的句末：拆开后，后半句不能跑进加粗或链接里。
const ANSWER = `**${FIRST}天猫用券后 ¥1649**，京东 ¥1699，两家都包邮。
<card title="到手价（含运费）">
<option name="拼多多百亿补贴" value="¥1529" meta="第三方店铺 · 3 天到" why="三家里最便宜" pick />
<option name="天猫 Apple 官方旗舰店" value="¥1649" meta="用券后 · 2 天到" why="官方店，售后走 Apple" />
<option name="京东自营" value="¥1699" meta="次日达" why="退换最省事" />
</card>

### 值不值得等双十一
- 去年双十一的最低到手价只比现在便宜三十元左右。
- 拼多多是第三方店铺，售后走平台，不走 Apple。

### 细节
天猫的店铺券今晚 24 点过期；京东自营次日达，退换最省事。拼多多的“百亿补贴”标是平台补贴，价格可能随时调整。如果你在意售后，京东多花一点换的是自营退换；如果只看价格，现在就买拼多多。`;

const shop = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>耳机比价</title><h1>AirPods Pro 2 三家报价</h1>
<ul><li>京东自营 ¥1699，免运费，次日达</li><li>天猫 Apple 官方旗舰店 ¥1699，店铺券满1500减50，包邮，2天到</li><li>拼多多百亿补贴 ¥1529，运费 ¥0，第三方店铺，3天到</li></ul>
<footer>© 2026 比价小站 由 Lumen Labs, Inc. 运营</footer>`));

await new Promise<void>(resolve => shop.listen(0, "127.0.0.1", resolve));

const rules: Rule[] = [
  { match: TASK, steps: [{ text: ANSWER, chunkDelayMs: 20 }] },
  { match: SHORT, steps: [{ text: "比价小站由 Lumen Labs 运营。" }] },
];
const model = live ? null : await startScriptedModel(rules);
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

type Seen = { level: string | null; label: string; text: string; grip: boolean };

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(shop).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const config = model
    ? { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } }
    : modelStorageItems(await loadModelPlan(process.argv.find(a => a.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL));
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(config)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  // 记下产品交给剪贴板的字。
  await rp.evaluate(panel, `(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; return true; })()`);

  const ask = async (text: string, n: number) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter(m => m.querySelector(".answer-actions")); return a.length >= ${n} && !document.querySelector("#messages .msg.assistant.streaming"); })()`) || undefined, 180_000, `第 ${n} 个回答`);
    await sleep(800);
  };
  const ANSWER_JS = `[...document.querySelectorAll("#messages .msg.assistant")].filter(m => m.querySelector(".answer-actions"))`;
  // 用户看得到的正文：innerText 按样式算；但不渲染的元素的 innerText 会退回全部文字，所以先跳过整块收起的。
  const seen = async (n = 0): Promise<Seen> => await rp.evaluate(panel, `(() => { const a = ${ANSWER_JS}[${n}];
    const text = [...a.children].filter(c => !c.matches(".answer-actions,.answer-panel") && getComputedStyle(c).display !== "none").map(c => c.innerText).join("\\n").trim();
    return { level: a.dataset.shortenLevel ?? null, label: a.querySelector(".shorten-level")?.textContent ?? "", text, grip: !!a.querySelector(".shorten-grip") }; })()`) as Seen;
  const gripAt = async () => await rp.evaluate(panel, `(() => { const r = ${ANSWER_JS}[0].querySelector(".shorten-grip").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`) as { x: number; y: number };
  const mouse = (type: string, x: number, y: number) => rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, panel);
  const drag = async (dy: number) => {
    const at = await gripAt();
    await mouse("mousePressed", at.x, at.y);
    for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", at.x, at.y + Math.round(dy * i / 6)); await sleep(30); }
    await mouse("mouseReleased", at.x, at.y + dy);
    await sleep(500);
  };
  const key = async (k: string, vk: number) => { for (const type of ["keyDown", "keyUp"]) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: vk }, panel); await sleep(450); };
  const lines = (s: string) => s.split(/\n+/).map(l => l.trim()).filter(Boolean);

  if (live) {
    await ask("这三家哪家到手最便宜？算上运费", 1);
    await rp.screenshot(panel, join(artifacts, "live-answer.png"));
    const answer = await seen();
    evidence.live = answer;
    // 真模型常把结论写成只有一句的第一段，后面跟卡片：这时也要能收短。
    assert.ok(answer.grip, `真模型的长回答有把手: ${JSON.stringify(answer)}`);
  } else {
    await ask(TASK, 1);
    const full = await seen();
    await rp.screenshot(panel, join(artifacts, "level-3-full.png"));
    assert.ok(full.grip && full.level === "3" && /^全文 · 约 \d+ 秒读完$/.test(full.label), `有把手，默认全文: ${JSON.stringify(full)}`);
    const split = await rp.evaluate(panel, `(() => { const p = ${ANSWER_JS}[0].querySelector("p"); const rest = p.querySelector(".shorten-rest");
      return { restParent: rest?.parentElement?.tagName, bold: [...p.querySelectorAll("strong")].map(s => s.textContent) }; })()`) as { restParent?: string; bold: string[] };
    evidence.split = split;
    assert.deepEqual(split, { restParent: "P", bold: [FIRST, "天猫用券后 ¥1649"] }, `拆第一句不改加粗范围: ${JSON.stringify(split)}`);

    await drag(-40);
    const points = await seen();
    await rp.screenshot(panel, join(artifacts, "level-2-points.png"));
    await drag(-40);
    const one = await seen();
    await rp.screenshot(panel, join(artifacts, "level-1-sentence.png"));
    Object.assign(evidence, { full, points, one });

    assert.equal(points.level, "2", "往上拖一格到要点");
    assert.equal(one.level, "1", "再拖一格到一句");
    for (const s of [points, one]) assert.ok(lines(s.text).every(l => full.text.includes(l)), `${s.level} 层每行都从全文里截出: ${s.text}`);
    assert.equal(one.text, FIRST, "一句层等于第一句");
    assert.ok(one.text.length < points.text.length && points.text.length < full.text.length, "层越短字越少");
    assert.ok(points.text.includes("拼多多百亿补贴") && !points.text.includes("京东自营") && points.text.includes("值不值得等双十一") && !points.text.includes("细节"), `要点层：卡片只留推荐项，留带列表的小标题，去掉细节: ${points.text}`);
    assert.ok(one.label.startsWith("一句 · 约"), `层名跟着变: ${one.label}`);

    // 复制和“复制为 Markdown”都按当前层。
    await rp.click(panel, ".answer-primary");
    await sleep(200);
    await rp.click(panel, ".answer-command-btn");
    await until(async () => await rp.evaluate(panel, `!!document.querySelector(".answer-command-item")`) || undefined, 3_000, "动作菜单");
    await rp.evaluate(panel, `[...document.querySelectorAll(".answer-command-item")].find(r => r.textContent.includes("复制为 Markdown")).click(), true`);
    await sleep(300);
    const copied = await rp.evaluate(panel, `window.__copied`) as string[];
    evidence.copied = copied;
    assert.equal(copied[0], FIRST, "复制拿到的是一句层");
    assert.equal(copied[1], `**${FIRST}**`, "复制为 Markdown 拿到的也是一句层，加粗照留");

    // 点一下：最短再点回全文；键盘上键短一层、下键长一层。
    await drag(0);
    const back = await seen();
    assert.equal(back.level, "3", "最短时点一下回到全文");
    assert.equal(back.text, full.text, "回到全文时一字不差");
    await rp.evaluate(panel, `${ANSWER_JS}[0].querySelector(".shorten-grip").focus(), true`);
    await key("ArrowUp", 38);
    const up = await seen();
    await key("ArrowDown", 40);
    const down = await seen();
    evidence.keys = { up: up.level, down: down.level };
    assert.ok(up.level === "2" && down.level === "3", `上下键换层: ${JSON.stringify(evidence.keys)}`);
    assert.equal(await rp.evaluate(panel, `${ANSWER_JS}[0].querySelector(".shorten-grip").getAttribute("aria-valuetext")`), "全文", "把手 aria 跟着层走");

    if (process.argv.includes("--record")) {
      // 现在是全文：往上拖到要点、再到一句，再往下拖回全文；每步停一会儿，让人看清。
      const stop = await recordScreen(rp.cdp, panel, join(artifacts, "drag.mp4"));
      await sleep(1500);
      for (const dy of [-40, -40, 80]) { await drag(dy); await sleep(2800); }
      evidence.recording = await stop();
    }

    await ask(SHORT, 2);
    const short = await seen(1);
    evidence.short = short;
    assert.ok(!short.grip, "一句话的回答不出把手");
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model?.close();
  shop.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
