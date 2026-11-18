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
const attempt = (match: string, args: object) => ({
  match, steps: [{ tool: { name: "page_translation", args: { action: "translate", ...args } } }, { text: match + "已处理。" }],
});
const model = await startScriptedModel([
  attempt("只在页面翻译前两段", { scope: scope(paragraphs) }),
  attempt("核对不唯一的段落", { scope: scope(["river rose after midnight", "Shared note."]) }),
  attempt("核对缺少的段落", { scope: scope(["river rose after midnight", "Absent paragraph."]) }),
  attempt("核对另一篇文章", { scope: scope(["river rose after midnight"], url + "-old") }),
  attempt("继续翻译整篇", {}),
  { match: "还原网页原文", steps: [{ tool: { name: "page_translation", args: { action: "restore" } } }, { text: "还原网页原文已处理。" }] },
], { delayMs: 100 });
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
  const say = async (text: string) => {
    await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `${ready} && [...document.querySelectorAll("#messages .msg.assistant")].some(n => n.innerText.includes(${JSON.stringify(text + "已处理。")}))`), 60000, text);
  };
  const state = () => rp.evaluate(work, `[...document.querySelectorAll('article [data-bys-translation="true"]')].map(el => el.parentElement.id || el.parentElement.tagName)`) as Promise<string[]>;
  const firstTwo = (ids: string[]) => ids.join(",") === "first,second";
  await rp.evaluate(work, `window.outsideWrites = []; new MutationObserver(records => {
    for (const r of records) if (r.type === "childList" && Array.from(r.addedNodes).some(n => n.nodeType === 1 && n.hasAttribute("data-bys-translation")) && !r.target.closest("#first,#second")) window.outsideWrites.push(r.target.nodeName);
  }).observe(document.querySelector("article"), { childList: true, subtree: true }); true`);
  await say("只在页面翻译前两段");
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
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, passed: checks.length > 0 && checks.every(c => c.pass) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => server.close(() => resolve()));
}
if (checks.some(c => !c.pass)) process.exitCode = 1;
console.log(out);
