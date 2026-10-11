/* 过程块原型：三种改法 + 现状复刻。全部从「模拟时间 t」推出界面，可以播放、拖动、跳到某个状态。
   结构与类名沿用产品：details.run-steps > summary > .run-title(.act-verb/.act-object) · .run-time · .run-chevron，
   .run-reveal > .run-body；进行中扫光 runShine、新字 reveal-fade（300ms 透明+2px 模糊）、展开弹簧 --e-spring-run 都来自 product-styles.css。 */
(() => {
const HOLD = 1.1;            // 每句至少停 1.1 秒（RUN_TITLE_HOLD_MS）
const SHOW_SECS = 3;         // 一步超过 3 秒才写秒数
const THINK_MIN = 3;         // 想了不到 3 秒不单列

const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const CHEV = '<svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const chevron = () => { const c = h("span", "run-chevron"); c.innerHTML = CHEV; return c; };

function spoken(sec) { const s = Math.max(1, Math.round(sec)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; }
function fade(el) { el.classList.remove("reveal-fade"); void el.offsetWidth; el.classList.add("reveal-fade"); }
/* 换字：内容变了才换，并播一次 300ms 淡入（与 stream-reveal 同一套）。 */
function paint(el, pair, key, animate = true) {
  if (el.dataset.k === key) return false;
  el.dataset.k = key;
  const v = h("span", "act-verb", pair[0]);
  if (pair[1]) el.replaceChildren(v, joinGap(pair), h("span", "act-object", pair[1])); else el.replaceChildren(v);
  if (animate) fade(el);
  return true;
}
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

/* 每句至少停 HOLD 秒；停的时候来了新句，只留最新一句排队（与 setRunTitle 一致）。 */
function titleSchedule(run) {
  const ev = run.steps;
  const out = [];
  let lastAt = -Infinity;
  for (let i = 0; i < ev.length; i++) {
    const at = Math.max(ev[i].s, lastAt + HOLD);
    const next = ev[i + 1];
    if (next && next.s < at) continue;
    out.push({ at, step: ev[i] });
    lastAt = at;
  }
  return out;
}

function snapshot(run, t, sched) {
  const ended = t >= run.end;
  const tt = Math.min(t, run.end);
  const cur = run.steps.find((s) => s.s <= tt && tt < s.e) || null;
  let titleStep = sched[0].step;
  for (const x of sched) if (x.at <= tt) titleStep = x.step;
  const finished = run.steps.filter((s) => s.e <= tt);
  const acts = finished.filter((s) => s.kind === "act");
  const log = finished.filter((s) => s.kind === "act" || (s.kind === "think" && s.e - s.s >= THINK_MIN));
  let thinkSec = 0;
  for (const s of run.steps) if (s.kind === "think" && s.s < tt) thinkSec += Math.min(tt, s.e) - s.s;
  const w = run.steps.find((s) => s.kind === "write");
  const lead = 2.0; // 先想一下怎么说，再开始出字
  const answerFrac = w ? Math.max(0, Math.min(1, (tt - w.s - lead) / (w.e - w.s - lead))) : 0;
  return {
    t: tt, run, ended, cur, titleStep, finished, acts, log,
    count: acts.filter((s) => !s.failed).length,
    failed: acts.filter((s) => s.failed).length,
    thinkSec, answerFrac,
    curSec: cur ? tt - cur.s : 0,
    titleSec: tt - (titleStep === cur ? cur.s : titleStep.s),
  };
}

/* 进行中那一行说的话：思考 → 「正在思考」，其余用 live。 */
function livePair(step) { return step.kind === "think" ? ["正在思考", ""] : step.live; }
function pastPair(step) { return step.kind === "think" ? ["想了", spoken(step.e - step.s)] : step.past; }
/* 记录里一句话：对象以「或前半句以，结尾时不加空格。 */
function joinGap(p) { return !p[1] || /^[「（]/.test(p[1]) || /[，、：]$/.test(p[0]) ? "" : " "; }
function doneTitle(s) {
  const base = `做了 ${s.count} 件事`;
  return s.failed ? [base, `· ${s.failed} 件换了办法`] : [base, ""];
}
function sumLine(s) { return `共 ${spoken(s.run.end)}，其中想了 ${spoken(s.thinkSec)}`; }

/* ── 现状：按产品 main.ts renderTrail / betweenStepsTitle 复刻，耗时照截图写 0.0s ── */
function mountCurrent() {
  const d = h("details", "run-steps cur");
  const sum = h("summary");
  const title = h("span", "run-title"); const time = h("span", "run-time");
  sum.append(title, time, chevron());
  const reveal = h("div", "run-reveal"); const body = h("div", "run-body"); reveal.append(body);
  d.append(sum, reveal);
  const trail = h("div", "run-trail"); trail.hidden = true;
  const wrap = h("div", "proto-block"); wrap.append(d, trail);
  return {
    el: wrap, details: d,
    update(s) {
      d.classList.toggle("done", s.ended);
      const st = s.titleStep;
      const n = s.acts.length;
      let text;
      if (s.ended) text = [`做了 ${n} 件事`, ""];
      else if (st.kind === "think" || st.kind === "write" || st.kind === "note") text = [n ? `正在思考 · 已做 ${n} 件事` : "正在思考", ""];
      else { const r = `正在${st.raw}`; const q = r.search(/[「 ]/); text = q > 0 ? [r.slice(0, q), r.slice(q).trim()] : [r, ""]; }
      paint(title, text, text.join("|"), false);
      setText(time, spoken(s.t));
      // 进行中：最近 3 步 + 「+ 前面 N 步」
      trail.hidden = s.ended || n === 0;
      const shown = s.acts.slice(-3); const earlier = n - shown.length;
      const key = shown.map((x) => x.id).join() + earlier;
      if (trail.dataset.k !== key) {
        trail.dataset.k = key;
        const rows = shown.map((x) => { const r = h("div", x.failed ? "trail-step failed" : "trail-step"); r.append(h("span", "trail-text", x.rawPast + (x.failed ? " · 没成功" : "")), h("span", "trail-dur", "0.0s")); return r; });
        if (earlier > 0) rows.unshift(h("div", "trail-more", `+ 前面 ${earlier} 步`));
        trail.replaceChildren(...rows);
      }
      // 展开：产品收尾后的 chip 列表
      const bk = s.acts.map((x) => x.id).join();
      if (body.dataset.k !== bk) {
        body.dataset.k = bk;
        const g = h("div", "chip-group"); const row = h("div", "chip-row"); g.append(row);
        for (const x of s.acts) { const c = h("button", x.failed ? "chip error" : "chip"); c.append(h("span", `chip-dot ${x.failed ? "error" : "done"}`), h("span", "chip-label", x.rawPast)); row.append(c); }
        body.replaceChildren(g);
      }
    },
  };
}

/* ── A：一行「现在」+ 收起的人话记录 ── */
function mountA(opts = {}) {
  const d = h("details", "run-steps pa");
  const sum = h("summary");
  const now = h("div", "pa-now");
  const title = h("span", "run-title"); const sec = h("span", "pa-sec"); const chev = chevron();
  now.append(title, sec, chev);
  const meta = h("div", "pa-meta"); const metaIn = h("div", "pa-meta-in");
  const count = h("span", "pa-count"); const total = h("span", "pa-total"); const mchev = h("span", "pa-mchev"); mchev.innerHTML = CHEV;
  metaIn.append(count, total, mchev); meta.append(metaIn);
  sum.append(now, meta);
  const reveal = h("div", "run-reveal"); const body = h("div", "run-body pa-log"); reveal.append(body);
  d.append(sum, reveal);
  const rows = new Map(); const sumEl = h("div", "pa-sum");
  return {
    el: d, details: d,
    update(s) {
      d.classList.toggle("done", s.ended);
      const st = s.titleStep;
      if (s.ended) { if (opts.receipt) receipt(title, s); else paint(title, doneTitle(s), "done"); setText(sec, ""); }
      else {
        paint(title, livePair(st), st.id);
        d.classList.toggle("warn", st.kind === "note");
        const showSec = st === s.cur && (st.kind === "think" ? s.curSec >= 1 : s.curSec >= SHOW_SECS) && st.kind !== "note";
        setText(sec, showSec ? spoken(s.curSec) : "");
      }
      if (s.ended) d.classList.remove("warn");
      meta.classList.toggle("show", !s.ended && s.count + s.failed > 0);
      setText(count, `已做 ${s.count} 件事`);
      setText(total, s.failed ? ` · ${s.failed} 件换了办法` : "");
      for (const x of s.log) {
        if (rows.has(x.id)) continue;
        const r = h("div", `pa-row ${x.kind}${x.failed ? " failed" : ""}`);
        const txt = h("span", "pa-text"); const p = pastPair(x);
        txt.append(h("span", "pa-v", p[0]), joinGap(p), h("span", "pa-o", p[1]));
        if (x.failed) txt.append(h("span", "pa-why", ` · ${x.why}`));
        const dur = x.e - x.s;
        r.append(h("i", "pa-mark"), txt, h("span", "pa-dur", x.kind === "act" && dur >= SHOW_SECS ? spoken(dur) : ""));
        rows.set(x.id, r); body.append(r); fade(r);
      }
      for (const [id, r] of rows) if (!s.log.some((x) => x.id === id)) { r.remove(); rows.delete(id); }
      if (s.ended) { setText(sumEl, sumLine(s)); if (!sumEl.isConnected) body.append(sumEl); } else sumEl.remove();
      if (!s.ended && !s.log.length) body.dataset.empty = "1"; else delete body.dataset.empty;
    },
  };
}

/* ── B：紧凑时间线，「现在」在最底下，思考是一段有长度的时间 ── */
function mountB() {
  const wrap = h("div", "proto-block pb-wrap");
  const d = h("details", "run-steps pb");
  const sum = h("summary");
  const label = h("span", "run-title"); const strip = h("div", "pb-strip"); const time = h("span", "run-time"); const chev = chevron();
  sum.append(label, strip, time, chev);
  const reveal = h("div", "run-reveal"); const body = h("div", "run-body pb-log"); reveal.append(body);
  const legend = h("div", "pb-legend");
  d.append(sum, reveal);
  const tail = h("div", "pb-tail");
  wrap.append(d, tail);
  const segs = new Map();
  const tailRows = new Map(); const logRows = new Map();
  const live = h("div", "pb-row live"); const liveText = h("span", "run-title"); const liveSec = h("span", "pb-sec");
  live.append(h("i", "pb-dot"), liveText, liveSec);
  const logLive = live.cloneNode(true);
  const mkRow = (x) => {
    const r = h("div", `pb-row ${x.kind}${x.failed ? " failed" : ""}`);
    const p = pastPair(x); const txt = h("span", "pb-text");
    txt.append(h("span", "pb-v", p[0]), joinGap(p), h("span", "pb-o", p[1]));
    if (x.failed) txt.append(h("span", "pb-why", ` · ${x.why}`));
    const dur = x.e - x.s;
    r.append(h("i", "pb-dot"), txt, h("span", "pb-sec", x.kind === "act" && dur >= SHOW_SECS ? spoken(dur) : ""));
    return r;
  };
  return {
    el: wrap, details: d,
    update(s) {
      d.classList.toggle("done", s.ended); wrap.classList.toggle("done", s.ended);
      // 头：进度（件数 + 时间条 + 总时长）
      paint(label, s.ended ? doneTitle(s) : [s.count ? `已做 ${s.count} 件事` : "开始", ""], s.ended ? "done" : `c${s.count}`, s.ended);
      setText(time, spoken(s.t));
      for (const x of s.run.steps) {
        if (x.s > s.t) { if (segs.has(x.id)) { segs.get(x.id).remove(); segs.delete(x.id); } continue; }
        let g = segs.get(x.id);
        if (!g) { g = h("i", `pb-seg ${x.kind === "think" ? "think" : "act"}${x.failed ? " failed" : ""}`); segs.set(x.id, g); strip.append(g); }
        g.style.flexGrow = String(Math.max(0.0001, Math.min(s.t, x.e) - x.s));
        g.classList.toggle("live", !s.ended && x === s.cur);
      }
      // 尾：最近两件 + 现在
      const recent = s.log.slice(-2);
      for (const [id, r] of tailRows) if (!recent.some((x) => x.id === id)) { r.remove(); tailRows.delete(id); }
      for (const x of recent) if (!tailRows.has(x.id)) { const r = mkRow(x); tailRows.set(x.id, r); tail.insertBefore(r, live.isConnected ? live : null); fade(r); }
      [...tailRows.values()].forEach((r, i, a) => { r.style.opacity = a.length === 2 && i === 0 ? ".45" : ".75"; });
      const st = s.titleStep;
      const showSec = st === s.cur && (st.kind === "think" ? s.curSec >= 1 : s.curSec >= SHOW_SECS) && st.kind !== "note";
      for (const [el, txt, sec] of [[live, liveText, liveSec], [logLive, logLive.querySelector(".run-title"), logLive.querySelector(".pb-sec")]]) {
        if (s.ended) { el.remove(); continue; }
        if (paint(txt, livePair(st), st.id)) fade(el);
        el.classList.toggle("warn", st.kind === "note");
        setText(sec, showSec ? spoken(s.curSec) : "");
      }
      if (!s.ended && tail.lastElementChild !== live) tail.append(live);
      tail.hidden = s.ended;
      // 展开：全部记录，现在那行仍在最底下
      for (const x of s.log) if (!logRows.has(x.id)) { const r = mkRow(x); logRows.set(x.id, r); body.insertBefore(r, logLive.isConnected ? logLive : legend.isConnected ? legend : null); }
      for (const [id, r] of logRows) if (!s.log.some((x) => x.id === id)) { r.remove(); logRows.delete(id); }
      if (!s.ended && body.lastElementChild !== logLive) body.append(logLive);
      setText(legend, `想 ${spoken(s.thinkSec)} · 动手 ${spoken(s.t - s.thinkSec)}`);
      if (s.ended && !legend.isConnected) body.append(legend); if (!s.ended) legend.remove();
      wrap.classList.toggle("open", d.open);
    },
  };
}

/* ── C：一串胶囊，收尾收成一行回执 ── */
function mountC() {
  const wrap = h("div", "proto-block pc-wrap");
  const d = h("details", "run-steps pc");
  const sum = h("summary");
  const title = h("span", "run-title"); const sec = h("span", "pc-sec"); const chev = chevron();
  sum.append(title, sec, chev);
  const reveal = h("div", "run-reveal"); const body = h("div", "run-body pc-grid"); reveal.append(body);
  d.append(sum, reveal);
  const strip = h("div", "pc-strip"); const track = h("div", "pc-track"); strip.append(track);
  wrap.append(d, strip);
  const chips = new Map(); const gridChips = new Map(); const sumEl = h("div", "pa-sum pc-sum");
  const mkChip = (x) => {
    const c = h("span", `pc-chip ${x.kind}${x.failed ? " failed" : ""}`);
    const dur = x.e - x.s;
    if (x.kind === "think") c.append(h("span", "pc-l", `想 ${spoken(dur)}`));
    else { c.append(h("i", "pc-mark"), h("span", "pc-l", x.short)); if (dur >= SHOW_SECS) c.append(h("span", "pc-d", spoken(dur))); }
    if (x.failed) c.title = x.why;
    return c;
  };
  return {
    el: wrap, details: d,
    update(s) {
      d.classList.toggle("done", s.ended); wrap.classList.toggle("done", s.ended);
      const st = s.titleStep;
      if (s.ended) {
        const firstLast = s.log.filter((x) => x.kind === "act" && !x.failed);
        const pair = [`做了 ${s.count} 件事：`, firstLast.length > 1 ? `${firstLast[0].short} → … → ${firstLast[firstLast.length - 1].short}` : ""];
        paint(title, pair, "done"); setText(sec, "");
        d.classList.remove("warn");
      } else {
        paint(title, livePair(st), st.id);
        d.classList.toggle("warn", st.kind === "note");
        const showSec = st === s.cur && (st.kind === "think" ? s.curSec >= 1 : s.curSec >= SHOW_SECS) && st.kind !== "note";
        setText(sec, showSec ? spoken(s.curSec) : "");
      }
      let added = false;
      for (const x of s.log) if (!chips.has(x.id)) { const c = mkChip(x); chips.set(x.id, c); track.append(c); c.classList.add("pc-in"); added = true; }
      for (const [id, c] of chips) if (!s.log.some((x) => x.id === id)) { c.remove(); chips.delete(id); }
      // 最新的永远在右端看得见：放不下时把前面的推出左边，左边渐隐。
      const pin = () => { track.scrollLeft = track.scrollWidth; track.classList.toggle("over", track.scrollWidth > track.clientWidth + 1); };
      pin(); if (added) { clearInterval(this._pin); let n = 0; this._pin = setInterval(() => { pin(); if (++n > 30) clearInterval(this._pin); }, 16); }
      strip.hidden = !s.log.length;
      for (const x of s.log) if (!gridChips.has(x.id)) { const c = mkChip(x); gridChips.set(x.id, c); body.insertBefore(c, sumEl.isConnected ? sumEl : null); }
      for (const [id, c] of gridChips) if (!s.log.some((x) => x.id === id)) { c.remove(); gridChips.delete(id); }
      if (s.ended) { setText(sumEl, sumLine(s)); if (!sumEl.isConnected) body.append(sumEl); } else sumEl.remove();
    },
  };
}

/* AC 收尾回执：「做了 6 件事：打开词条 → … → 圈出 11 部」。短名链放不下时从中间省略，头尾优先留；
   「· 1 件换了办法」从不省略；回执不写耗时（10-06）。 */
function receipt(el, s) {
  if (el.dataset.k === "done") return;
  el.dataset.k = "done";
  const names = s.acts.filter((x) => !x.failed).map((x) => x.short);
  const chain = h("span", "act-object ac-chain");
  const parts = [h("span", "act-verb", `做了 ${s.count} 件事${names.length > 1 ? "：" : ""}`), chain];
  if (s.failed) parts.push(h("span", "ac-warn", ` · ${s.failed} 件换了办法`));
  el.replaceChildren(...parts);
  el.classList.add("ac-receipt");
  fade(el);
  if (names.length < 2) { chain.textContent = names.length ? `：${names[0]}` : ""; return; }
  const fits = () => chain.scrollWidth <= chain.clientWidth + 1;
  const show = (k) => {
    if (k >= names.length) { chain.textContent = names.join(" → "); return; }
    const head = Math.ceil(k / 2), tail = k - head;
    chain.textContent = [...names.slice(0, head), "…", ...names.slice(names.length - tail)].join(" → ");
  };
  // 头尾各留一个起步；放得下就从全部开始往少里试
  for (let k = names.length; k >= 2; k--) { show(k); if (fits()) return; }
  // 头尾两个都放不下：只留最后一件（结果），再不行只写件数
  chain.textContent = `… → ${names[names.length - 1]}`; if (fits()) return;
  chain.textContent = ""; parts[0].textContent = `做了 ${s.count} 件事`;
}

const MOUNTS = { cur: mountCurrent, A: mountA, B: mountB, C: mountC, AC: () => mountA({ receipt: true }) };

/* 一块侧栏：用户消息 + 过程块 + 回答 + 输入框，结构同 sidepanel.html。 */
class Panel {
  constructor(host, variant, runKey) {
    this.variant = variant; this.run = window.RUNS[runKey]; this.sched = titleSchedule(this.run);
    const app = h("div", "proto-panel"); app.dataset.variant = variant;
    const frame = h("div"); frame.id = "messages-frame";
    const fadeTop = h("div", "scroll-fade"); fadeTop.dataset.edge = "top";
    const fadeBot = h("div", "scroll-fade"); fadeBot.dataset.edge = "bottom";
    const msgs = h("div"); msgs.id = "messages";
    msgs.append(h("div", "msg user", window.USER_ASK));
    this.block = MOUNTS[variant]();
    msgs.append(this.block.el);
    this.answer = h("div", "msg assistant markdown answer-latest"); this.answer.hidden = true; msgs.append(this.answer);
    frame.append(fadeTop, msgs, fadeBot);
    const dock = h("div", "composer-dock-wrap");
    dock.innerHTML = `<div id="composer" class="composer-glass-dock"><textarea id="input" rows="1" placeholder="补充或改方向…" tabindex="-1"></textarea><div id="composer-bar"><button id="attach-btn" class="composer-icon-btn" type="button" tabindex="-1">+</button><span id="composer-spacer"></span><button id="send-btn" class="kinetic-morph-button stopping" type="button" tabindex="-1"><span class="morph-icon-send"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg></span><span class="morph-icon-stop"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg></span></button></div></div>`;
    app.append(frame, dock);
    host.append(app);
    Object.assign(this, { app, frame, msgs });
    this.paras = [];
    this.pinned = true;
    msgs.addEventListener("scroll", () => { this.pinned = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 12; this.edges(); });
    this.block.details.addEventListener("toggle", () => { this.render(this.t ?? 0); });
  }
  edges() {
    const m = this.msgs;
    this.frame.dataset.fadeTop = String(m.scrollTop > 2);
    this.frame.dataset.fadeBottom = String(m.scrollHeight - m.scrollTop - m.clientHeight > 2);
  }
  render(t) {
    this.t = t;
    const s = snapshot(this.run, t, this.sched);
    this.block.update(s);
    // 回答：写的时候一段一段淡入
    const n = Math.ceil(s.answerFrac * window.ANSWER.length);
    this.answer.hidden = n === 0;
    while (this.paras.length < n) {
      const raw = window.ANSWER[this.paras.length];
      const span = h("span", "reveal-fade", raw.replace(/^\+/, ""));
      if (raw.startsWith("+") && this.answer.lastElementChild) this.answer.lastElementChild.append(span);
      else { const p = h("p"); p.append(span); this.answer.append(p); }
      this.paras.push(span);
    }
    while (this.paras.length > n) { const sp = this.paras.pop(); const p = sp.parentElement; sp.remove(); if (!p.childElementCount) p.remove(); }
    this.app.querySelector("#send-btn").classList.toggle("stopping", !s.ended);
    this.app.querySelector("#input").placeholder = s.ended ? "说说你想完成什么…" : "补充或改方向…";
    if (this.pinned) this.msgs.scrollTop = this.msgs.scrollHeight;
    this.edges();
    return s;
  }
  setOpen(on) { this.block.details.open = on; }
}

/* 播放：动手的部分 1.8 倍，长思考快进 16 倍；时钟读数一直按真实秒数走。 */
function speedAt(run, t, mode) {
  if (mode === "real") return 1;
  const st = run.steps.find((s) => s.s <= t && t < s.e);
  return st && st.kind === "think" && st.e - st.s > 5 ? 16 : 1.8;
}

window.Proto = { Panel, snapshot, titleSchedule, speedAt, spoken };
})();
