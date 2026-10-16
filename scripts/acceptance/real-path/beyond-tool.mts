/**
 * 专用工具做不到的要求，助手改用脚本在页面上做完，不回「工具做不到」（10-13 用户截图：只翻前两段、按词分颜色）。
 * 无头、只装扩展、真实模型；本机文章页，正文前两段与当时的真实文章相同。按用户原话发四句，再要求恢复原文，只判页面上看得到的结果：
 *   T2 译文只出现在第 1、2 段下面；T4 第 1、2 段里有至少两种颜色的词，后面的段落没有；T5 恢复原文后页面上没有中文。
 *   npx tsx scripts/acceptance/real-path/beyond-tool.mts --headless [--model=openai-codex/gpt-6.1-sol]
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

// 默认用用户出问题时用的模型（10-13 截图），不是 DEFAULT_TEST_MODEL。
const model = process.argv.find(arg => arg.startsWith("--model="))?.slice(8) ?? "openai-codex/gpt-6.1-sol";

const out = join(REPO, "out/acceptance/beyond-tool", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(out, { recursive: true });

const paragraphs = [
  "After months of research and revisions right up to the last minute, I’m thrilled to bring you the 9th annual State of AI Report.",
  "For nearly a decade, this report has been a labor of love. My interest in AI began with my PhD in cancer research and computational biology in the early 2010s. Since 2013, I’ve invested in companies building and applying AI to accelerate technological progress. This report is how I share what I learn, and I hope it helps more people understand the research shaping our world.",
  "This year the report covers research, industry, politics, safety and predictions. As always, it is free to read and share.",
  "The research section looks at reasoning models, open weights and the cost of training runs across the major labs.",
  "Thanks to everyone who reviewed drafts and sent corrections over the past months.",
];

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>The State of AI Report 2026 - by Nathan Benaich</title>
<body style="font:18px/1.6 Georgia,serif;max-width:720px;margin:24px auto;padding:0 16px">
<nav><a href="#">Home</a> · <a href="#">Archive</a> · <a href="#">About</a></nav>
<h1>The State of AI Report 2026</h1><p class="subtitle">Our ninth annual report on what happened in AI and what it means.</p>
<article>${paragraphs.map((p, i) => `<p data-p="${i + 1}">${p}</p>`).join("")}</article></body></html>`;

const turns = ["只翻译这篇文章的前两段。", "将翻译呈现在页面上。", "那在第一段和第二段出现的最高频率的词汇是哪个？", "将它们分别以不同的颜色在页面上呈现。", "把页面上的译文去掉，恢复原文。"];

/** 把文章分成「原文第 i 段 + 它后面插入的内容」，量每块里新增的中文字数和彩色单词。 */
const PAGE_STATE = `(() => {
  // 按文档顺序走：一个节点归到它前面（或包着它的）最近的原文段落，助手把段落包进新容器也照样分得对。
  const buckets = [];
  let cur = null;
  const article = document.querySelector('article');
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1 && n.dataset.p) { cur = {p: Number(n.dataset.p), cjk: 0, colors: []}; buckets.push(cur); continue; }
    if (!cur) continue;
    // 原文全是英文，所以块里的中文都是助手加的。
    if (n.nodeType === 3) { cur.cjk += (n.data.match(/[\\u4e00-\\u9fff]/g) || []).length; continue; }
    const t = n.textContent.trim();
    if (!/^[A-Za-z’' ]{1,40}$/.test(t)) continue;
    const s = getComputedStyle(n), base = getComputedStyle(n.parentElement).color;
    const bg = s.backgroundColor;
    const key = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? 'bg:' + bg : s.color !== base ? 'fg:' + s.color : null;
    if (key) cur.colors.push(t.toLowerCase() + '|' + key);
  }
  return buckets;
})()`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page));

await new Promise<void>(r => site.listen(0, "127.0.0.1", r));

const rp = await launchRealPath();

const checks: Array<{ id: string; pass: boolean; detail: unknown }> = [];

let error: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "工作页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/p/state-of-ai-2026` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(await loadModelPlan(model)))}).then(()=>true)`);
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await sleep(1000);

  for (const [i, goal] of turns.entries()) {
    const before = Number(await rp.evaluate(panel, `document.querySelectorAll('#messages .msg.user').length`));
    const started = Date.now();
    await rp.click(panel, "#input"); await rp.typeText(panel, goal); await rp.pressEnter(panel);
    await until(async () => Number(await rp.evaluate(panel, `document.querySelectorAll('#messages .msg.user').length`)) > before || undefined, 15_000, `第 ${i + 1} 句发出`);
    let stable = 0;
    await until(async () => {
      const idle = await rp.evaluate(panel, `!document.querySelector('#status-pill').classList.contains('running') && !document.querySelector('.msg.assistant.streaming, .msg.assistant[data-revealing]')`);
      stable = idle && Date.now() - started > 3000 ? stable + 1 : 0;

      return stable >= 5 || undefined;
    }, 240_000, `第 ${i + 1} 句做完`, 400);
    const answer = String(await rp.evaluate(panel, `[...document.querySelectorAll('#messages .msg.assistant')].filter(x=>!x.closest('.run-steps')).at(-1)?.innerText ?? ''`));
    const state = await rp.evaluate(work, PAGE_STATE) as Array<{ p: number; cjk: number; colors: string[] }>;
    console.log(`第 ${i + 1} 句 ${Date.now() - started}ms：${answer.slice(0, 120).replace(/\n/g, " ")}`);
    await rp.screenshot(panel, join(out, `turn${i + 1}-panel.png`));
    await rp.screenshot(work, join(out, `turn${i + 1}-page.png`));

    if (i === 1) checks.push({ id: "translation-on-page-first-two", pass: state.length === 5 && state[0]!.cjk >= 20 && state[1]!.cjk >= 60 && state.slice(2).every(b => b.cjk === 0), detail: { answer, state } });

    if (i === 3) {
      const colorsIn = (b: { colors: string[] }) => new Set(b.colors.map(c => c.split("|")[1]));
      const firstTwo = new Set([...colorsIn(state[0]!), ...colorsIn(state[1]!)]);
      checks.push({ id: "colored-words-first-two", pass: state.length === 5 && firstTwo.size >= 2 && state.slice(2).every(b => b.colors.length === 0), detail: { answer, state } });
    }

    if (i === 4) checks.push({ id: "restore-removes-own-translation", pass: state.length === 5 && state.every(b => b.cjk === 0), detail: { answer, state } });
  }

  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "diagnostics"));

  await writeFile(join(out, "traces.jsonl"), diag.traces);
} catch (e) { error = String(e); console.error(error); }
finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ model, checks, error }, null, 2));
  await rp.close(); site.closeAllConnections(); site.close();
}

for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id}`);
console.log(out);

if (error || checks.length !== 3 || checks.some(c => !c.pass)) process.exitCode = 1;
