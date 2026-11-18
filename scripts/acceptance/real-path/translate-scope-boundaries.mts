import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", new Date().toISOString().replace(/[:.]/g, "-") + "-translate-scope-boundaries");
await mkdir(out, { recursive: true });
const page = '<article><h1>Weather notes</h1><p id="first">The north station <em>opened in April</em>.</p><p id="second">The harbor received <a href="/data">the second instrument</a> on Friday.</p><p id="third">The river rose after midnight.</p><p>Shared note.</p><p>Shared note.</p></article>';
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(page));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${siteAddress(server).port}/article`;
const scope = (quotes: string[], source = url) => ({ url: source, quotes });
const paragraphs = ["north station opened in April", "the second instrument on Friday"];
const attempt = (match: string, args: { action: string; scope?: ReturnType<typeof scope>; mode?: string; language?: string }, delayMs?: number) => ({
  match, ...(args.action === "translate" ? { pageTranslationDestination: args.scope ? "scoped" as const : "whole" as const } : {}),
  steps: [{ tool: { name: "page_translation", args }, delayMs }, { text: match + "已处理。" }],
});
const batches: Array<{ at: number; texts: string[] }> = [];
const model = await startScriptedModel([
  attempt("只在页面翻译前两段", { action: "translate", scope: scope(paragraphs) }, 1500),
  attempt("把第三段译在原处", { action: "translate", scope: scope(["The river rose after midnight."]) }),
  attempt("只切换刚才这段的呈现", { action: "display", mode: "translated" }),
  attempt("使用原来的双语呈现", { action: "display", mode: "bilingual" }),
  attempt("只处理气象站和港口两段", { action: "translate", scope: scope(paragraphs) }),
  attempt("只对气象站改用日文", { action: "translate", scope: scope([paragraphs[0]!]), language: "日语" }),
  attempt("还原网页原文", { action: "restore" }),
  { match: "只在侧栏解释", steps: [{ text: "只在侧栏解释这个词已处理。", delayMs: 1500 }] },
  attempt("把这个页面翻译成中文", { action: "translate" }, 1500),
], { delayMs: 100 }, payload => {
  if (!payload.messages?.some(m => m.role === "system" && typeof m.content === "string" && m.content.startsWith("Translate the supplied webpage text"))) return;
  const input = payload.messages.find(m => m.role === "user")?.content;
  if (typeof input !== "string") throw new Error("未收到翻译原文");
  const { blocks } = JSON.parse(input) as { blocks: Array<{ segments: Array<{ text: string }> }> };
  batches.push({ at: Date.now(), texts: blocks.flatMap(b => b.segments.map(segment => segment.text)) });
});
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual }); console.log(pass ? "PASS" : "FAIL", name, JSON.stringify(actual));
};
let inspectPanel: (() => Promise<Json>) | undefined;
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  await until(async () => await rp.evaluate(work, 'document.querySelectorAll("p").length === 5'), 15000, "练习页就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled === false && document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  inspectPanel = () => rp.evaluate(panel, 'document.querySelector("#messages")?.innerText.slice(-800)');
  const send = async (text: string) => {
    await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel);
  };
  const delivered = (text: string) => until(async () => await rp.evaluate(panel, `${ready} && (() => { const user = [...document.querySelectorAll("#messages .msg.user")].at(-1); return user && [...document.querySelectorAll("#messages .msg.assistant")].some(n => (user.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) && n.innerText.includes(${JSON.stringify(text + "已处理。")})); })()`), 60000, text);
  const say = async (text: string) => { await send(text); await delivered(text); };
  const state = () => rp.evaluate(work, `[...document.querySelectorAll('article [data-bys-translation="true"]')].map(el => el.parentElement.id || el.parentElement.tagName)`) as Promise<string[]>;
  await say("只在页面翻译前两段");
  const sent = batches.flatMap(batch => batch.texts);
  check("送往翻译模型的文本仅来自指定两段", sent.length > 0 && sent.every(t => !/river|Shared note|Weather notes/.test(t)), sent);

  await say("把第三段译在原处");
  await rp.evaluate(work, `window.priorFirst = document.querySelector('#first [data-bys-translation=true]'); true`);
  await say("只切换刚才这段的呈现");
  const sameFirst = await rp.evaluate(work, `!!window.priorFirst && window.priorFirst === document.querySelector('#first [data-bys-translation=true]') && document.querySelector('#first').firstChild.textContent === 'The north station '`);
  check("局部翻译后的显示操作保留其他段落的内容与节点身份", sameFirst === true, await state());
  await say("使用原来的双语呈现");
  const pinned = await rp.evaluate(work, `(() => {
    const el = document.querySelector("#third"); window.priorThird = el.querySelector('[data-bys-translation=true]');
    const manual = document.createElement("span"); manual.dataset.bysTranslation="manual"; manual.textContent="河流观察"; el.append(manual);
    window.priorManual = manual; el.hidden = true; return !!window.priorThird;
  })()`);
  await say("只处理气象站和港口两段");
  await rp.evaluate(work, 'document.querySelector("#third").hidden = false');
  const preserved = () => rp.evaluate(work, `(() => { const el = document.querySelector("#third"); return !!window.priorThird && el.querySelector('[data-bys-translation=true]') === window.priorThird && el.querySelector('[data-bys-translation=manual]') === window.priorManual && el.textContent.includes("中文译文"); })()`);
  check("折叠的第三段在另两段翻译后仍保留双语节点和手工译文", pinned === true && await preserved() === true, await state());
  await say("只对气象站改用日文");
  check("改变目标语言不重写其他段落", await preserved() === true, await state());
  await say("还原网页原文");
  check("全部原文和链接仍可还原", await rp.evaluate(work, "document.querySelector('article').outerHTML") === page, await state());

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
} catch (error) { check("流程完成", false, { error: String(error), panel: await inspectPanel?.().catch(() => null), recentRequests: model.requests.slice(-8).map(r => r.rule) }); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, passed: checks.length > 0 && checks.every(c => c.pass) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => server.close(() => resolve()));
}
if (checks.some(c => !c.pass)) process.exitCode = 1;
console.log(out);
