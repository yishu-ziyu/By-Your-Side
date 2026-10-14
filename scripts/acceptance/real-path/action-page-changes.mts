/**
 * 点击、填写、回车、选择之后，工具结果直接带回“页面上新出现了什么”，模型不用再读一次页（docs/evals/20261014-action-page-changes.md）。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/action-page-changes.mts --headless
 * 练习页是一长页笔记（3000 段正文，约 1.5 万个无障碍节点），上面还有：
 *   每 250 毫秒跳一次的时钟；「备注」框（每打一个字就自动保存，网站 1.5 秒后才回话；回车后出现“备注已保存”）；
 *   没写 role 的编辑器「正文」；没有反应的「刷新」按钮；「分类」下拉框（选“项目”后多出一个「项目名」框）；
 *   「新建笔记」：弹出对话框（标题框原来写着草稿名、口令框、提货码框 autocomplete=one-time-code、「保存」），同时像常见弹窗库那样给 body 加 modal-open、锁滚动。
 *   往标题框填字后，对话框里出现“原标题「草稿名」已替换”；点「保存」向服务器报标题并关掉对话框。
 *   分两组的文件，每行是文件名链接、大小（都是“2 MB”）和「Share」：第一组两行，第二组只有一行，组标题比这一行的字长（按日期分组的列表）。
 *   点「整理」给每行各加一个「Delete」（几处分开变化，同名控件不在同一棵读到的树里）。
 *   两列看板，每列只有一张卡片，卡片里有「Move」（点了展开）；「加卡片」往第二列加一张字更长的卡片。
 *   三条帖子，每条里只有我的回复带「Edit」（点了展开），回复很短：前两条都是“谢谢”，第三条是“收到”；第一、三条帖子里还有一条别人的、字更长的评论。
 *   两条同一作者的推文：头一行是作者、时间链接和「Options」（点了展开），下面是正文。
 *   三张像 Memos 的卡片：每张开头是「now」「More」两个按钮，再是正文；「More」弹出挂在 body 上的菜单，「Pin」把这张移到最上面并多出「Unpin」。
 * 脚本模型开头读一次页；之后要用的编号如果结果里没有，它就再读一次页（所以“只读了一次页”这条能失败）。
 *   a 点击结果带回标题框和「保存」的编号（读页时没有），不带整页正文、不带读页时已有的元素、不带跳动的时钟，不超过 2000 字。
 *   b 照结果里的编号填写、保存：服务器收到标题，对话框关掉；整轮只读了一次页。
 *   c 口令、提货码的值不出现在任何结果里；填写结果带回新提示，不带被替换的旧标题；往编辑器里填的字不当成新出现的内容。
 *   d 回车结果带回“备注已保存”；选择结果带回「项目名」框。
 *   e 点没有反应的按钮：结果照旧警告“没有可归因的变化，别盲目重复”，不把跳动的时钟当成新内容。
 *   g 点「显示帮助」：页面只给 body 换一个 class，让预先画好的帮助显出来；结果说“这一页一大块变了”，不是什么都没有。
 *   h 填数量框（填完它自己换校验 class）：结果不把这个数量框当成新出现的。
 *   i 点第二张卡片的「More」：展开的按钮行写明在“读书笔记”那一项；对话框里的新栏不带这句（不在重复的项里）。
 *   k 点「整理」：每个新的「Delete」写明在哪一行，用的是文件名不是大小（只读到按钮所在的小容器，要问浏览器祖先），第二组那一行不认成整组，不卡住。
 *   l 先「加卡片」，再点第二列原来那张的「Move」：写明的是原来那张，不是新加的那张（认的时候每列只有一张，记下的是整列）。
 *   m 点第一条帖子里我的「Edit」（两条“谢谢”分不清）：不说在哪一项，绝不说成旁边别人的评论；点第三条的「Edit」：写明在“收到”这条。
 *   n 点第二条推文的「Options」：两条的头一行都是同一个作者，分不清，就不说在哪一项，不说“Alice”。
 *   j 点「Pin」：新出现的「Unpin」写明在“读书笔记”那一项（它在页面上只有一个，靠记下的那张卡片认出来）。
 *   f 工具为此多花的时间（扩展后台记的毫秒数）中位数不超过 300 毫秒，带回内容的每一步、每一次填写和选择也都不超过 300 毫秒（备注框的请求 1.5 秒才回来，不能等它）。
 * 失败方式：关掉变化摘要（pageChangesAfter、watchChangesAfter 直接返回 undefined），a、b、d 失败；改回动作后读整页，f 失败；
 * 去掉“动作前就在跳字的不算”，e 失败；不认所在那一项（repeatedItems 直接返回空表），i、j、k 失败；同名控件分在两处时找共同祖先不停（审查复现过），k 超时失败；读项文字前不往下收窄，l 失败；字从记下的最高那层读，或分不清时往上走进别人的评论，m 失败；头一行的字不和同组比、直接用，n 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-action-page-changes`);

await mkdir(out, { recursive: true });

const OLD_TITLE = "草稿-OLD7731";
const SECRET = "pw-SECRET9948";
const CODE = "PICKUP-CODE5521";
const NEW_TITLE = "周会纪要";
const EDITOR_TEXT = "编辑器正文ECHO4417";
// 大页面（约 1.5 万个无障碍节点）：整页读一次要半秒以上，只读变过的几处才进得了时间预算。
// 再大（6000 段）时，机器忙的时候开头那次读页会超过 8 秒、退回简化快照，用例就测不到要测的东西了。
const LONG = Array.from({ length: 3000 }, (_, i) => `<p>第 ${i + 1} 段：这是一段很长的笔记正文，<a href="#p${i}">链接 ${i + 1}</a>。</p>`).join("");
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>笔记</title><body style="font:16px sans-serif;margin:40px">
<h1>我的笔记</h1>
<p>时钟 <span id="clock">00:00:00</span></p>
<p><label>备注 <input id="memo" aria-label="备注"></label> <button id="new" type="button">新建笔记</button> <button id="dead" type="button">刷新</button></p>
<p><label>分类 <select id="kind" aria-label="分类"><option>笔记</option><option>项目</option></select></label></p>
<div id="editor" contenteditable="true" aria-label="正文" style="border:1px solid #ccc;min-height:2em"></div>
<p><button id="help" type="button" onclick="document.body.classList.toggle('show-help')">显示帮助</button> <label>数量 <input id="qty" type="number" aria-label="数量" oninput="this.className = this.value > 0 ? 'ok' : 'bad'"></label></p>
<style>.help { display: none } body.show-help .help { display: block }</style>
<div class="help"><p>帮助：先写标题再保存。</p><button type="button">知道了</button></div>
<div id="files">
<section><div class="row"><a href="#a">文件甲：季度报告.pdf</a> <span>2 MB</span><div class="acts"><button type="button">Share</button></div></div>
<div class="row"><a href="#b">文件乙：会议纪要.docx</a> <span>2 MB</span><div class="acts"><button type="button">Share</button></div></div></section>
<section><h3>上周上传的文件（这一组目前只有一个）</h3><div class="row"><a href="#c">文件丙.txt</a> <span>2 MB</span><div class="acts"><button type="button">Share</button></div></div></section>
</div>
<p><button id="tidy" type="button">整理</button></p>
<div id="board">
<div class="col"><h4>周一</h4><div class="card"><p>周一：交房租</p><button type="button" class="mv" aria-expanded="false">Move</button></div></div>
<div class="col"><h4>周二</h4><div class="card"><p>周二：取快递</p><button type="button" class="mv" aria-expanded="false">Move</button></div></div>
</div>
<p><button id="addcard" type="button">加卡片</button></p>
<div id="tweets">
<div class="tw"><div class="hd"><a href="#u">Alice</a> · <a href="#t1">2h</a> <button type="button" class="op" aria-expanded="false">Options</button></div><p>第一条推文：周末去爬山</p></div>
<div class="tw"><div class="hd"><a href="#u">Alice</a> · <a href="#t2">3h</a> <button type="button" class="op" aria-expanded="false">Options</button></div><p>第二条推文：新书到了</p></div>
</div>
<div id="feed">
<div class="post"><div class="cm"><p>谢谢</p><button type="button" class="ed" aria-expanded="false">Edit</button></div><div class="cm"><p>别人的评论：这是一段比我的回复长得多的评论内容</p></div></div>
<div class="post"><div class="cm"><p>谢谢</p><button type="button" class="ed" aria-expanded="false">Edit</button></div></div>
<div class="post"><div class="cm"><p>收到</p><button type="button" class="ed" aria-expanded="false">Edit</button></div><div class="cm"><p>另一位的评论：同样比我的回复长得多的一段话</p></div></div>
</div>
<div id="cards">
<div class="card"><div class="head"><button type="button">now</button><button type="button" class="more" aria-label="More">⋯</button></div><p>会议纪要：周三发布，周一冻结代码。</p></div>
<div class="card"><div class="head"><button type="button">now</button><button type="button" class="more" aria-label="More">⋯</button></div><p>读书笔记：第三章讲地方政府融资。</p></div>
<div class="card"><div class="head"><button type="button">now</button><button type="button" class="more" aria-label="More">⋯</button></div><p>买菜：牛奶、鸡蛋、西红柿。</p></div>
</div>
${LONG}
<script>
let tick = 0;
setInterval(() => { tick++; document.getElementById("clock").textContent = "00:00:" + String(tick % 60).padStart(2, "0") + "时钟"; }, 250);
const memo = document.getElementById("memo");
// 每打一个字就自动保存：网站很慢才回话。
memo.addEventListener("input", () => fetch("/autosave?v=" + encodeURIComponent(memo.value)));
memo.addEventListener("keydown", e => { if (e.key === "Enter") { const p = document.createElement("p"); p.setAttribute("role", "status"); p.textContent = "备注已保存"; memo.parentElement.after(p); } });
document.getElementById("kind").addEventListener("change", e => {
  if (e.target.value !== "项目" || document.getElementById("project")) return;
  const p = document.createElement("p");
  p.innerHTML = '<label>项目名 <input id="project" aria-label="项目名"></label>';
  e.target.closest("p").after(p);
});
document.getElementById("board").addEventListener("click", e => { const b = e.target.closest(".mv"); if (b) b.setAttribute("aria-expanded", b.getAttribute("aria-expanded") === "true" ? "false" : "true"); });
document.getElementById("tweets").addEventListener("click", e => { const b = e.target.closest(".op"); if (b) b.setAttribute("aria-expanded", "true"); });
document.getElementById("feed").addEventListener("click", e => { const b = e.target.closest(".ed"); if (b) b.setAttribute("aria-expanded", "true"); });
document.getElementById("addcard").onclick = () => document.querySelectorAll("#board .col")[1].insertAdjacentHTML("beforeend", '<div class="card"><p>周二：新加的一张字更长的卡片，用来把整列里最长的文字换掉</p><button type="button" class="mv" aria-expanded="false">Move</button></div>');
document.getElementById("tidy").onclick = () => { for (const acts of document.querySelectorAll(".acts")) acts.insertAdjacentHTML("beforeend", '<button type="button">Delete</button>'); };
// 像 Memos：菜单挂在 body 上，和卡片没有包含关系；置顶把整张卡片挪到最上面。
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
  };
  document.body.append(menu);
};
document.getElementById("new").onclick = () => {
  const box = document.createElement("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "新建笔记");
  box.style.cssText = "position:fixed;top:80px;left:80px;padding:24px;background:#fff;border:1px solid #888";
  box.innerHTML = '<p><label>标题 <input id="title" aria-label="标题" value="${OLD_TITLE}"></label></p>'
    + '<p><label>口令 <input id="pw" type="password" aria-label="口令" value="${SECRET}"></label></p>'
    + '<p><label>提货 <input id="code" autocomplete="one-time-code" aria-label="提货" value="${CODE}"></label></p>'
    + '<p id="hint" role="status"></p><button id="save" type="button">保存</button>';
  document.body.append(box);
  // 和常见弹窗库一样，打开时锁住页面滚动：给 body 加类、改样式。
  document.body.classList.add("modal-open");
  document.body.style.overflow = "hidden";
  const title = box.querySelector("#title");
  title.addEventListener("input", () => { box.querySelector("#hint").textContent = "原标题「${OLD_TITLE}」已替换"; });
  box.querySelector("#save").onclick = () => { fetch("/save?title=" + encodeURIComponent(title.value)); box.remove(); };
};
</script></body></html>`;

const saves: string[] = [];
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/save") { saves.push(url.searchParams.get("title") ?? ""); res.writeHead(204).end(); return; }
  if (url.pathname === "/autosave") { setTimeout(() => res.writeHead(204).end(), 1500); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "新建验收：备注写随手记并回车，正文写好，点刷新，分类选项目，再新建一条笔记，标题写周会纪要，保存。";
const FINAL = "笔记已保存。";
// 编号在前一步的结果里才知道：onPayload 从结果原文里填进这些参数，模型服务在回复前才序列化它们。
const t = {
  memo: { target: "", value: "随手记" }, editor: { target: "loc=css:#editor", value: EDITOR_TEXT }, dead: { target: "" },
  kind: { target: "", values: "项目" }, help: { target: "" }, qty: { target: "", value: "3" }, open: { target: "" }, title: { target: "", value: NEW_TITLE }, save: { target: "" },
  more: { target: "" }, pin: { target: "" }, tidy: { target: "" }, addcard: { target: "" }, move: { target: "" }, edit: { target: "" }, edit3: { target: "" }, options: { target: "" },
};
const flow: Array<{ tool: { name: string; args: object } } | { text: string }> = [
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "fill", args: t.memo } },
  { tool: { name: "press_key", args: { key: "Enter" } } },
  { tool: { name: "fill", args: t.editor } },
  { tool: { name: "click", args: t.dead } },
  { tool: { name: "select_option", args: t.kind } },
  { tool: { name: "click", args: t.help } },
  { tool: { name: "fill", args: t.qty } },
  { tool: { name: "click", args: t.open } },
  { tool: { name: "fill", args: t.title } },
  { tool: { name: "click", args: t.save } },
  { tool: { name: "click", args: t.more } },
  { tool: { name: "click", args: t.pin } },
  { tool: { name: "click", args: t.tidy } },
  { tool: { name: "click", args: t.addcard } },
  { tool: { name: "click", args: t.move } },
  { tool: { name: "click", args: t.edit } },
  { tool: { name: "click", args: t.edit3 } },
  { tool: { name: "click", args: t.options } },
  { text: FINAL },
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
const timings: Array<{ ms: number; chars: number; kind: string }> = [];
let peeked = false;

/** 回到模型的每个工具结果原文（每次请求带着全部历史，按调用编号去重）。 */
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
    const ref = (re: RegExp) => re.exec(text)?.[1];
    if (call?.name === "snapshot" && !t.memo.target) {
      t.memo.target = `@${ref(/\[ref=(\d+)\] textbox "备注"/) ?? ""}`;
      t.open.target = `@${ref(/\[ref=(\d+)\] button "新建笔记"/) ?? ""}`;
      t.dead.target = `@${ref(/\[ref=(\d+)\] button "刷新"/) ?? ""}`;
      t.kind.target = `@${ref(/\[ref=(\d+)\] combobox "分类"/) ?? ""}`;
      t.help.target = `@${ref(/\[ref=(\d+)\] button "显示帮助"/) ?? ""}`;
      t.qty.target = `@${ref(/\[ref=(\d+)\] spinbutton "数量"/) ?? ""}`;
      // 第二张卡片（读书笔记）的「More」：快照里它排在读书笔记正文前面。
      t.options.target = `@${[...text.matchAll(/\[ref=(\d+)\] button "Options"/g)][1]?.[1] ?? ""}`;
      t.edit.target = `@${ref(/\[ref=(\d+)\] button "Edit"/) ?? ""}`;
      t.edit3.target = `@${[...text.matchAll(/\[ref=(\d+)\] button "Edit"/g)][2]?.[1] ?? ""}`;
      t.addcard.target = `@${ref(/\[ref=(\d+)\] button "加卡片"/) ?? ""}`;
      // 第二列原来那张卡片的「Move」。
      t.move.target = `@${[...text.matchAll(/\[ref=(\d+)\] button "Move"/g)][1]?.[1] ?? ""}`;
      t.tidy.target = `@${ref(/\[ref=(\d+)\] button "整理"/) ?? ""}`;
      t.more.target = `@${[...text.matchAll(/\[ref=(\d+)\] button "More"/g)][1]?.[1] ?? ""}`;
    }
    if (call?.name === "click" && call.arguments.includes(`"${t.more.target}"`)) t.pin.target = `@${ref(/\[ref=(\d+)\] menuitem "Pin"/) ?? ""}`;
    // 标题框和「保存」：从点开对话框的结果里拿；拿不到就像真模型一样再读一次页，从那次读页里拿。
    if ((call?.name === "click" && call.arguments.includes(t.open.target)) || (call?.name === "snapshot" && peeked)) {
      const title = ref(/\[ref=(\d+)\] textbox "标题"/), save = ref(/\[ref=(\d+)\] button "保存"/);
      if (title && save) { t.title.target = `@${title}`; t.save.target = `@${save}`; }
      else if (!peeked) { peeked = true; flow.splice(flow.findIndex(s => "tool" in s && s.tool.args === t.title), 0, { tool: { name: "snapshot", args: {} } }); }
    }
  }
}

/** 结果里“新出现了什么”那一段（包在网页内容标记里）。 */
const appearedPart = (text: string) => /(?:New on the page|Also new on the page) since you last read it[^\n]*\n(<page-content untrusted>[\s\S]*?<\/page-content>)/.exec(text)?.[1] ?? "";
const receiptOf = (name: string, args: { target: string }) => receipts.find(r => r.name === name && r.args.includes(`"${args.target}"`))?.text ?? "";

try {
  const work = await rp.attach((await rp.targets()).find(x => x.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  rp.cdp.onEvent("Runtime.consoleAPICalled", (message: { sessionId?: string; params: { args?: Array<{ value?: Json }> } }) => {
    const args = message.params.args ?? [];
    if (message.sessionId === sw && args[0]?.value === "[page-changes]") timings.push(JSON.parse(String(args[1]?.value)));
  });
  await rp.cdp.send("Runtime.enable", {}, sw);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(FINAL)}))`)) as boolean, 120_000, `回答「${FINAL}」`);
  await until(async () => saves.length > 0 || null, 3_000, "保存到达").catch(() => {});

  const snapshotText = receipts.find(r => r.name === "snapshot")?.text ?? "";
  const shown = appearedPart(receiptOf("click", t.open));
  const refsNew = [t.title.target, t.save.target].every(x => /^@\d+$/.test(x) && !snapshotText.includes(`[ref=${x.slice(1)}]`));
  check("a 点击结果带回标题框和「保存」的编号（读页时没有），不带整页正文、读页时已有的元素和时钟，不超过 2000 字", refsNew && /textbox "标题"/.test(shown) && !/第 \d+ 段|时钟/.test(shown) && !shown.includes(`[ref=${t.open.target.slice(1)}]`) && shown.length <= 2000 + 80, { title: t.title.target, save: t.save.target, chars: shown.length, shown });

  const dialogGone = await rp.evaluate(work, '!document.querySelector("[role=dialog]")');
  const snapshots = receipts.filter(r => r.name === "snapshot").length;
  check("b 照结果里的编号填写、保存：服务器收到标题，对话框关掉；整轮只读了一次页", saves.includes(NEW_TITLE) && dialogGone === true && snapshots === 1, { saves, dialogGone, snapshots, calls: receipts.map(r => r.name) });

  const titleReceipt = receiptOf("fill", t.title);
  const editorReceipt = receiptOf("fill", t.editor);
  const leaked = receipts.filter(r => r.text.includes("SECRET9948") || r.text.includes("CODE5521")).map(r => r.name);
  check("c 口令、提货码不出现在任何结果里；填写结果带回新提示，不带被替换的旧标题；编辑器里填的字不算新出现的", leaked.length === 0 && /已替换/.test(appearedPart(titleReceipt)) && !titleReceipt.includes("OLD7731") && /Filled/.test(editorReceipt) && !appearedPart(editorReceipt).includes("ECHO4417"), { leaked, titleReceipt, editorReceipt });

  const enterReceipt = receipts.find(r => r.name === "press_key")?.text ?? "";
  const selectReceipt = receiptOf("select_option", t.kind);
  check("d 回车结果带回“备注已保存”；选择结果带回「项目名」框", /备注已保存/.test(appearedPart(enterReceipt)) && /textbox "项目名"/.test(appearedPart(selectReceipt)), { enterReceipt, selectReceipt });

  const deadReceipt = receiptOf("click", t.dead);
  check("e 点没有反应的按钮：照旧警告没有可归因的变化、别盲目重复，不把跳动的时钟当成新内容", /Nothing on the page changed|nothing was attributable/.test(deadReceipt) && /Do not blindly/.test(deadReceipt) && !/时钟/.test(deadReceipt), { deadReceipt });

  const helpReceipt = receiptOf("click", t.help);
  check("g 只给 body 换 class 显出帮助：结果说这一页一大块变了", /A large part of this page changed/.test(helpReceipt), { helpReceipt });
  const qtyReceipt = receiptOf("fill", t.qty);
  check("h 数量框自己换了校验 class：结果不把它当成新出现的", /^@\d+$/.test(t.qty.target) && /Filled/.test(qtyReceipt) && !/spinbutton/.test(appearedPart(qtyReceipt)), { qtyReceipt });

  const moreShown = appearedPart(receiptOf("click", t.more));
  check("i 点第二张卡片的「More」：展开的按钮行写明在读书笔记那一项；对话框里的新栏不带这句", /button "More" expanded[^\n]* — in item "读书笔记/.test(moreShown) && !/in item/.test(shown), { more: t.more.target, moreShown, dialog: shown });

  const pinReceipt = receiptOf("click", t.pin);
  const top = await rp.evaluate(work, 'document.querySelector("#cards .card p")?.textContent ?? ""');
  check("j 点「Pin」：新出现的「Unpin」写明在读书笔记那一项", /button "Unpin" — in item "读书笔记/.test(appearedPart(pinReceipt)) && String(top).startsWith("读书笔记"), { pin: t.pin.target, top, pinReceipt });

  const tidyShown = appearedPart(receiptOf("click", t.tidy));
  check("k 点「整理」：每个新的「Delete」写明在哪一行，第二组那一行不认成整组，不卡住", ["文件甲", "文件乙", "文件丙.txt\""].every(x => tidyShown.includes(`button "Delete" — in item "${x}`)), { tidy: t.tidy.target, tidyShown });

  const moveShown = appearedPart(receiptOf("click", t.move));
  check("l 先加卡片，再点第二列原来那张的「Move」：写明的是原来那张", /button "Move" expanded[^\n]* — in item "周二：取快递"/.test(moveShown), { move: t.move.target, moveShown, added: appearedPart(receiptOf("click", t.addcard)) });

  const editShown = appearedPart(receiptOf("click", t.edit));
  const edit3Shown = appearedPart(receiptOf("click", t.edit3));
  check("m 两条“谢谢”分不清：不说在哪一项，绝不说成别人的评论；第三条写明在“收到”", /button "Edit" expanded/.test(editShown) && !/in item/.test(editShown) && /button "Edit" expanded[^\n]* — in item "收到"/.test(edit3Shown), { edit: t.edit.target, editShown, edit3: t.edit3.target, edit3Shown });

  const optionsShown = appearedPart(receiptOf("click", t.options));
  check("n 两条推文头一行都是同一个作者：不说在哪一项，不说“Alice”", /button "Options" expanded/.test(optionsShown) && !/in item/.test(optionsShown), { options: t.options.target, optionsShown });

  const sorted = timings.map(x => x.ms).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : NaN;
  const brought = timings.filter(x => x.chars > 0).map(x => x.ms);
  const watched = timings.filter(x => x.kind === "watch").map(x => x.ms);
  check("f 多花的时间中位数不超过 300 毫秒，带回内容的每一步、每次填写和选择都不超过 300 毫秒", sorted.length >= 6 && median <= 300 && brought.length >= 3 && Math.max(...brought, ...watched) <= 300 && watched.length >= 3, { median, brought, watched, timings });
  await rp.screenshot(panel, join(out, "panel.png"));
  await rp.screenshot(work, join(out, "page.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", checks, saves, timings, receipts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", out }, null, 2));
if (checks.some(c => !c.pass)) process.exitCode = 1;
