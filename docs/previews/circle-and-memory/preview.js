/* 预览脚本：侧栏是真实侧栏的 DOM + 真实样式；网页是真实网页截图；助手的手绘圈用产品自己的 sketchFrame。 */
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVG = "http://www.w3.org/2000/svg";

const SCENES = {
  circle: { url: "apple.com.cn/iphone", img: "apple.png", crop: 70, h: 730 },
  memory: { url: "hotels.ctrip.com", img: "trip.png", crop: 0, h: 800 },
};

/* 页面坐标（1100 宽的网页像素）里的目标 */
const APPLE = {
  pro: { x: 200, y: 292, w: 106, h: 122, name: "iPhone 18 Pro" },
  air: { x: 466, y: 296, w: 82, h: 102, name: "iPhone 17" },
  compare: { x: 853, y: 296, w: 70, h: 102, name: "机型比较" },
};
const TRIP = {
  dest: { x: 155, y: 287, w: 116, h: 32 },
  dates: { x: 316, y: 287, w: 222, h: 32 },
  nights: { x: 545, y: 290, w: 36, h: 26 },
  where: { x: 806, y: 283, w: 142, h: 40 },
};

let scene = "circle";
let run = 0; // 每次重来递增，旧动画自己停
let scale = 1;
let doc; // 侧栏 document
let strokes = []; // 用户圈：{ bbox, path }
let circling = false;

/* ── 布局 ── */
function fit() {
  const s = SCENES[scene];
  const vp = $("#vp");
  scale = vp.clientWidth / 1100;
  const pg = $("#pg");
  pg.style.transform = `scale(${scale})`;
  pg.style.width = "1100px";
  pg.style.height = `${s.h}px`;
  $("#shot").style.marginTop = `-${s.crop}px`;
  $("#ink").setAttribute("viewBox", `0 0 1100 ${s.h}`);
}
addEventListener("resize", fit);

/* 页面坐标 → 窗口（.win）坐标 */
function pagePt(x, y) {
  const vp = $("#vp").getBoundingClientRect(), win = $("#win").getBoundingClientRect();
  return { x: vp.left - win.left + x * scale, y: vp.top - win.top + y * scale };
}
function panelPt(sel, dx = 0.5, dy = 0.5) {
  const el = doc.querySelector(sel);
  const f = $("#panel").getBoundingClientRect(), win = $("#win").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: f.left - win.left + r.left + r.width * dx, y: f.top - win.top + r.top + r.height * dy };
}

/* ── 光标：沿一条带弧度的路径移动 ── */
const pos = { you: { x: 0, y: 0 }, ai: { x: 0, y: 0 } };
function place(who, p) { pos[who] = p; $("#" + who).style.transform = `translate(${p.x}px, ${p.y}px)`; }
function show(who, on = true) { $("#" + who).classList.toggle("on", on); }
async function move(who, to, ms = 700, my) {
  const from = { ...pos[who] };
  const dx = to.x - from.x, dy = to.y - from.y;
  const bend = Math.min(80, Math.hypot(dx, dy) * 0.18);
  const cx = from.x + dx / 2 - (dy / (Math.hypot(dx, dy) || 1)) * bend, cy = from.y + dy / 2 + (dx / (Math.hypot(dx, dy) || 1)) * bend;
  const t0 = performance.now();
  while (true) {
    if (my !== run) return;
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const x = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * to.x;
    const y = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * to.y;
    place(who, { x, y });
    if (t >= 1) break;
    await new Promise(requestAnimationFrame);
  }
}
function ripple(p, color) {
  const r = document.createElement("span");
  r.className = "ripple"; r.style.left = p.x + "px"; r.style.top = p.y + "px"; r.style.setProperty("--c", color);
  $("#cursors").append(r); setTimeout(() => r.remove(), 600);
}
function say(text) {
  const l = $("#ai .lbl");
  if (!text) { l.classList.remove("on"); return; }
  l.querySelector(".t").textContent = text; l.classList.add("on");
}
function narr(html) { $("#narr").innerHTML = html; }

/* ── 侧栏（真实 DOM）操作 ── */
function loadPanel() {
  return new Promise((res) => {
    const f = $("#panel");
    f.onload = () => { doc = f.contentDocument; res(); };
    f.srcdoc = PANEL_HTML;
  });
}
function app() { return doc.getElementById("app"); }
async function typeInput(text, my, per = 55) {
  const input = doc.getElementById("input");
  input.focus();
  for (const ch of text) {
    if (my !== run) return;
    input.value += ch; input.dispatchEvent(new Event("input"));
    await sleep(per);
  }
}
function userMessage(text, chips) {
  const msgs = doc.getElementById("messages");
  app().classList.remove("conversation-empty");
  const m = doc.createElement("div");
  m.className = "msg user"; m.innerHTML = `<div class="user-msg-text"></div>`;
  m.firstChild.textContent = text;
  msgs.append(m);
  if (chips?.length) {
    const c = doc.createElement("div");
    c.className = "ctx-chips";
    for (const t of chips) { const s = doc.createElement("span"); s.className = "ctx-chip"; s.innerHTML = `<span class="cl"></span>`; s.firstChild.textContent = t; c.append(s); }
    msgs.append(c);
  }
  const input = doc.getElementById("input"); input.value = ""; input.dispatchEvent(new Event("input"));
  input.blur();
  scrollEnd();
}
function scrollEnd() { const f = doc.getElementById("messages-frame") || doc.getElementById("messages"); f.scrollTop = 1e6; doc.getElementById("messages").scrollTop = 1e6; }
function setRunning(on) {
  const pill = doc.getElementById("status-pill"), text = doc.getElementById("status-text");
  pill?.classList.toggle("running", on);
  if (text) text.textContent = on ? "正在做" : "已连接";
}
/* 回答逐段出现：html 片段数组，每段内按字揭示 */
async function answer(parts, my) {
  const msgs = doc.getElementById("messages");
  const m = doc.createElement("div");
  m.className = "msg assistant markdown answer-latest";
  msgs.append(m);
  for (const part of parts) {
    if (my !== run) return m;
    const tmp = doc.createElement("div"); tmp.innerHTML = part;
    const node = tmp.firstElementChild;
    m.append(node);
    await revealText(node, my);
  }
  const acts = doc.createElement("div");
  acts.className = "answer-actions";
  acts.innerHTML = `<button type="button" aria-label="复制回答" title="复制回答"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg></button><span class="answer-time">${parts.length > 2 ? "9 秒" : "6 秒"}</span>`;
  m.append(acts);
  scrollEnd();
  return m;
}
async function revealText(node, my) {
  const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = []; while (walker.nextNode()) texts.push(walker.currentNode);
  const full = texts.map((t) => t.textContent); texts.forEach((t) => (t.textContent = ""));
  const hidden = [...node.querySelectorAll("button, .circle-ref")]; hidden.forEach((b) => (b.style.visibility = "hidden"));
  for (let i = 0; i < texts.length; i++) {
    for (let j = 0; j < full[i].length; j += 2) {
      if (my !== run) return;
      texts[i].textContent = full[i].slice(0, j + 2);
      scrollEnd();
      await sleep(22);
    }
    const btn = texts[i].parentElement?.closest?.("button, .circle-ref"); if (btn) btn.style.visibility = "";
  }
  hidden.forEach((b) => (b.style.visibility = ""));
}

/* ── 页面层 ── */
function clearPage() { $("#layer").replaceChildren(); $("#ink").replaceChildren(); strokes = []; }
function aiCircle(box, ms = 380, seed = 42) {
  const out = Rough.sketchFrame({ x: box.x - 6, y: box.y - 6, w: box.w + 12, h: box.h + 12 }, { seed, roughness: 0.9 });
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", out.d); p.setAttribute("stroke", "#2d4a86"); p.setAttribute("stroke-width", "2.5");
  $("#ink").append(p);
  const len = Math.ceil(p.getTotalLength());
  p.style.strokeDasharray = len; p.style.strokeDashoffset = len; p.getBoundingClientRect();
  p.style.transition = `stroke-dashoffset ${ms}ms ease-in-out`; p.style.strokeDashoffset = "0";
  return { path: p, frame: out.frame };
}
function tagcard(x, y, text) {
  const t = document.createElement("div");
  t.className = "tagcard"; t.style.left = x + "px"; t.style.top = y + "px";
  t.innerHTML = `<span class="orb-dot"></span><span></span>`; t.lastChild.textContent = text;
  $("#layer").append(t); requestAnimationFrame(() => t.classList.add("on"));
  return t;
}
function numBadge(x, y, n, ai = false) {
  const b = document.createElement("div");
  b.className = "num" + (ai ? " ai" : ""); b.style.left = x + "px"; b.style.top = y + "px"; b.textContent = n;
  $("#layer").append(b); requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add("on")));
  return b;
}
function userStrokePath() {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("stroke", "#d2602a"); p.setAttribute("stroke-width", "3"); p.setAttribute("opacity", ".9");
  $("#ink").append(p); return p;
}
function smoothD(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`; }
  const l = pts[pts.length - 1]; return d + ` L${l[0]} ${l[1]}`;
}
/* 像手画的一圈：起笔偏左上，绕一圈多一点，收笔越过起点 */
function handLoop(box, seed) {
  let s = seed; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280 - 0.5);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, rx = box.w / 2 + 16, ry = box.h / 2 + 14;
  const pts = []; const n = 46;
  for (let i = 0; i <= n; i++) {
    const a = -2.3 + (i / n) * Math.PI * 2.18;
    const k = 1 + rnd() * 0.05 + (i / n) * 0.05;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}
function bboxOf(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/* 圈完：页面加编号，输入框上方加一张带编号的缩略图（产品附件卡同款） */
function addCircle(pts, path) {
  const n = strokes.length + 1;
  const box = bboxOf(pts);
  strokes.push({ box, path });
  numBadge(box.x + 6, box.y + 6, n);
  const strip = doc.getElementById("attachments-strip");
  const tile = doc.createElement("div");
  tile.className = "tile-56 complete"; tile.style.position = "relative";
  const S = SCENES[scene];
  const side = Math.max(box.w, box.h) + 10, k = 56 / side;
  const ox = -(box.x + box.w / 2 - side / 2) * k, oy = -(box.y + S.crop + box.h / 2 - side / 2) * k;
  tile.innerHTML = `<div class="tile-img" style="position:absolute;inset:0;overflow:hidden;border-radius:inherit"><img alt="圈 ${n}" src="${S.img}" style="position:absolute;max-width:none;width:${1100 * k}px;left:${ox}px;top:${oy}px"></div><span style="position:absolute;left:4px;top:4px;width:18px;height:18px;border-radius:50%;background:#d2602a;color:#fff;font:600 11px/18px -apple-system,'PingFang SC',sans-serif;text-align:center;box-shadow:0 0 0 1.5px #fff">${n}</span><button type="button" class="tile-dismiss-btn" title="去掉这一圈">✕</button>`;
  tile.querySelector("button").onclick = () => { tile.remove(); path.remove(); if (!strip.children.length) strip.hidden = true; };
  strip.append(tile); strip.hidden = false;
}

function enterCircle(on) {
  circling = on;
  $("#vp").classList.toggle("circling", on);
}

/* 用户自己画 */
let live = null;
$("#catch").addEventListener("pointerdown", (e) => {
  if (!circling) return;
  const r = $("#pg").getBoundingClientRect();
  live = { pts: [[(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]], path: userStrokePath() };
  $("#catch").setPointerCapture(e.pointerId);
});
$("#catch").addEventListener("pointermove", (e) => {
  if (!live) return;
  const r = $("#pg").getBoundingClientRect();
  live.pts.push([(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]);
  live.path.setAttribute("d", smoothD(live.pts));
});
$("#catch").addEventListener("pointerup", () => {
  if (!live) return;
  const done = live; live = null;
  const b = bboxOf(done.pts);
  if (b.w < 14 && b.h < 14) { done.path.remove(); return; }
  addCircle(done.pts, done.path);
  narr(`圈了 <b>${strokes.length}</b> 处。再圈一处，或者在侧栏打字问，按回车发送。`);
});
addEventListener("keydown", (e) => { if (e.key === "Escape" && circling) { enterCircle(false); narr("已退出圈画。点侧栏输入框旁的 <b>+</b> 可以再进来。"); } });

/* ── 场景一：圈给它看 ── */
function circleMenuPatch() {
  const label = doc.querySelector("#menu-action-region .action-menu-item-label");
  if (label) label.innerHTML = `圈出来问 <span style="color:var(--text-tertiary);font-size:11px;margin-left:6px">⌘⇧S</span>`;
  doc.getElementById("menu-action-region").title = "在网页上圈出想问的地方，可以圈好几处";
}
function wireCircleMenu() {
  const btn = doc.getElementById("attach-btn"), menu = doc.getElementById("attach-menu");
  btn.onclick = () => { menu.hidden = !menu.hidden; };
  doc.getElementById("menu-action-region").onclick = () => { menu.hidden = true; enterCircle(true); narr("在左边网页上<b>按住拖动</b>圈出想问的地方。可以圈好几处，Esc 退出。"); };
  const input = doc.getElementById("input");
  const send = () => { if (!input.value.trim()) return; circleAnswer(input.value.trim(), run); };
  doc.getElementById("send-btn").onclick = send;
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
}
function refBtn(n) { return `<button type="button" class="circle-ref" data-ref="${n}" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin:0 3px;border-radius:50%;border:0;background:#2d4a86;color:#fff;font:600 11px/18px -apple-system,'PingFang SC',sans-serif;cursor:pointer;vertical-align:1px">${n}</button>`; }

async function circleAnswer(question, my) {
  const n = strokes.length;
  enterCircle(false);
  const chips = strokes.map((_, i) => `圈 ${i + 1}`);
  doc.getElementById("attachments-strip").replaceChildren(); doc.getElementById("attachments-strip").hidden = true;
  userMessage(question, chips.length ? chips : ["apple.com.cn"]);
  setRunning(true);
  for (const s of strokes) s.path.setAttribute("opacity", ".45");
  // 助手先在页面上看你圈的地方
  place("ai", pagePt(1080, 40)); show("ai");
  for (let i = 0; i < n; i++) {
    const b = strokes[i].box;
    say(i === 0 ? `我在看你圈的第 ${i + 1} 处` : `再看第 ${i + 1} 处`);
    await move("ai", pagePt(b.x + b.w * 0.6, b.y + b.h * 0.55), 650, my); if (my !== run) return;
    await sleep(380);
  }
  say("");
  const demo = n === 2 && strokes[0].box.x < 400 && strokes[1].box.x > 400 && strokes[1].box.x < 700;
  const parts = demo ? [
    `<p>按你平时的用法，两款的差别主要在这里：</p>`,
    `<ul><li>${refBtn(1)}<strong>iPhone 18 Pro</strong>：相机和续航更强，价格高一档。常拍照、经常出差就选它。</li><li>${refBtn(2)}<strong>iPhone 17</strong>：日常用够了，便宜不少。</li></ul>`,
    `<p>想逐项对参数，可以点页面上的「机型比较」，我圈出来了。</p>`,
  ] : [
    `<p>收到你圈的 ${strokes.map((_, i) => refBtn(i + 1)).join("")}。</p>`,
    `<p>真产品里我会读这几处的内容再回答。这里先演示：点回答里的编号，我会回到页面上那一处再圈给你看。</p>`,
  ];
  const ansP = answer(parts, my);
  if (demo) {
    await sleep(2600); if (my !== run) return;
    say("我在圈「机型比较」");
    await move("ai", pagePt(APPLE.compare.x + 40, APPLE.compare.y + 60), 700, my); if (my !== run) return;
    aiCircle(APPLE.compare, 380, 7);
    await sleep(420); say("");
    tagcard(APPLE.compare.x - 150, APPLE.compare.y + APPLE.compare.h + 18, "逐项对参数点这里");
  }
  const m = await ansP; if (my !== run) return;
  setRunning(false);
  await move("ai", pagePt(1080, 40), 600, my); show("ai", false);
  m.querySelectorAll(".circle-ref").forEach((b) => (b.onclick = () => pointBack(+b.dataset.ref)));
  narr("点回答里的 <b>①②</b>：助手回到页面上那一处，画一圈给你看。也可以点 <b>重来</b> 自己圈。");
}
let backFade;
async function pointBack(n) {
  const s = strokes[n - 1]; if (!s) return;
  const my = run;
  $("#ink").querySelectorAll("path.back").forEach((p) => p.remove());
  const c = aiCircle(s.box, 380, 40 + n); c.path.classList.add("back");
  clearTimeout(backFade);
  backFade = setTimeout(() => { c.path.style.transition = "opacity .2s"; c.path.style.opacity = "0"; setTimeout(() => c.path.remove(), 220); }, 1800);
  if (my !== run) return;
}

async function playCircle(my) {
  narr("<b>1</b> 点侧栏输入框旁的 <b>+</b>，选「圈出来问」");
  place("you", panelPt("#input", 0.6, 0.4)); show("you");
  await sleep(500);
  await move("you", panelPt("#attach-btn"), 700, my); if (my !== run) return;
  ripple(pos.you, "#141413"); doc.getElementById("attach-menu").hidden = false;
  await sleep(500);
  await move("you", panelPt("#menu-action-region", 0.35), 500, my); if (my !== run) return;
  ripple(pos.you, "#141413"); await sleep(220);
  doc.getElementById("attach-menu").hidden = true; enterCircle(true);
  narr("<b>2</b> 在网页上圈出想问的地方，可以圈好几处");
  for (const [i, key] of ["pro", "air"].entries()) {
    const pts = handLoop(APPLE[key], 11 + i * 7);
    await move("you", pagePt(...pts[0]), 650, my); if (my !== run) return;
    $("#you").classList.add("drawing");
    const path = userStrokePath(); const drawn = [];
    for (const p of pts) { if (my !== run) return; drawn.push(p); path.setAttribute("d", smoothD(drawn)); place("you", pagePt(...p)); await sleep(15); }
    $("#you").classList.remove("drawing");
    addCircle(pts, path);
    await sleep(350);
  }
  narr("<b>3</b> 在侧栏说想问什么。圈完不会自动发送");
  await move("you", panelPt("#input", 0.5, 0.5), 700, my); if (my !== run) return;
  ripple(pos.you, "#141413");
  await typeInput("把这两个比一比，我该买哪个？", my); if (my !== run) return;
  await move("you", panelPt("#send-btn"), 450, my); if (my !== run) return;
  ripple(pos.you, "#141413"); show("you", false);
  narr("<b>4</b> 助手先看你圈的两处，再回答；回答里的 ①② 对应页面上的圈");
  await circleAnswer("把这两个比一比，我该买哪个？", my);
}

/* ── 场景二：记忆露出来 ── */
const fields = {};
function fieldBox(key, opts = {}) {
  const b = TRIP[key];
  const f = document.createElement("div");
  f.className = "field"; Object.assign(f.style, { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px", paddingLeft: (opts.pad ?? 2) + "px" });
  if (opts.size) f.style.fontSize = opts.size;
  f.innerHTML = `<span class="v"></span><span class="memtag">记得的</span>`;
  $("#layer").append(f); fields[key] = f; return f;
}
async function typeField(f, text, my, per = 70) {
  const v = f.querySelector(".v"); const caret = document.createElement("span"); caret.className = "caret"; f.insertBefore(caret, v.nextSibling);
  for (const ch of text) { if (my !== run) return; v.textContent += ch; await sleep(per); }
  caret.remove();
}
function memPopover() {
  document.querySelector(".pop")?.remove();
  const b = TRIP.where;
  const p = document.createElement("div");
  p.className = "pop"; p.style.left = (b.x - 120) + "px"; p.style.top = (b.y + b.h + 10) + "px";
  p.innerHTML = `<div class="src">你 9 月 28 日说过：<b>出差住酒店，要离地铁站近</b>。这一格是按这条填的。</div><div class="acts"><button type="button" data-a="edit">改一下</button><button type="button" data-a="once">这次不用</button><button type="button" data-a="forget" class="warn">忘掉</button></div>`;
  $("#layer").append(p); requestAnimationFrame(() => p.classList.add("on"));
  const f = fields.where, v = f.querySelector(".v");
  p.onclick = (e) => {
    const a = e.target.dataset?.a; if (!a) return;
    p.remove();
    if (a === "edit") { f.classList.remove("mem"); v.contentEditable = "true"; v.focus(); getSelection().selectAllChildren(v); narr("直接改格子里的字。你改过的，以你的为准。"); }
    if (a === "once") { f.classList.remove("mem"); v.textContent = ""; narr("这次不用：格子清空了，记忆还在，下次照常用。"); }
    if (a === "forget") { f.classList.remove("mem"); v.textContent = ""; forgetInPanel(); narr("忘掉了：格子清空，侧栏那一行也写明已忘记，可以撤销。"); }
  };
  setTimeout(() => addEventListener("pointerdown", function close(ev) { if (!p.contains(ev.target)) { p.remove(); removeEventListener("pointerdown", close); } }), 0);
}
function forgetInPanel() {
  const line = doc.querySelector('.memory-used-line[data-memory-used-line="1"]');
  const toggle = doc.querySelector(".memory-used-toggle.named");
  if (toggle) toggle.innerHTML = `已忘记「出差住地铁站附近」 <span class="memory-used-chevron">›</span>`;
  if (line) line.dataset.open = "false";
}
function namedMemoryLine(m) {
  const p = m.querySelector("p");
  const t = doc.createElement("button");
  t.type = "button"; t.className = "memory-used-toggle named"; t.setAttribute("aria-expanded", "false");
  t.innerHTML = `按你说过的：出差住地铁站附近 <span class="memory-used-chevron">›</span>`;
  p.append(t);
  const line = doc.createElement("div");
  line.className = "memory-used-line"; line.dataset.memoryUsedLine = "1"; line.dataset.open = "false";
  line.innerHTML = `<ul class="memory-used-list"><li class="memory-used-item" data-state="used"><span class="memory-used-glyph" aria-hidden="true"></span><span class="memory-used-text">出差住酒店，要离地铁站近 · 9 月 28 日</span><span class="memory-used-actions"><button type="button" data-memory-used-action="forget">忘掉</button><button type="button" data-memory-used-action="not-here">这里别用</button></span></li></ul>`;
  p.after(line);
  t.onclick = () => { const open = line.dataset.open !== "true"; line.dataset.open = String(open); t.setAttribute("aria-expanded", String(open)); };
}
function receipt(m) {
  const r = doc.createElement("div");
  r.className = "memory-receipt memory-receipt-updated";
  r.innerHTML = `<span class="memory-receipt-mark"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#f0abfc,#818cf8 72%)"></span></span><span class="memory-receipt-text">已更新：住在杭州（原来是北京）</span><button type="button" data-u>撤销</button><button type="button">查看</button>`;
  m.after(r);
  r.querySelector("[data-u]").onclick = (e) => { r.querySelector(".memory-receipt-text").textContent = "已撤销，仍记作住在北京"; e.target.remove(); };
  scrollEnd();
}
async function playMemory(my) {
  narr("<b>1</b> 让助手订酒店，没提位置要求");
  const q = "帮我订下周一到周三去上海出差的酒店，先别点搜索";
  place("you", panelPt("#input", 0.6, 0.4)); show("you");
  await move("you", panelPt("#input", 0.4, 0.5), 500, my); if (my !== run) return;
  ripple(pos.you, "#141413");
  await typeInput(q, my, 45); if (my !== run) return;
  await move("you", panelPt("#send-btn"), 450, my); if (my !== run) return;
  ripple(pos.you, "#141413"); show("you", false);
  userMessage(q, ["hotels.ctrip.com"]); setRunning(true);
  narr("<b>2</b> 助手在网页上填表。位置那一格是按你说过的习惯填的，所以带淡蓝底和「记得的」");
  place("ai", pagePt(1080, 30)); show("ai");
  const steps = [
    ["dest", "我在填「目的地」", "上海", { pad: 4 }],
    ["dates", "我在填「入住日期」", "10月12日(周一) - 10月14日(周三)", { size: "15px" }],
    ["where", "我在填「位置」· 按你说过的", "地铁站附近", { pad: 6, size: "15px" }],
  ];
  for (const [key, label, text, opts] of steps) {
    const b = TRIP[key];
    say(label);
    await move("ai", pagePt(b.x + 14, b.y + b.h * 0.7), 750, my); if (my !== run) return;
    ripple(pos.ai, "#2d4a86");
    const f = fieldBox(key, opts);
    if (key === "dates") { const n = fieldBox("nights", { size: "12px" }); n.style.background = "#eef3fb"; n.style.justifyContent = "center"; n.style.borderRadius = "13px"; n.querySelector(".v").textContent = "2晚"; n.style.color = "#0f294d"; }
    await typeField(f, text, my); if (my !== run) return;
    if (key === "where") { await sleep(150); f.classList.add("mem"); f.onclick = memPopover; }
    await sleep(350);
  }
  say(""); await move("ai", pagePt(1080, 30), 600, my); show("ai", false);
  const m = await answer([
    `<p>填好了：上海，10 月 12 日到 14 日，住 2 晚。位置填了「地铁站附近」。还没点搜索。</p>`,
  ], my); if (my !== run) return;
  namedMemoryLine(m); setRunning(false); scrollEnd();
  narr("<b>3</b> 回答里不再写「用了 1 条记忆」，直接写出用了哪条。点它能展开，能忘掉");
  await sleep(2600); if (my !== run) return;
  narr("<b>4</b> 随口说一句搬家了，它改掉旧的，并告诉你改成了什么，可以撤销");
  const q2 = "对了，我上周搬到杭州了";
  show("you"); await move("you", panelPt("#input", 0.4, 0.5), 600, my); if (my !== run) return;
  ripple(pos.you, "#141413");
  await typeInput(q2, my, 70); if (my !== run) return;
  await move("you", panelPt("#send-btn"), 400, my); if (my !== run) return;
  ripple(pos.you, "#141413"); show("you", false);
  userMessage(q2);
  const m2 = await answer([`<p>好的。以后订酒店、查天气，默认按杭州来。</p>`], my); if (my !== run) return;
  receipt(m2);
  narr("可以试：点网页上带 <b>记得的</b> 的格子；点侧栏 <b>按你说过的…</b>；点 <b>撤销</b>。");
}

/* ── 场景切换 / 播放 / 重来 ── */
async function reset() {
  run++;
  const s = SCENES[scene];
  $("#url").textContent = s.url;
  $("#shot").src = s.img;
  clearPage(); enterCircle(false); show("you", false); show("ai", false); say("");
  document.querySelector(".pop")?.remove();
  await loadPanel();
  app().classList.add("starter-ready", "conversation-empty");
  doc.querySelector(".conversation-title").textContent = "新会话";
  doc.getElementById("messages").replaceChildren();
  const strip = doc.getElementById("attachments-strip"); strip.replaceChildren(); strip.hidden = true;
  const orb = doc.getElementById("starter-orb"); if (orb) orb.style.visibility = "hidden";
  if (scene === "circle") { circleMenuPatch(); wireCircleMenu(); }
  else {
    const input = doc.getElementById("input");
    doc.getElementById("send-btn").onclick = () => {};
    input.onkeydown = (e) => { if (e.key === "Enter") e.preventDefault(); };
  }
  fit();
  narr(scene === "circle"
    ? "点 <b>▶ 播放演示</b> 看一遍；或者点侧栏输入框旁的 <b>+</b> →「圈出来问」，自己在网页上圈。"
    : "点 <b>▶ 播放演示</b>：助手订酒店时用上你说过的习惯，以及你搬家后它怎么改记忆。");
}
function setScene(name) {
  scene = name;
  $("#sc-circle").setAttribute("aria-pressed", String(name === "circle"));
  $("#sc-memory").setAttribute("aria-pressed", String(name === "memory"));
  reset();
}
$("#sc-circle").onclick = () => setScene("circle");
$("#sc-memory").onclick = () => setScene("memory");
$("#reset").onclick = () => reset();
$("#play").onclick = async () => { await reset(); const my = run; scene === "circle" ? playCircle(my) : playMemory(my); };
$("#shot").addEventListener("load", fit);
setScene(location.hash === "#memory" ? "memory" : "circle");
