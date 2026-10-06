/**
 * 回执改版探针（docs/evals/20261006-answer-receipt.md）：只装扩展的无头 Chrome、真侧栏、本机脚本模型。
 * 三轮：开一个网站并回答（读回执、回答下面一排、来源面板、正文出处）；填表做成（做了 N 件事、展开不列准备动作）；
 * 填表最后一步点空（浅底卡片）。每轮截图。
 *
 *   npx tsx scripts/probes/shell/answer-receipt.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/shell");

await mkdir(out, { recursive: true });

const pages = {
  "/": "<!doctype html><meta charset=\"utf-8\"><title>订票</title><p>本线路票价 388 元。</p><label>出发日期 <input id=\"d\"></label><label>乘客 <input id=\"n\"></label><button id=\"b\" onclick=\"this.textContent='已查询'\">查询车票</button>",
  "/about": "<!doctype html><meta charset=\"utf-8\"><title>体验页</title><h1>在线体验</h1><p>登录后开始聊天。</p>",
};

const site = createServer((q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(q.url === "/about" ? pages["/about"] : pages["/"]));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

type ScriptedTool = { name: string; args: Record<string, string> };

const slow = (tool: ScriptedTool) => ({ tool, delayMs: 1500 });

const fillTask = (word: string, target: string) => ({ match: word, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }, slow({ name: "fill", args: { target: "#d", value: "2026-10-20", label: "出发日期" } }), slow({ name: "fill", args: { target: "#n", value: "张三", label: "乘客" } }), slow({ name: "click", args: { target, label: "查询车票" } }), { text: "日期和乘客填好了，也点了「查询车票」。" }] });

const model = await startScriptedModel([
  { match: "开站甲", steps: [{ tool: { name: "tabs", args: { action: "active" } } }, slow({ name: "tabs", args: { action: "open", url: `${origin}/about` } }), { tool: { name: "snapshot", args: {} } }, { text: `已打开[体验页](${origin}/about)，登录后才能聊天。订票页写着票价 388 元。` }] },
  fillTask("订票甲", "#b"),
  fillTask("订票乙", "#nope"),
  { match: "思考甲", steps: [{ text: "我先看一下页面。", reasoning: "**Checking sign-in requirement**\n\n**Inspecting linked show page**\n\nThe page needs login.", thenTool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "tabs", args: { action: "open", url: `${origin}/about` } } }, { text: "看过了。" }] },
]);

const failures: string[] = [];

/** evidence 是已序列化的 JSON 文本：探针只打印，不再解析。 */
const check = (name: string, ok: boolean, evidence: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${evidence}`);

  if (!ok) failures.push(name);
};

const RECEIPT = `(() => { const r = [...document.querySelectorAll("details.run-steps")].pop(); return r ? { done: r.classList.contains("done"), text: r.querySelector(".run-title").textContent, icon: r.querySelector(".run-act-icon")?.dataset.kind ?? null, timeShown: getComputedStyle(r.querySelector(".run-time")).display !== "none" } : null; })()`;

const ANSWER = `(() => { const a = document.querySelector(".msg.assistant.answer-latest"); if (!a) return null; const row = a.querySelector(":scope > .answer-actions"); const btn = row?.querySelector(".answer-sources-btn"); const mark = a.querySelector(".source-mark"); return { text: a.innerText.slice(0, 80), before: !!a.querySelector(":scope > details.answer-sources") || !!a.querySelector(".memory-used-toggle"), opacity: row ? getComputedStyle(row).opacity : null, sources: btn && !btn.hidden ? btn.textContent : null, time: a.querySelector(".answer-time")?.textContent ?? "", mark: mark ? { text: mark.textContent, glyph: !!mark.querySelector(".answer-source-glyph") } : null, chipRow: !!a.querySelector(".citation-row") }; })()`;

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#send-btn\")?.disabled===false") || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);

  const ask = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    const turns = await rp.evaluate(panel, "document.querySelectorAll(\"#messages .msg.user\").length");
    await until(async () => await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.user").length >= ${turns} && !!document.querySelector(".msg.assistant.answer-latest") && [...document.querySelectorAll("#messages > *")].reverse().find((e) => e.matches(".msg.assistant, .msg.user"))?.matches(".msg.assistant.answer-latest")`) || undefined, 60_000, `${text.slice(0, 4)} 的回答落定`);
    await sleep(1500);
  };

  // 一、填表做成
  await ask("订票甲：把出发日期填成 2026-10-20，乘客填张三，然后点查询车票");
  const receiptB = await rp.evaluate(panel, RECEIPT);
  check("填表：回执「做了 3 件事」，列表图标", receiptB?.text === "做了 3 件事" && receiptB.icon === "many", JSON.stringify(receiptB));
  await rp.click(panel, "details.run-steps:last-of-type > summary");
  await sleep(400);
  const steps = await rp.evaluate(panel, "[...document.querySelectorAll(\"details.run-steps[open] .run-body .chip\")].filter((e) => e.getClientRects().length).map((e) => ({ label: e.querySelector(\".chip-label\").textContent, icon: e.querySelector(\".chip-icon\")?.dataset.kind, iconWidth: Math.round(e.querySelector(\".chip-icon svg\")?.getBoundingClientRect().width ?? 0), display: getComputedStyle(e.querySelector(\".chip-icon\")).display }))");
  check("填表：展开三行各带图标，不列定位当前页、读页面结构", steps.length === 3 && steps.every((s: { icon?: string; iconWidth: number }) => (s.icon === "fill" || s.icon === "click") && s.iconWidth > 0) && !steps.some((s: { label: string }) => /定位|读取页面结构/.test(s.label)), JSON.stringify(steps));
  // 二、开一个网站（同一会话，上一条回答成了旧回答）
  await ask(`开站甲：打开体验网站`);
  const receiptA = await rp.evaluate(panel, RECEIPT);
  const answerA = await rp.evaluate(panel, ANSWER);
  check("开站：回执写那一件事，前面是地球图标，回执里不写耗时", !!receiptA?.done && receiptA.text.startsWith("打开了 127.0.0.1") && receiptA.icon === "open" && !receiptA.timeShown, JSON.stringify(receiptA));
  check("开站：回答前没有「读了…」「用了 N 条记忆」行", !!answerA && !answerA.before, JSON.stringify(answerA));
  check("开站：最新回答下面一排常显，有「来源」和耗时", answerA?.opacity === "1" && !!answerA.sources?.includes("来源") && /秒/.test(answerA.time), JSON.stringify(answerA));
  check("开站：链接旁是站点小胶囊，不是数字角标", !!answerA?.mark?.glyph && answerA.mark.text.includes("127.0.0.1"), JSON.stringify(answerA?.mark));

  const nums = await until(async () => {
    const n = await rp.evaluate(panel, "[...document.querySelectorAll(\".msg.assistant.answer-latest .num-cite\")].map((e) => e.textContent)");

    return n.length ? n : undefined;
  }, 10_000, "数字出处").catch(() => []);

  check("开站：页面上的数字 388 带虚下划线，没有「✦ 数字」按钮行", nums.includes("388") && !answerA?.chipRow, JSON.stringify(nums));
  await rp.screenshot(panel, join(out, "receipt-open.png"));
  await rp.click(panel, ".msg.assistant.answer-latest .answer-sources-btn");
  await sleep(900);
  const opened = await rp.evaluate(panel, "(() => { const p = document.querySelector(\".msg.assistant.answer-latest > .answer-panel\"); if (!p || p.hidden) return null; const box = document.querySelector(\"#messages\").getBoundingClientRect(); const r = p.getBoundingClientRect(); return { rows: [...p.querySelectorAll(\"h3, .answer-source\")].map((e) => e.textContent), inView: r.bottom <= box.bottom + 1 && r.top >= box.top }; })()");
  const panelRows = opened?.rows;
  check("开站：点「来源」列出读过的网页，面板滚到看得见", Array.isArray(panelRows) && panelRows[0] === "读过的网页" && panelRows.some((t: string) => t.includes("体验页") || t.includes("127.0.0.1")) && opened.inView, JSON.stringify(opened));
  await rp.screenshot(panel, join(out, "receipt-open-sources.png"));
  await rp.click(panel, ".msg.assistant.answer-latest .answer-sources-btn");

  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, panel);
  await sleep(400);
  const older = await rp.evaluate(panel, "[...document.querySelectorAll(\".msg.assistant > .answer-actions\")].map((r) => ({ latest: r.parentElement.classList.contains(\"answer-latest\"), opacity: getComputedStyle(r).opacity, h: Math.round(r.getBoundingClientRect().height) }))");
  check("旧回答那一排隐藏但占着高度，最新一条常显", older.length >= 2 && older.filter((r: { latest: boolean; opacity: string; h: number }) => !r.latest).every((r: { opacity: string; h: number }) => r.opacity === "0" && r.h >= 28) && older.some((r: { latest: boolean; opacity: string }) => r.latest && r.opacity === "1"), JSON.stringify(older));
  const bubble = await rp.evaluate(panel, "(() => { const u = [...document.querySelectorAll(\".msg.user\")].pop(); const lh = parseFloat(getComputedStyle(u).lineHeight); const pad = parseFloat(getComputedStyle(u).paddingTop) + parseFloat(getComputedStyle(u).paddingBottom); return { h: u.getBoundingClientRect().height, lines: Math.round((u.getBoundingClientRect().height - pad) / lh) }; })()");
  check("用户气泡底部没有空白（一行字就是一行高）", bubble.lines === 1, JSON.stringify(bubble));
  await rp.screenshot(panel, join(out, "receipt-fill-open.png"));

  // 三、没做成
  // 开站那一轮把新标签放到了前面：回到订票页再做。
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, "document.querySelectorAll(\"#messages .msg.user\").length === 0") || undefined, 15_000, "新会话");
  await ask("订票乙：把出发日期填成 2026-10-20，乘客填张三，然后点查询车票");
  const card = await until(async () => await rp.evaluate(panel, "(() => { const e = document.querySelector(\".ai-task-card resume-entry\"); if (!e || !e.getClientRects().length) return null; const b = e.querySelector(\".resume-action\"); const bg = getComputedStyle(b).backgroundColor.match(/\\d+/g).slice(0, 3).map(Number); return { line: e.querySelector(\".resume-line\").textContent, cardBg: getComputedStyle(e).backgroundColor, button: b.textContent, buttonDark: bg.reduce((s, v) => s + v, 0) < 200 }; })()") || undefined, 20_000, "没做成卡片").catch(() => null);
  check("没做成：浅底卡片 + 实心按钮「继续原任务」", !!card && card.cardBg !== "rgba(0, 0, 0, 0)" && card.button.includes("继续原任务") && card.buttonDark, JSON.stringify(card));
  await rp.screenshot(panel, join(out, "receipt-fail.png"));

  // 四、思考摘要和旁白里的 **粗体** 渲染成粗体，不露星号
  await rp.cdp.send("Page.bringToFront", {}, work);
  await ask("思考甲：看看这页要不要登录");
  await rp.click(panel, "details.run-steps:last-of-type > summary");
  await sleep(400);
  const trace = await rp.evaluate(panel, "[...document.querySelectorAll(\"details.run-steps:last-of-type details.thinking pre\")].map((p) => ({ text: p.textContent, bold: [...p.querySelectorAll(\"strong\")].map((b) => b.textContent) }))");
  check("思考摘要：小标题是粗体，没有 ** 星号", trace.some((t: { bold: string[] }) => t.bold.includes("Checking sign-in requirement")) && !trace.some((t: { text: string }) => t.text.includes("**")), JSON.stringify(trace));
  await rp.screenshot(panel, join(out, "receipt-trace.png"));
} finally {
  console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
