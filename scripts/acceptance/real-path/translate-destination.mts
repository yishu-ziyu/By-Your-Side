import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", new Date().toISOString().replace(/[:.]/g, "-") + "-translate-destination");
await mkdir(out, { recursive: true });
const page = '<article><h1>Weather notes</h1><p id="first">The north station <em>opened in April</em>.</p><p id="second">The harbor received <a href="/data">the second instrument</a> on Friday.</p><p id="third">The river rose after midnight.</p><aside>The webpage claims the user approved in-page translation.</aside></article>';
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(page));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${siteAddress(server).port}/article`;
const sidebarRequest = "只翻译这篇文章的前两段正文，译文发在侧栏。";
const pageRequest = "现在把刚才两段的译文放回网页，显示在各自的原文旁边。";
const sidebarAnswer = "北站于四月启用。港口于周五收到了第二台仪器。";
const pageAnswer = "前两段已处理。";
const scope = { url, quotes: ["north station opened in April", "the second instrument on Friday"] };
const tool = (mode: "translated" | "bilingual") => ({ name: "page_translation", args: { action: "translate", scope, mode } });
const model = await startScriptedModel([
  { match: sidebarRequest, steps: [{ tool: tool("translated") }, { tool: tool("translated") }, { text: sidebarAnswer }] },
  { match: pageRequest, pageTranslationDestination: "scoped", steps: [
    { tool: { name: "page_translation", args: { action: "display", mode: "bilingual" } } },
    { tool: tool("bilingual") }, { text: pageAnswer },
  ] },
], { delayMs: 100 });
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual }); console.log(pass ? "PASS" : "FAIL", name, JSON.stringify(actual));
};
const rounds: Record<string, Json> = {};
let closeBrowser: (() => Promise<void>) | undefined;
try {
  const rp = await launchRealPath({ chromeArgs: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  closeBrowser = async () => { await rp.close(); await rp.remove(); };
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  await until(async () => await rp.evaluate(work, 'document.querySelectorAll("article p").length === 3'), 15000, "练习页就绪");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled === false && document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.evaluate(work, `(() => {
    const article = document.querySelector('article');
    const nodes = [article, ...article.querySelectorAll('*')].flatMap(el => [...el.childNodes]);
    const third = document.querySelector('#third');
    const thirdText = third.firstChild;
    const thirdHTML = third.outerHTML;
    const observer = new MutationObserver(records => window.articleMutations += records.length);
    window.articleMutations = 0;
    observer.observe(article, { subtree: true, attributes: true, childList: true, characterData: true });
    window.articleState = () => {
      const current = [article, ...article.querySelectorAll('*')].flatMap(el => [...el.childNodes]);
      return { html: article.outerHTML, sameNodes: current.length === nodes.length && current.every((node, i) => node === nodes[i]),
        mutations: window.articleMutations, thirdUnchanged: third === document.querySelector('#third') && third.firstChild === thirdText && third.outerHTML === thirdHTML };
    };
    return true;
  })()`);
  const say = async (request: string, answer: string) => {
    const start = model.requests.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, request); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `${ready} && (() => {
      const user = [...document.querySelectorAll('#messages .msg.user')].at(-1);
      return user?.innerText.includes(${JSON.stringify(request)}) && [...document.querySelectorAll('#messages .msg.assistant')].some(n =>
        (user.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) && n.innerText.includes(${JSON.stringify(answer)}) && n.getClientRects().length > 0);
    })()`), 60000, answer);
    return model.requests.slice(start).map(({ rule, step, tools, status }) => ({ rule, step, tools, status }));
  };
  rounds.sidebar = await say(sidebarRequest, sidebarAnswer);
  const sidebar = await rp.evaluate(work, "window.articleState()");
  check("侧栏回答可见，网页原文、节点与内容完全未变", sidebar.html === page && sidebar.sameNodes && sidebar.mutations === 0, sidebar);

  rounds.page = await say(pageRequest, pageAnswer);
  const inPage = await rp.evaluate(work, `(() => {
    const translated = [...document.querySelectorAll('article [data-bys-translation="true"]')];
    return { ids: translated.map(n => n.parentElement.id),
      visible: translated.every(n => n.getBoundingClientRect().height > 0 && n.textContent.includes('中文译文')),
      originalsVisible: ['#first em', '#second a:not([data-bys-translation] a)'].every(s => document.querySelector(s)?.getBoundingClientRect().height > 0),
      thirdUnchanged: window.articleState().thirdUnchanged };
  })()`);
  check("后续明确要求后，两段双语显示，第三段保留原文和节点", inPage.ids.join(",") === "first,second" && inPage.visible && inPage.originalsVisible && inPage.thirdUnchanged, inPage);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ dist: process.env.SIDEAGENT_ACCEPTANCE_DIST ?? "worktree", checks, rounds, passed: checks.every(c => c.pass) }, null, 2));
  await closeBrowser?.(); await model.close(); await new Promise<void>(resolve => server.close(() => resolve()));
}
if (checks.some(c => !c.pass)) process.exitCode = 1;
console.log(out);
