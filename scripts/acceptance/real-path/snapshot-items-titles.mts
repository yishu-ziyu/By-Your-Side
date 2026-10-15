/**
 * 读整页时：列表里每项都有的同名控件写明在哪一项（#396），链接、标题的名字给全、不截在 60 字（#397）；分不清时不说，整页仍在预算内。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/snapshot-items-titles.mts --headless
 * 练习页（每页一个 h1，按它认是哪一页的读页）：
 *   /hn    像 HN 首页的 30 条（排名、upvote、标题链接、站点链接、分数、作者、时间、hide、评论数；表格排版），第一条标题超过 100 字。
 *   /memos 三张像 Memos 的卡片：开头是「now」「More」，再是正文；「More」弹出挂在 body 上的菜单，「Pin」把这张移到最上面并多出「Unpin」。
 *          两条同一作者的推文（头一行作者、时间、「Options」）；三条帖子里我的回复带「Edit」，前两条都是“谢谢”，第三条是“收到”，旁边有别人更长的评论。
 *   /notes 3000 段正文的长页（超预算，要截掉正文行）。
 *   /table 100 行的表格：每行名字、两个“Yes/No”单元格和一个「Edit」按钮。
 * 脚本模型：打开 /hn 读页，照第一条那一行的名字回答标题；打开 /memos 读页，挑行尾写着“买菜”的那个「More」点开、点「Pin」；再读 /notes、/table。
 *   a 快照里第一条的标题是完整的（超过 100 字），读到的每条标题都完整、没有“...”；侧栏回答里是完整标题。
 *     （30 条的可交互行本身就超预算，末尾几条按文档顺序截掉，改动前后都是这样；读到几条记在 result.json。）
 *   b Memos 页每个「More」行尾都写了在哪一项，写的正是它真实所在那张卡片（按 ref 回页面查 .card）。
 *   c 照写着“买菜”的「More」点开再点「Pin」：网站收到的置顶是买菜那条；点击结果里的「Unpin」写明在“买菜”那一项（动作后的变化摘要用的是同一个写法）。
 *   d 分不清的不说：两条推文的「Options」都不写在哪一项；第一条“谢谢”的「Edit」旁边有别人的评论，不写（绝不说成别人那条）；“收到”那条写明“收到”。
 *   e 链接和表格单元格不写在哪一项（HN 的站点链接、表格里的“Yes”），「Edit」按钮写；每次读页都不超过预算（24000 字加截断说明）。
 * 结果里记下每一页快照的字数（result.json 的 sizes），换 SIDEAGENT_ACCEPTANCE_DIST 跑改动前的扩展可以对比。
 * 失败方式：链接、标题仍按 60 字截，a 失败；整页快照不给“在哪一项”（itemTexts 返回空表），b、c 失败；from = -1 时也说，d 失败；链接、表格单元格也写，e 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-snapshot-items-titles`);

await mkdir(out, { recursive: true });

const MAX_SNAPSHOT = 24_000 + 300;
const FIRST_TITLE = "Things to know when you get cancer: a practical guide from someone who went through chemotherapy twice, 2019 to 2026";
const TITLES = [FIRST_TITLE, ...Array.from({ length: 29 }, (_, i) => i % 3 === 0
  ? `Story ${i + 2}: a fairly long headline that keeps going well past sixty characters so that it used to be cut`
  : `Story ${i + 2}: short title`)];
const SITES = ["jjmaxwell4.com", "github.com", "anoma.ly", "github.com", "nytimes.com"];

const HN = `<!doctype html><html lang="en"><meta charset="utf-8"><title>HN</title><body><h1>HN 列表</h1>
<table id="hnmain"><tr><td><table class="itemlist">${TITLES.map((title, i) => `<tr class="athing submission" id="${1000 + i}"><td class="title"><span class="rank">${i + 1}.</span></td><td class="votelinks"><center><a id="up_${1000 + i}" href="#vote${i}"><div class="votearrow" title="upvote"></div></a></center></td><td class="title"><span class="titleline"><a href="https://story${i + 1}.example/">${title}</a><span class="sitebit comhead"> (<a href="#from${i}"><span class="sitestr">${SITES[i % SITES.length]}</span></a>)</span></span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score">${100 + i * 7} points</span> by <a href="#user${i}" class="hnuser">user${i}</a> <span class="age"><a href="#item${i}">${i + 1} hours ago</a></span> | <a href="#hide${i}">hide</a> | <a href="#item${i}">${i * 3}&nbsp;comments</a></span></td></tr><tr class="spacer" style="height:5px"></tr>`).join("\n")}</table></td></tr></table></body></html>`;

const MEMOS = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Memos</title><body><h1>Memos 列表</h1>
<div id="tweets">
<div class="tw"><div class="hd"><a href="#u">Alice</a> · <a href="#t1">2h</a> <button type="button" class="op">Options</button></div><p>第一条推文：周末去爬山</p></div>
<div class="tw"><div class="hd"><a href="#u">Alice</a> · <a href="#t2">3h</a> <button type="button" class="op">Options</button></div><p>第二条推文：新书到了</p></div>
</div>
<div id="feed">
<div class="post"><div class="cm"><p>谢谢</p><button type="button" class="ed">Edit</button></div><div class="cm"><p>别人的评论：这是一段比我的回复长得多的评论内容</p></div></div>
<div class="post"><div class="cm"><p>谢谢</p><button type="button" class="ed">Edit</button></div></div>
<div class="post"><div class="cm"><p>收到</p><button type="button" class="ed">Edit</button></div><div class="cm"><p>另一位的评论：同样比我的回复长得多的一段话</p></div></div>
</div>
<div id="cards">
<div class="card"><div class="head"><button type="button">now</button><button type="button" class="more" aria-label="More">⋯</button></div><p>会议纪要：周三发布，周一冻结代码。</p></div>
<div class="card"><div class="head"><button type="button">now</button><button type="button" class="more" aria-label="More">⋯</button></div><p>读书笔记：第三章讲地方政府融资。</p></div>
<div class="card"><div class="head"><button type="button">now</button><button type="button" class="more" aria-label="More">⋯</button></div><p>买菜：牛奶、鸡蛋、西红柿。</p></div>
</div>
<script>
for (const more of document.querySelectorAll(".more")) more.onclick = () => {
  more.setAttribute("aria-expanded", "true");
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "More");
  menu.style.cssText = "position:fixed;top:40px;right:40px;background:#fff;border:1px solid #888;padding:8px";
  menu.innerHTML = '<div role="menuitem" tabindex="0">Pin</div>';
  menu.firstElementChild.onclick = () => {
    menu.remove();
    more.setAttribute("aria-expanded", "false");
    const card = more.closest(".card");
    card.querySelector(".head").insertAdjacentHTML("beforeend", '<button type="button" class="unpin">Unpin</button>');
    card.parentElement.prepend(card);
    fetch("/pin?c=" + encodeURIComponent(card.querySelector("p").textContent));
  };
  document.body.append(menu);
};
</script></body></html>`;

const NOTES = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>长笔记</title><body><h1>长笔记</h1>
${Array.from({ length: 3000 }, (_, i) => `<p>第 ${i + 1} 段：这是一段很长的笔记正文，<a href="#p${i}">链接 ${i + 1}</a>。</p>`).join("")}</body></html>`;

const TABLE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Table</title><body><h1>表格</h1>
<table><thead><tr><th>Name</th><th>Active</th><th>Admin</th><th></th></tr></thead><tbody>
${Array.from({ length: 100 }, (_, i) => `<tr><td>Person number ${i + 1}</td><td>${i % 2 ? "Yes" : "No"}</td><td>${i % 3 ? "No" : "Yes"}</td><td><button type="button">Edit</button></td></tr>`).join("\n")}
</tbody></table></body></html>`;

const PAGES: Record<string, string> = { "/hn": HN, "/memos": MEMOS, "/notes": NOTES, "/table": TABLE };
const pinned: string[] = [];
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/pin") { pinned.push(url.searchParams.get("c") ?? ""); res.writeHead(204).end(); return; }
  const page = PAGES[url.pathname];
  if (!page) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "读页验收：HN 第一条标题是什么？再把 Memos 里买菜那条置顶，然后看一下长笔记和表格。";
// 编号和要说的标题在前一步的结果里才知道：onPayload 从结果原文里填进去，模型服务在回复前才序列化它们。
const t = { more: { target: "" }, pin: { target: "" } };
const answer = { text: "" };
const flow: Array<{ tool: { name: string; args: object } } | { text: string }> = [
  { tool: { name: "navigate", args: { url: `${origin}/hn` } } },
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "navigate", args: { url: `${origin}/memos` } } },
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "click", args: t.more } },
  { tool: { name: "click", args: t.pin } },
  { tool: { name: "navigate", args: { url: `${origin}/notes` } } },
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "navigate", args: { url: `${origin}/table` } } },
  { tool: { name: "snapshot", args: {} } },
  answer,
];

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: flow },
], undefined, payload => onPayload(payload));

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Receipt = { name: string; args: string; text: string };
const receipts: Receipt[] = [];
const seenCalls = new Set<string>();
/** 工作标签页的 CDP 会话；「More」真实在哪张卡片，要趁还在 Memos 页时回页面查。 */
let workSession = "";
let moresRead: Promise<Array<{ ref: number; said: string; real: string }>> | undefined;
/** 每一页读到的快照原文（按 h1 认页）。 */
const snaps: Record<string, string> = {};
const PAGE_OF: Record<string, string> = { "HN 列表": "hn", "Memos 列表": "memos", "长笔记": "notes", "表格": "table" };

function onPayload(payload: { messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>; tools?: unknown[] }) {
  if (!payload.tools?.length) return;
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const m of payload.messages ?? []) for (const call of m.tool_calls ?? []) calls.set(call.id, call.function);
  for (const m of payload.messages ?? []) {
    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (m.role !== "tool" || seenCalls.has(id)) continue;
    seenCalls.add(id);
    const call = calls.get(id);
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    receipts.push({ name: call?.name ?? "?", args: call?.arguments ?? "", text });
    if (call?.name === "snapshot") {
      const page = Object.entries(PAGE_OF).find(([h1]) => text.includes(`heading "${h1}"`))?.[1];
      if (page) snaps[page] = text;
      if (page === "hn") answer.text = `HN 第一条：${/\[ref=\d+\] link "([^"\n]*)"[^\n]*url=https:\/\/story1\.example/.exec(text)?.[1] ?? "（没读到）"}。买菜那条已置顶。`;
      // 照行尾写的“在哪一项”挑买菜那条的「More」。
      if (page === "memos") { t.more.target = `@${/\[ref=(\d+)\] button "More"[^\n]* — in item "买菜/.exec(text)?.[1] ?? ""}`; moresRead = realCards(text); }
    }
    if (call?.name === "click" && t.more.target !== "@" && call.arguments.includes(`"${t.more.target}"`)) t.pin.target = `@${/\[ref=(\d+)\] menuitem "Pin"/.exec(text)?.[1] ?? ""}`;
  }
}

/** Memos 快照里每个「More」写的那一项，和按 ref 回页面查到的它真实所在的卡片。 */
async function realCards(text: string) {
  await rp.cdp.send("DOM.getDocument", { depth: 0 }, workSession);
  return Promise.all([...text.matchAll(/\[ref=(\d+)\] button "More"([^\n]*)/g)].map(async ([, ref, rest]) => {
    const said = / — in item "([^"]*)"/.exec(rest!)?.[1] ?? "";
    const node = await rp.cdp.send("DOM.resolveNode", { backendNodeId: Number(ref) }, workSession) as { object?: { objectId?: string } };
    const real = node.object?.objectId ? (await rp.cdp.send("Runtime.callFunctionOn", { objectId: node.object.objectId, functionDeclaration: "function(){return this.closest('.card')?.querySelector('p')?.textContent ?? ''}", returnByValue: true }, workSession) as { result?: { value?: string } }).result?.value ?? "" : "";
    return { ref: Number(ref), said, real };
  }));
}

/** 结果里“新出现了什么”那一段（包在网页内容标记里）。 */
const appearedPart = (text: string) => /(?:New on the page|Also new on the page) since you last read it[^\n]*\n(<page-content untrusted>[\s\S]*?<\/page-content>)/.exec(text)?.[1] ?? "";
const linesOf = (text: string, re: RegExp) => text.split("\n").filter(line => re.test(line));

try {
  const work = workSession = await rp.attach((await rp.targets()).find(x => x.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/notes` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("买菜那条已置顶"))`)) as boolean, 180_000, "回答");
  const shownAnswer = String(await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].map(m => m.textContent).join("\\n")`));

  const hn = snaps.hn ?? "";
  const titleLines = linesOf(hn, /link "[^"\n]*" [^\n]*url=https:\/\/story\d+\.example/);
  const wholeTitles = TITLES.filter(title => hn.includes(`link "${title}"`)).length;
  check("a 第一条标题完整（超过 100 字）、读到的每条标题都完整、没有“...”；侧栏回答里是完整标题", FIRST_TITLE.length > 100 && titleLines.length >= 20 && wholeTitles === titleLines.length && !titleLines.some(line => /\.\.\."/.test(line)) && shownAnswer.includes(FIRST_TITLE), { firstTitleChars: FIRST_TITLE.length, storiesShown: titleLines.length, wholeTitles, firstLines: titleLines.slice(0, 3), shownAnswer });

  const memos = snaps.memos ?? "";
  const mores = await (moresRead ?? Promise.resolve([])).catch(error => [{ ref: 0, said: "", real: String(error) }]);
  check("b 每个「More」行尾都写了在哪一项，写的正是它所在的那张卡片", mores.length === 3 && mores.every(m => m.said && m.real.startsWith(m.said.replace(/…$/, ""))), { mores });

  const pinReceipt = receipts.find(r => r.name === "click" && r.args.includes(`"${t.pin.target}"`))?.text ?? "";
  check("c 照写着“买菜”的「More」点开再点「Pin」：网站收到的置顶是买菜那条；结果里的「Unpin」写明在“买菜”", pinned.length === 1 && pinned[0]!.startsWith("买菜") && /button "Unpin" — in item "买菜/.test(appearedPart(pinReceipt)), { more: t.more.target, pin: t.pin.target, pinned, pinShown: appearedPart(pinReceipt) });

  const options = linesOf(memos, /button "Options"/);
  const edits = linesOf(memos, /button "Edit"/);
  check("d 分不清的不说：两条推文的「Options」不写在哪一项；第一条“谢谢”的「Edit」不写，绝不说成别人的评论；“收到”那条写明“收到”", options.length === 2 && options.every(line => !/in item/.test(line)) && edits.length === 3 && !/in item/.test(edits[0]!) && !/评论/.test(memos.split("\n").filter(line => / — in item /.test(line)).join("\n")) && / — in item "收到"$/.test(edits[2]!), { options, edits });

  const table = snaps.table ?? "";
  const sizes = Object.fromEntries(Object.entries(snaps).map(([page, text]) => [page, text.length]));
  const linkOrCellNotes = [...linesOf(table, /\] cell [^\n]* — in item/), ...linesOf(hn, /\] link [^\n]* — in item/)];
  const editNotes = linesOf(table, /\] button "Edit" — in item "Person number/);
  check("e 链接和表格单元格不写在哪一项，「Edit」按钮写；每页快照都不超过预算", Object.keys(sizes).length === 4 && linkOrCellNotes.length === 0 && /\] cell "Yes"/.test(table) && /\] link "github\.com"/.test(hn) && editNotes.length > 0 && Object.values(sizes).every(n => n <= MAX_SNAPSHOT), { sizes, linkOrCellNotes: linkOrCellNotes.slice(0, 3), editNotes: editNotes.length, editLines: editNotes.slice(0, 2) });
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  const sizes = Object.fromEntries(Object.entries(snaps).map(([page, text]) => [page, text.length]));
  const hnStoriesShown = linesOf(snaps.hn ?? "", /url=https:\/\/story\d+\.example/).length;
  for (const [page, text] of Object.entries(snaps)) await writeFile(join(out, `snapshot-${page}.txt`), text);
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", dist: process.env.SIDEAGENT_ACCEPTANCE_DIST ?? "built from this checkout", sizes, hnStoriesShown, checks, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
