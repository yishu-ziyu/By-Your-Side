// 走老路预览：同一个侧栏、同一个网页，三个场景按真实节奏播放。秒数是按目标设的，不是实测。
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVG = {
  think: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>',
  route: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg>',
  many: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
};

// 侧栏里新增的两样，语气照现有元素：做法对不上的一行（同 trail-step），回答下面的「照上次的做法」（同「用了哪条记忆」那一行）。
const PANEL_EXTRA = `
  .run-trail .trail-step.route-miss::before { content: "↩"; }
  .run-trail .trail-step.route-miss .trail-text { color: var(--text-secondary); white-space: normal; }
  .route-line .memory-used-glyph { font: 600 9.5px/16px var(--font); }
  .route-line .memory-used-item.var .memory-used-text b { font-weight: 600; color: var(--text-primary); }
  .route-line .memory-used-item.changed .memory-used-text b { font-weight: 600; color: var(--apple-orange, #c96a1b); }
  .route-line .route-foot { display: flex; align-items: center; gap: 12px; min-height: 24px; padding-left: 25px; color: var(--text-quaternary); font-size: 11.5px; }
  .route-line .route-foot button { all: unset; color: var(--text-tertiary); font-size: 11.5px; cursor: pointer; }
  .route-line .route-foot button:hover { color: var(--text-primary); }
  .route-line .route-off { color: var(--text-tertiary); font-size: 12px; }
`;

const DATE_FIRST = "10 月 9 日（周四）", DATE_NEXT = "10 月 16 日（周四）";

const SCENES = {
  first: {
    ask: "帮我订 10 月 9 日周四下午 3 点到 4 点 3 楼的青松会议室，主题写周会",
    date: DATE_FIRST, page: "v1", mode: "think",
    intro: "<b>第一次</b>：每一步都等模型想一想（约 4 秒一步），和现在一样。",
    outro: "第一次约 28 秒。做完后记下这次的做法，回答下面告诉你「记下了」，你可以说不用记。",
  },
  replay: {
    ask: "下周四同一时间再订一次青松，主题还是周会",
    date: DATE_NEXT, page: "v1", mode: "replay",
    intro: "<b>第二次</b>：认出是同一件事，照上次的 6 步直接走，只有「日期」换成这次的。",
    outro: "约 9 秒。点「预订」前先核对一遍；回答下面写明照的哪次，点开能看每一步，也能说下次别照旧。",
  },
  changed: {
    ask: "下周四同一时间再订一次青松，主题还是周会",
    date: DATE_NEXT, page: "v2", mode: "replay", missAt: 3,
    intro: "<b>页面改了</b>：网站把会议室列表改成了表格，照旧走到第 4 步对不上。",
    outro: "对不上就停，不猜；从这一步接着一步步做，做完按新页面更新这份做法。约 20 秒。",
  },
};

let scene = "first", token = 0, D, M, tick;
const alive = (t) => t === token;
const panel = $("#panel");
panel.srcdoc = PANEL_HTML;
panel.addEventListener("load", () => {
  D = panel.contentDocument;
  M = D.getElementById("messages");
  const st = D.createElement("style"); st.textContent = PANEL_EXTRA; D.head.appendChild(st);
  const starter = D.getElementById("starter"); if (starter) starter.hidden = true;
  reset();
});

// ---------- 网页 ----------
const site = $("#site"), vp = $("#vp"), toast = $("#toast");
function renderSite(v) {
  const rooms = [["qingsong", "青松", "3F-A", "8 人 · 投影"], ["baihua", "白桦", "3F-B", "12 人 · 白板"], ["yinxing", "银杏", "5F", "30 人 · 视频会议"]];
  const list = v === "v1"
    ? `<div class="rooms">${rooms.map(([id, n, f, d]) => `<div class="room" id="r-${id}"><b>${n}</b><small>${f} · ${d}</small><span class="btn">选择</span></div>`).join("")}</div>`
    : `<table class="rooms2"><thead><tr><th>会议室</th><th>楼层</th><th>容量与设备</th><th></th></tr></thead><tbody>${rooms.map(([id, n, f, d]) => `<tr id="r-${id}"><td><b>${n}</b></td><td>${f}</td><td>${d}</td><td><span class="btn">预约此间</span></td></tr>`).join("")}</tbody></table>`;
  site.innerHTML = `<header><span class="logo"></span><b>行政服务</b><span class="who">林小舟</span></header>
  <main><h1>会议室预订${v === "v2" ? '<span class="newbadge">新版</span>' : ""}</h1>
    <div class="card"><div class="row">
      <div class="fld">日期<span class="box" id="f-date">选择日期</span></div>
      <div class="fld">时间<span class="box" id="f-time">选择时间</span></div>
      <div class="fld">楼层<span class="box" id="f-floor">全部楼层</span></div>
    </div></div>
    <div class="card">${list}</div>
    <div class="card"><div class="row"><div class="fld">会议主题<span class="box wide" id="f-topic">例如：项目周会</span></div><span class="btn primary" id="f-submit">预订</span></div></div>
  </main>`;
}
const setBox = (sel, text) => { const b = $(sel); b.textContent = text; b.classList.add("set"); };
async function typeInto(sel, text, t) {
  const b = $(sel); b.classList.add("focus", "set"); b.textContent = "";
  for (const ch of text) { if (!alive(t)) return; b.textContent += ch; await sleep(90); }
  b.classList.remove("focus");
}

// ---------- 光标 ----------
const ai = $("#ai"), win = $("#win");
let curXY = null;
function placeOf(sel) {
  const r = $(sel).getBoundingClientRect(), w = win.getBoundingClientRect();
  return { x: r.left - w.left + Math.min(r.width * 0.5, 60), y: r.top - w.top + r.height * 0.55 };
}
async function moveTo(sel, label, ms, t) {
  const p = placeOf(sel), first = !curXY;
  ai.classList.add("on");
  $(".lbl .t", ai).textContent = label; $(".lbl", ai).classList.add("on");
  ai.style.transition = !first ? `transform ${ms}ms cubic-bezier(.3,.1,.2,1), opacity .2s` : "opacity .2s";
  ai.style.transform = `translate(${p.x}px, ${p.y}px)`; curXY = p;
  await sleep(first ? 60 : ms);
  if (!alive(t)) return;
  const rp = document.createElement("div"); rp.className = "ripple"; rp.style.left = `${p.x}px`; rp.style.top = `${p.y}px`;
  $("#cursors").appendChild(rp); setTimeout(() => rp.remove(), 520);
}
const hideCursor = () => { $(".lbl", ai).classList.remove("on"); };

// ---------- 侧栏 ----------
const el = (tag, cls, html) => { const e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
let run, trail, steps = [], more = 0, started = 0;
function scrollEnd() { M.parentElement.scrollTop = 1e6; M.scrollTop = 1e6; }
// 输入框跟着任务状态：进行中是「补充或改方向」+ 中止，结束后回到「说说你想完成什么」+ 发送。
function composer(running) {
  const input = D.getElementById("input"); if (input) input.placeholder = running ? "补充或改方向..." : "说说你想完成什么...";
  D.getElementById("send-btn")?.classList.toggle("stopping", running);
  for (const b of D.querySelectorAll("button")) if (b.textContent.trim() === "接管") b.hidden = !running;
}
function userMsg(text) {
  const m = el("div", "msg user", `<div class="user-msg-text">${esc(text)}</div>`);
  const chips = el("div", "ctx-chips", `<span class="ctx-chip"><span class="cl">会议室预订</span></span>`);
  M.append(m, chips);
  for (const t of D.querySelectorAll(".conversation-title, .conversation-menu-title")) t.textContent = text;
}
function startRun(icon) {
  run = el("details", "run-steps", `<summary><span class="run-icon"></span><span class="run-act-icon" data-kind="think">${SVG[icon]}</span><span class="run-title"><span class="act-verb"></span> <span class="act-object"></span></span><span class="run-time">0 秒</span><span class="run-chevron">${SVG.chev}</span></summary><div class="run-reveal"><div class="run-body"></div></div>`);
  run.querySelector("summary").addEventListener("click", (e) => e.preventDefault());
  trail = el("div", "run-trail"); steps = []; more = 0;
  M.append(run, trail);
  started = performance.now();
  clearInterval(tick);
  tick = setInterval(() => { $(".run-time", run).textContent = `${Math.floor((performance.now() - started) / 1000)} 秒`; }, 200);
  composer(true);
  scrollEnd();
}
function title(verb, obj, icon) {
  $(".act-verb", run).textContent = verb; $(".act-object", run).textContent = obj ? `· ${obj}` : "";
  if (icon) $(".run-act-icon", run).innerHTML = SVG[icon];
}
function addStep(text, dur, cls = "") {
  steps.push({ text, dur, cls });
  if (steps.length > 3) { steps.shift(); more += 1; }
  trail.innerHTML = (more ? `<div class="trail-more">+ 前面 ${more} 步</div>` : "") + steps.map((s) => `<div class="trail-step ${s.cls}"><span class="trail-text">${esc(s.text)}</span><span class="trail-dur">${s.dur}</span></div>`).join("");
  scrollEnd();
}
function finishRun(count, answer) {
  clearInterval(tick);
  const secs = Math.round((performance.now() - started) / 1000);
  run.classList.add("done"); title("做了", `${count} 件事`, "many");
  $(".act-object", run).textContent = `${count} 件事`;
  trail.remove();
  const a = el("div", "msg assistant markdown answer-latest", `<p>${answer}</p><div class="answer-actions"><button type="button" aria-label="复制回答">${SVG.copy}</button><span class="answer-time">${secs} 秒</span><span class="answer-action-feedback" role="status"></span></div>`);
  M.append(a);
  composer(false);
  return secs;
}

// 回答下面那一行：照的哪次做法 / 记下了做法；点开看每一步。
function routeLine(head, items, foot) {
  const box = el("div", "memory-used-line route-line");
  const toggle = el("button", "memory-used-toggle", `${head} <span class="memory-used-chevron">›</span>`);
  toggle.type = "button"; toggle.setAttribute("aria-expanded", "false");
  const list = el("ul", "memory-used-list"); list.hidden = true;
  items.forEach((it, i) => list.append(el("li", `memory-used-item ${it.cls || ""}`, `<span class="memory-used-glyph">${i + 1}</span><span class="memory-used-text">${it.html}</span>`)));
  const footRow = el("li", "route-foot"); list.append(footRow);
  const renderFoot = (state) => {
    footRow.innerHTML = "";
    if (state === "off") {
      footRow.append(el("span", "route-off", foot.offText), Object.assign(el("button", "", "撤销"), { type: "button", onclick: () => renderFoot("on") }));
    } else {
      footRow.append(el("span", "", foot.note), Object.assign(el("button", "", foot.offLabel), { type: "button", onclick: () => renderFoot("off") }));
    }
  };
  renderFoot("on");
  toggle.onclick = () => { const open = toggle.getAttribute("aria-expanded") !== "true"; toggle.setAttribute("aria-expanded", String(open)); list.hidden = !open; scrollEnd(); };
  box.append(toggle, list);
  M.append(box);
  scrollEnd();
  return toggle;
}

// ---------- 步骤 ----------
function stepsFor(sc) {
  return [
    { now: "选日期", past: `选了 ${sc.date.replace("（周四）", "")}`, sel: "#f-date", act: () => setBox("#f-date", sc.date) },
    { now: "选时间", past: "选了 15:00–16:00", sel: "#f-time", act: () => setBox("#f-time", "15:00 – 16:00") },
    { now: "选楼层", past: "选了 3 楼", sel: "#f-floor", act: () => setBox("#f-floor", "3 楼") },
    { now: "选会议室", past: "选了青松（3F-A）", sel: "#r-qingsong .btn", act: () => $("#r-qingsong").classList.add("picked") },
    { now: "填主题", past: "填了主题「周会」", sel: "#f-topic", type: "周会" },
    { now: "点预订", past: "点了预订", sel: "#f-submit", act: () => { const b = $("#f-submit"); b.textContent = "已预订"; b.classList.add("done"); toast.textContent = `预订成功：${sc.date} 15:00 青松（3F-A）`; toast.classList.add("on"); }, write: true },
  ];
}
async function doStep(s, ms, t) {
  await moveTo(s.sel, s.now, ms, t);
  if (!alive(t)) return;
  if (s.type) await typeInto(s.sel, s.type, t); else s.act();
}

async function play() {
  const t = ++token, sc = SCENES[scene];
  setPlaying(true);
  await resetInner(t);
  narr(sc.intro);
  await sleep(500);
  userMsg(sc.ask);
  await sleep(600);
  const list = stepsFor(sc);
  let count = 0;

  if (sc.mode === "think") {
    startRun("think");
    const thinks = [3600, 4100, 3300, 3900, 3500, 3700];
    for (let i = 0; i < list.length; i++) {
      title("正在思考", count ? `已做 ${count} 件事` : "", "think"); hideCursor();
      await sleep(thinks[i]); if (!alive(t)) return;
      title(`正在${list[i].now}`, "", "think");
      const t0 = performance.now();
      await doStep(list[i], 520, t); if (!alive(t)) return;
      await sleep(250);
      addStep(list[i].past, `${((performance.now() - t0) / 1000).toFixed(1)}s`); count++;
    }
    title("正在思考", `已做 ${count} 件事`, "think"); hideCursor();
    await sleep(2600); if (!alive(t)) return;
    finishRun(count, `订好了：${sc.date} 15:00–16:00，3 楼青松（3F-A），主题「周会」。`);
    routeLine("记下了这次的做法，下次订会议室照着走", list.map((s) => ({ html: esc(s.past) })), { note: "只在这个网站、同一类事上用；页面对不上就照常一步步做。", offLabel: "不用记", offText: "没有记下这次的做法。" });
    narr(sc.outro);
  } else {
    startRun("think");
    title("正在思考", "", "think");
    await sleep(2300); if (!alive(t)) return;
    title("照上次的做法", `第 1/${list.length} 步`, "route");
    await sleep(500);
    for (let i = 0; i < list.length; i++) {
      if (!alive(t)) return;
      if (sc.missAt === i) {
        // 找不到上次点的那个「选择」：停下，交回正常做法，从这一步接着做。
        title("页面变了", "改为一步步看", "think");
        await sleep(700); if (!alive(t)) return;
        addStep(`第 ${i + 1} 步对不上：找不到上次点的「选择」，改为一步步看`, "", "route-miss");
        for (let j = i; j < list.length; j++) {
          title("正在思考", `已做 ${count} 件事`, "think"); hideCursor();
          await sleep([3700, 3400, 3600][j - i] ?? 3500); if (!alive(t)) return;
          title(`正在${list[j].now}`, "", "think");
          const t0 = performance.now();
          await doStep(list[j], 520, t); if (!alive(t)) return;
          await sleep(250);
          addStep(list[j].past, `${((performance.now() - t0) / 1000).toFixed(1)}s`); count++;
        }
        title("正在思考", `已做 ${count} 件事`, "think"); hideCursor();
        await sleep(2400); if (!alive(t)) return;
        finishRun(count, `订好了：${sc.date} 15:00–16:00，3 楼青松（3F-A），主题「周会」。`);
        routeLine("页面和上次不一样，已按这次的做法更新", list.map((s, k) => ({ html: k === 3 ? '选会议室：青松，改为点<b>「预约此间」</b>' : esc(s.past), cls: k === 3 ? "changed" : "" })), { note: "前 3 步照旧，第 4 步起是这次重新想的。", offLabel: "下次别照旧", offText: "以后订会议室会一步步来。" });
        narr(sc.outro);
        return setPlaying(false);
      }
      if (list[i].write) {
        // 提交前核对一遍：看一眼当前页面，确认日期、会议室、主题都是这次要的。
        title("提交前核对", "日期、会议室、主题", "route"); hideCursor();
        await sleep(2200); if (!alive(t)) return;
        addStep("核对过了：和你这次说的一致", "2.2s");
        title("照上次的做法", `第 ${i + 1}/${list.length} 步`, "route");
      }
      const t0 = performance.now();
      await doStep(list[i], 300, t); if (!alive(t)) return;
      await sleep(120);
      addStep(list[i].past, `${((performance.now() - t0) / 1000).toFixed(1)}s`); count++;
      if (i + 1 < list.length) title("照上次的做法", `第 ${i + 2}/${list.length} 步`, "route");
    }
    hideCursor();
    await sleep(900); if (!alive(t)) return;
    finishRun(count, `订好了：${sc.date} 15:00–16:00，3 楼青松（3F-A），主题「周会」。`);
    routeLine("照 10 月 2 日那次的做法 · 上次 28 秒", list.map((s, k) => ({ html: k === 0 ? `选日期：<b>${sc.date.replace("（周四）", "")}</b>（这次说的）` : esc(s.past), cls: k === 0 ? "var" : "" })), { note: "只有日期换成了这次的。", offLabel: "下次别照旧", offText: "以后订会议室会一步步来。" });
    narr(sc.outro);
  }
  setPlaying(false);
}

// ---------- 控制 ----------
const narr = (html) => { $("#narr").innerHTML = html; };
function setPlaying(on) { $("#play").disabled = on; }
async function resetInner() {
  clearInterval(tick);
  if (M) { M.innerHTML = ""; composer(false); }
  renderSite(SCENES[scene].page);
  toast.classList.remove("on");
  ai.classList.remove("on"); hideCursor(); curXY = null;
}
async function reset() { token++; await resetInner(); setPlaying(false); narr(`${SCENES[scene].intro} 点「播放」。`); }
for (const b of document.querySelectorAll(".seg button")) {
  b.onclick = () => { scene = b.dataset.sc; for (const x of document.querySelectorAll(".seg button")) x.setAttribute("aria-pressed", String(x === b)); reset(); };
}
$("#play").onclick = play;
$("#reset").onclick = reset;
