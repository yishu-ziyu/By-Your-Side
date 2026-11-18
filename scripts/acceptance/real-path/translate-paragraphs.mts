import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", new Date().toISOString().replace(/[:.]/g, "-") + "-translate-paragraphs");
await mkdir(out, { recursive: true });
const page = '<article><h1>Weather notes</h1><p id="first">The north station <em>opened in April</em>.</p><p id="second">The harbor received <a href="/data">the second instrument</a> on Friday.</p><p id="third">The river rose after midnight.</p><p>Shared note.</p><p>Shared note.</p></article>';
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(page));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${siteAddress(server).port}/article`;
const scope = (quotes: string[], source = url) => ({ url: source, quotes });
const paragraphs = ["north station opened in April", "the second instrument on Friday"];
const attempt = (match: string, args: object, delayMs?: number) => ({
  match, steps: [{ tool: { name: "page_translation", args: { action: "translate", ...args } }, delayMs }, { text: match + "已处理。" }],
});
let holdTranslation: Promise<void> | undefined;
let releaseTranslation: (() => void) | undefined;
const hold = () => {
  holdTranslation = new Promise<void>(resolve => { releaseTranslation = resolve; });
};
const release = () => { releaseTranslation?.(); holdTranslation = undefined; };
const batches: Array<{ at: number; texts: string[] }> = [];
const model = await startScriptedModel([
  attempt("只在页面翻译前两段", { scope: scope(paragraphs) }, 1500),
  attempt("把第三段译在原处", { scope: scope(["The river rose after midnight."]) }),
  attempt("只处理气象站和港口两段", { scope: scope(paragraphs) }),
  attempt("只对气象站改用日文", { scope: scope([paragraphs[0]!]), language: "日语" }),
  attempt("只对气象站切换为译文", { scope: scope([paragraphs[0]!]), action: "display", mode: "translated" }),
  { match: "只在侧栏解释", steps: [{ text: "只在侧栏解释这个词已处理。", delayMs: 1500 }] },
  attempt("把这个页面翻译成中文", {}, 1500),
  attempt("核对不唯一的段落", { scope: scope(["river rose after midnight", "Shared note."]) }),
  attempt("核对缺少的段落", { scope: scope(["river rose after midnight", "Absent paragraph."]) }),
  attempt("核对另一篇文章", { scope: scope(["river rose after midnight"], url + "-old") }),
  attempt("继续翻译整篇", {}),
  attempt("核对将要更正的原文", { scope: scope(["The morning observation was provisional."]) }),
  attempt("处理中途停止的段落", { scope: scope(["The evening reading has just arrived."]) }),
  { match: "还原网页原文", steps: [{ tool: { name: "page_translation", args: { action: "restore" } } }, { text: "还原网页原文已处理。" }] },
], { delayMs: 100 }, async payload => {
  if (!payload.messages?.some(m => m.role === "system" && typeof m.content === "string" && m.content.startsWith("Translate the supplied webpage text"))) return;
  const input = payload.messages.find(m => m.role === "user")?.content;
  if (typeof input !== "string") throw new Error("未收到翻译原文");
  const { blocks } = JSON.parse(input) as { blocks: Array<{ segments: Array<{ text: string }> }> };
  batches.push({ at: Date.now(), texts: blocks.flatMap(b => b.segments.map(segment => segment.text)) });
  await holdTranslation;
});
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual }); console.log(pass ? "PASS" : "FAIL", name, JSON.stringify(actual));
};
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  await until(async () => await rp.evaluate(work, 'document.querySelectorAll("p").length === 5'), 15000, "练习页就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled === false && document.querySelector("#send-btn")?.disabled === false';
  await until(async () => await rp.evaluate(panel, ready), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  const send = async (text: string) => {
    await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel);
  };
  const delivered = (text: string) => until(async () => await rp.evaluate(panel, `${ready} && [...document.querySelectorAll("#messages .msg.assistant")].some(n => n.innerText.includes(${JSON.stringify(text + "已处理。")}))`), 60000, text);
  const say = async (text: string) => { await send(text); await delivered(text); };
  const state = () => rp.evaluate(work, `[...document.querySelectorAll('article [data-bys-translation="true"]')].map(el => el.parentElement.id || el.parentElement.tagName)`) as Promise<string[]>;
  const firstTwo = (ids: string[]) => ids.join(",") === "first,second";
  await rp.evaluate(work, `window.outsideWrites = []; new MutationObserver(records => {
    for (const r of records) if (r.type === "childList" && Array.from(r.addedNodes).some(n => n.nodeType === 1 && n.hasAttribute("data-bys-translation")) && !r.target.closest("#first,#second")) window.outsideWrites.push(r.target.nodeName);
  }).observe(document.querySelector("article"), { childList: true, subtree: true }); true`);
  await say("只在页面翻译前两段");
  const sent = batches.flatMap(batch => batch.texts);
  check("限定两段时发给翻译模型的原文仅来自这两段", sent.length > 0 && sent.every(t => !/river|Shared note|Weather notes/.test(t)), sent);
  const first = await state();
  const outside = await rp.evaluate(work, "window.outsideWrites");
  check("只写入两段，段落以外未出现译文或翻译占位", firstTwo(first) && Array.isArray(outside) && outside.length === 0, { first, outside });
  check("两段都有译文，内联链接仍可核对", await rp.evaluate(work, `[...document.querySelectorAll('#first [data-bys-translation=true],#second [data-bys-translation=true]')].filter(n=>n.textContent.includes("中文译文")).length === 2 && !!document.querySelector('#second [data-bys-translation=true] a[href$="/data"]')`) === true, first);
  for (const text of ["核对不唯一的段落", "核对缺少的段落", "核对另一篇文章"]) {
    await say(text);
    const after = await state();
    const outside = await rp.evaluate(work, "window.outsideWrites");
    check(text + "时不扩大翻译范围", firstTwo(after) && Array.isArray(outside) && outside.length === 0, { after, outside });
  }
  await say("继续翻译整篇");
  const all = await state();
  check("整页操作可以接着翻译剩余四段", all.length === 6 && all.includes("third"), all);
  await say("还原网页原文");
  const restored = await rp.evaluate(work, "document.querySelector('article').outerHTML");
  check("还原了全部原文、链接和段落结构", restored === page, restored);

  await say("把第三段译在原处");
  const pinned = await rp.evaluate(work, `(() => {
    const el = document.querySelector("#third"); window.previousThird = el.querySelector('[data-bys-translation=true]');
    const manual = document.createElement("span"); manual.dataset.bysTranslation="manual"; manual.textContent="河流观察"; el.append(manual);
    window.previousManual = manual; el.hidden = true; return !!window.previousThird;
  })()`);
  await say("只处理气象站和港口两段");
  const preserved = () => rp.evaluate(work, `(() => { const el = document.querySelector("#third"); return el.querySelector('[data-bys-translation=true]') === window.previousThird && el.querySelector('[data-bys-translation=manual]') === window.previousManual && el.textContent.includes("中文译文"); })()`);
  await rp.evaluate(work, 'document.querySelector("#third").hidden = false');
  check("折叠的第三段在另两段翻译后仍保留原有双语节点和手工译文", pinned === true && await preserved() === true, await state());
  for (const text of ["只对气象站改用日文", "只对气象站切换为译文"]) {
    await say(text);
    check(text + "不改变第三段的已有内容或呈现", await preserved() === true, await state());
  }
  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, `${ready} && !document.querySelector("#messages .msg.user")`), 15000, "新对话就绪");
  await say("还原网页原文");
  check("局部操作后仍能还原全部已管理段落", await rp.evaluate(work, "document.querySelector('article').outerHTML") === page, await state());

  await rp.evaluate(work, 'document.querySelector("#first").textContent = "The morning observation was provisional."');
  hold();
  await send("核对将要更正的原文");
  await until(async () => await rp.evaluate(work, `!!document.querySelector('#first [data-bys-translation="pending"]')`), 15000, "正在处理第一段");
  await rp.evaluate(work, 'document.querySelector("#first").textContent = "A corrected morning observation."');
  release();
  await delivered("核对将要更正的原文");
  const changed = await rp.evaluate(work, `document.querySelector('#first').textContent === "A corrected morning observation." && !document.querySelector('[data-bys-translation]')`);
  check("页面改写原文后拒绝迟到的译文", changed === true, changed);

  await rp.evaluate(work, 'document.querySelector("#second").textContent = "The evening reading has just arrived."');
  hold();
  await send("处理中途停止的段落");
  await until(async () => await rp.evaluate(work, `!!document.querySelector('#second [data-bys-translation="pending"]')`), 15000, "正在处理第二段");
  await rp.click(panel, "#send-btn");
  release();
  await until(async () => await rp.evaluate(panel, `${ready} && !document.querySelector("#send-btn").classList.contains("stopping")`), 15000, "已停止");
  await until(async () => await rp.evaluate(work, `!document.querySelector('[data-bys-translation="pending"]')`), 10000, "已清除占位");
  const stopped = await rp.evaluate(work, `document.querySelector('#second').textContent === "The evening reading has just arrived." && !document.querySelector('[data-bys-translation]')`);
  check("用户停止后保留原文并清理占位", stopped === true, stopped);

  const freshParagraph = async (key: string, text: string) => {
    const next = url + "?case=" + key;
    await rp.cdp.send("Page.navigate", { url: next }, work);
    await until(async () => await rp.evaluate(work, `location.href === ${JSON.stringify(next)} && document.readyState === "complete" && !!document.querySelector("article")`), 15000, "新练习页就绪");
    await rp.evaluate(work, `(() => { const p = document.createElement("p"); p.textContent = ${JSON.stringify(text)}; document.querySelector("article").replaceChildren(p); })()`);
  };
  await freshParagraph("sidebar", "The hillside station changed its reporting time.");
  const beforeSidebar = batches.length;
  await send("只在侧栏解释这个词：“把这个页面翻译成中文”是什么意思？");
  await delivered("只在侧栏解释这个词");
  const sidebarBatches = batches.slice(beforeSidebar);
  check("含整页指令引文的侧栏问题未把网页原文发送给翻译模型", sidebarBatches.length === 0, sidebarBatches.flatMap(b => b.texts));

  await freshParagraph("whole", "The western gauge reported a new daily minimum.");
  const beforeWhole = batches.length;
  await say("把这个页面翻译成中文");
  const whole = batches.slice(beforeWhole);
  const main = model.requests.find(r => r.rule === "把这个页面翻译成中文" && r.step === 0 && r.tools && r.closedAt);
  const completed = await rp.evaluate(work, `!!document.querySelector('article [data-bys-translation=true]')`);
  check("明确整页任务在首轮返回前预取并完成网页翻译", completed === true && !!main?.closedAt && whole.some(b => b.at < main.closedAt!), { completed, requests: whole.length });
} catch (error) { check("流程完成", false, String(error)); } finally {
  release();
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, passed: checks.length > 0 && checks.every(c => c.pass) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => server.close(() => resolve()));
}
if (checks.some(c => !c.pass)) process.exitCode = 1;
console.log(out);
