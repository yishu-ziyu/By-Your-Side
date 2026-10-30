/**
 * 「发布 / 回复」这类把内容发给别人的按钮，和「发送」一样先在侧栏确认。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/panel-publish-confirm.mts --headless
 * 判据只看侧栏上的确认卡和服务器收到的 POST。
 *   q1) 助手点「发布」（框里有草稿）：侧栏出确认卡；用户点「先不发」，服务器 0 条。
 *   q2) 助手点「Reply」（框里有草稿）：同上。
 *   q3) 助手点只用来展开回复框的「回复」（还没写内容）：不出卡，回复框展开。
 *   q4) 助手点排序用的「发布时间」：不出卡，列表照常排序。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-panel-publish-confirm`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>社区练习页</title><body style="font:16px sans-serif;margin:40px">
<form id="post"><textarea aria-label="动态" rows="2" cols="40">今天天气不错。</textarea><p><button id="publish">发布</button></p></form>
<form id="reply"><textarea aria-label="Reply text" rows="2" cols="40">Thanks!</textarea><p><button id="reply-en">Reply</button></p></form>
<div id="thread"><p>楼主：大家好</p><button id="open-reply" type="button">回复</button><textarea id="reply-box" hidden aria-label="回复框"></textarea></div>
<p><button id="sort" type="button">发布时间</button> <span id="sorted">未排序</span></p>
<script>
for (const f of document.querySelectorAll('form')) f.addEventListener('submit', async e => { e.preventDefault(); await fetch('/' + f.id, { method: 'POST', body: f.querySelector('textarea').value }); });
document.querySelector('#open-reply').onclick = () => { document.querySelector('#reply-box').hidden = false; };
document.querySelector('#sort').onclick = () => { document.querySelector('#sorted').textContent = '按发布时间'; };
</script></body></html>`;

const posts: string[] = [];

const site = createServer(async (req, res) => {
  if (req.method === "POST") { for await (const _ of req) { /* 读完请求体 */ } posts.push(req.url ?? ""); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ASK = {
  q1: { text: "案例Q1：把动态发布出去。", target: "#publish", label: "发布" },
  q2: { text: "案例Q2：把回复发出去。", target: "#reply-en", label: "Reply" },
  q3: { text: "案例Q3：打开回复框。", target: "#open-reply", label: "回复" },
  q4: { text: "案例Q4：按发布时间排序。", target: "#sort", label: "发布时间" },
};

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...Object.entries(ASK).map(([key, a]) => ({ match: a.text, steps: [{ tool: { name: "click", args: { target: a.target, label: a.label } } }, { text: `${key.toUpperCase()} 完成。` }] })),
]);

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  const cards = async () => Number(await rp.evaluate(panel, 'document.querySelectorAll(".send-confirm").length'));

  const liveCard = () => until(async () => (await rp.evaluate(panel, `(() => { const c = [...document.querySelectorAll(".send-confirm")].at(-1); return c && c.querySelector(".send-confirm-no") ? { id: c.dataset.sendConfirm, text: c.innerText.replace(/\\s+/g, " ").trim() } : null; })()`)) as { id: string; text: string } | null, 20_000, "侧栏出现能点的确认卡", 100).catch(() => null);

  const answered = (text: string) => until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(text)}))`)) as boolean, 60_000, `回答「${text}」`);

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };

  for (const [key, path] of [["q1", "/post"], ["q2", "/reply"]] as const) {
    await ask(ASK[key].text);
    const c = await liveCard();
    await rp.screenshot(panel, join(out, `${key}-panel.png`));
    if (c) { await sleep(800); await rp.click(panel, `[data-send-confirm="${c.id}"] .send-confirm-no`); }
    await answered(`${key.toUpperCase()} 完成。`).catch(() => {});
    await sleep(500);
    const n = posts.filter(p => p === path).length;
    check(`${key} 点「${ASK[key].label}」先在侧栏出确认卡，选「先不发」后服务器 0 条`, !!c && n === 0, { card: c?.text ?? null, posts: n });
  }

  const before3 = await cards();
  await ask(ASK.q3.text);
  await answered("Q3 完成。");
  const opened = await rp.evaluate(work, 'document.querySelector("#reply-box").hidden === false');
  check("q3 点展开用的「回复」：不出卡，回复框展开", (await cards()) === before3 && opened === true, { cards: (await cards()) - before3, opened: opened as Json });

  const before4 = await cards();
  await ask(ASK.q4.text);
  await answered("Q4 完成。");
  const sorted = await rp.evaluate(work, 'document.querySelector("#sorted").textContent');
  check("q4 点排序用的「发布时间」：不出卡，照常排序", (await cards()) === before4 && sorted === "按发布时间", { cards: (await cards()) - before4, sorted: sorted as Json });
  await rp.screenshot(panel, join(out, "q4-panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, posts, notCovered: ["真实网站、真模型", "回车发布、脚本发布"] }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.length < 4 || checks.some(c => !c.pass)) process.exitCode = 1;
