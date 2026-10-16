import { createServer } from "node:http";
const OLD_TITLE = "草稿-OLD7731";
const SECRET = "pw-SECRET9948";
const CODE = "PICKUP-CODE5521";
const NEW_TITLE = "周会纪要";
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
let saves = [];
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/__saves") { res.end(JSON.stringify(saves)); return; }
  if (url.pathname === "/__reset") { saves = []; res.end("ok"); return; }
  if (url.pathname === "/save") { saves.push(url.searchParams.get("title") ?? ""); res.writeHead(204).end(); return; }
  if (url.pathname === "/autosave") { setTimeout(() => res.writeHead(204).end(), 1500); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
}).listen(8943, "127.0.0.1");
