// 边说边做预览：真实侧栏 + 真实语音区，三个场景。插话停声、闲聊接话按 10-09 GPT-Live 实测节奏；圈词、查词耗时是目标，不是实测。
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NS = "http://www.w3.org/2000/svg";
const SVG = {
  think: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>',
  pen: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
  many: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
};

const SCENES = {
  chat: {
    intro: "<b>只是聊天</b>：你随口评论一句，它只接话。",
    outro: "闲聊：说完约 0.3 秒它就接话（实测）。网页没动，侧栏也没开任务卡。",
  },
  circle: {
    intro: "<b>圈高频词</b>：你说要它动手，它先应一声，然后光标去圈。",
    outro: "做事：它先应一声「我数一下」，光标边圈边在侧栏留下每一步；圈完只报数出来的结果。",
  },
  wiki: {
    intro: "<b>查维基 · 中途插话</b>：它开新标签页去查，读给你听；你嫌长，直接打断。",
    outro: "插话：约 0.2 秒停声（实测），只停说话、不停手，页面上的圈和任务结果都留着。说「停下这个任务」才会停手。",
  },
};

let scene = "chat", token = 0, D, M, R, tick, soundOn = true;
const alive = (t) => t === token;
class Cut extends Error {}
const guard = (t) => { if (!alive(t)) throw new Cut(); };
const wait = async (ms, t) => { await sleep(ms); guard(t); };

// ---------- 侧栏与语音区 ----------
const panel = $("#panel");
panel.srcdoc = PANEL_HTML;
panel.addEventListener("load", () => {
  D = panel.contentDocument;
  M = D.getElementById("messages");
  const starter = D.getElementById("starter"); if (starter) starter.hidden = true;
  // 语音区：与 voice-ui.ts 同一段结构，挂在输入框前。
  D.querySelectorAll(".voice-progress").forEach((x) => x.remove()); // 抓取时留下的那份（隐藏、idle），换成下面这份
  R = D.createElement("section");
  R.className = "voice-progress"; R.setAttribute("aria-label", "语音问进度");
  R.innerHTML = '<canvas class="voice-orb" aria-label="语音光球"></canvas><button class="voice-end" type="button">结束</button><div class="voice-state" role="status"></div><div class="voice-state-detail"></div><div class="voice-hint">随时插话 · 可调整当前任务</div><div class="voice-question voice-transcript"></div><div class="voice-transcript voice-answer"></div><div class="voice-facts"></div><div class="voice-sources"></div><div class="voice-actions"></div>';
  const stop = D.createElement("button"); stop.className = "voice-stop-speech"; stop.type = "button"; stop.textContent = "停声"; stop.hidden = true;
  R.querySelector(".voice-actions").append(stop, R.querySelector(".voice-end"));
  stop.onclick = () => { if (speakingCut) speakingCut(); };
  D.getElementById("input").before(R);
  mountOrb(R.querySelector(".voice-orb"));
  reset();
});

// 光球：同 orb-style.ts 的视频光球，按状态改速度、亮度和大小。
let orbState = "listening", orbLevel = 0;
function mountOrb(canvas) {
  const size = 112, dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  const video = Object.assign(document.createElement("video"), { src: "../../../extension/assets/orbs/dusk.mp4", muted: true, loop: true, playsInline: true, autoplay: true });
  video.play().catch(() => {});
  const t0 = performance.now(), MAX = 1.04;
  const look = (t) => orbState === "thinking" ? { rate: 1.45, b: 1, s: 1 }
    : orbState === "speaking" ? { rate: 1.2, b: 1.12, s: 1.02 + 0.02 * Math.sin(t * 7) }
    : { rate: 1.1, b: 1.08, s: 1 + 0.03 * orbLevel };
  const draw = () => {
    const l = look((performance.now() - t0) / 1000);
    if (video.playbackRate !== l.rate) video.playbackRate = l.rate;
    const c = canvas.width / 2, r = (c / MAX) * l.s;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.filter = l.b === 1 ? "none" : `brightness(${l.b})`;
    ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.clip();
    if (video.readyState >= 2) ctx.drawImage(video, c - r, c - r, r * 2, r * 2);
    ctx.restore();
    requestAnimationFrame(draw);
  };
  draw();
}

const STATE_TEXT = { listening: "在听", thinking: "在想", speaking: "在说" };
function voiceState(s, detail) {
  orbState = s; R.dataset.state = s;
  $(".voice-state", R).textContent = detail || STATE_TEXT[s];
  $(".voice-stop-speech", R).hidden = s !== "speaking";
}
// 字幕：说过的句子退成静默色，当前句墨色（同 voice-ui.ts renderAnswer）。
function renderAnswer(text, speaking) {
  const box = $(".voice-answer", R);
  const sentences = speaking ? text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) ?? [] : [];
  if (!sentences.length) { box.replaceChildren(); box.textContent = text; return; }
  const before = D.createElement("span"); before.textContent = sentences.slice(0, -1).join("");
  const cur = D.createElement("span"); cur.className = "voice-current-sentence"; cur.textContent = sentences.at(-1);
  box.replaceChildren(before, cur);
  box.scrollTop = 1e6;
}

// ---------- 你说话（预览用页面左下角的提示代替你的嗓子） ----------
const mic = $("#mic"), micText = $("#mic-text");
async function youSay(text, t) {
  const q = $(".voice-question", R);
  q.textContent = ""; micText.textContent = ""; mic.classList.add("on");
  const chunks = text.match(/[^，。！？、]{1,3}[，。！？、]?/g) ?? [text];
  for (const c of chunks) {
    q.textContent += c; micText.textContent += c; orbLevel = 0.4 + Math.random() * 0.6;
    await wait(170 + Math.random() * 90, t);
  }
  orbLevel = 0;
  await wait(250, t);
  mic.classList.remove("on");
}

// ---------- 它说话：浏览器中文语音真的念；字幕逐字跟上 ----------
let zhVoice = null;
const pickVoice = () => { const vs = speechSynthesis.getVoices(); zhVoice = vs.find((v) => /Tingting|婷婷/.test(v.name)) || vs.find((v) => v.lang === "zh-CN") || vs.find((v) => v.lang.startsWith("zh")) || null; };
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
let speakingCut = null, answerSoFar = "";
function tts(text) {
  if (!soundOn || !("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text);
    if (zhVoice) u.voice = zhVoice; u.lang = "zh-CN"; u.rate = 1.12;
    u.onend = u.onerror = () => done();
    speechSynthesis.speak(u);
    setTimeout(done, text.length * 320 + 1500);
  });
}
// 返回 "done" 或 "cut"。interrupt: { at: 第几句, after: 该句第几个字, then: async () => {} }，在那个字时你开口。
async function aiSay(sentences, t, interrupt) {
  voiceState("speaking");
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    let cut = false;
    const cutNow = () => { cut = true; speechSynthesis?.cancel(); };
    speakingCut = cutNow;
    const voice = tts(s);
    const start = answerSoFar;
    for (let k = 0; k < s.length; k++) {
      if (!alive(t)) { speechSynthesis?.cancel(); throw new Cut(); }
      if (cut) break;
      answerSoFar = start + s.slice(0, k + 1);
      renderAnswer(answerSoFar, true);
      if (interrupt && interrupt.at === i && interrupt.after === k) {
        // 全双工：你开口时它还在说；约 0.2 秒后停声。
        const you = youSay(interrupt.text, t);
        await wait(200, t);
        cutNow();
        answerSoFar += "……";
        voiceState("listening"); renderAnswer(answerSoFar, false);
        $(".voice-answer", R).style.color = "var(--text-quaternary)";
        await you;
        speakingCut = null;
        return "cut";
      }
      await sleep(soundOn ? 175 : 150);
    }
    if (cut) { speakingCut = null; voiceState("listening"); renderAnswer(answerSoFar, false); return "cut"; }
    await voice; guard(t);
  }
  speakingCut = null;
  renderAnswer(answerSoFar, false);
  return "done";
}
function newAnswer() { answerSoFar = ""; const b = $(".voice-answer", R); b.style.color = ""; renderAnswer("", false); }

// ---------- 网页 ----------
const site = $("#site"), vp = $("#vp"), ink = $("#ink"), layer = $("#layer"), tabs = $("#tabs"), url = $("#url");
const w = (word) => `<span class="w" data-w="${word}">${word}</span>`;
function renderBlog() {
  site.className = "blog";
  site.innerHTML = `<div class="kick">语音交互 · 笔记</div>
  <h1>全双工语音，为什么这么难做</h1>
  <div class="by">林小舟 · 10 月 6 日 · 约 4 分钟</div>
  <p>打电话的时候，两个人可以同时说话，也可以随时${w("打断")}对方。这就是${w("全双工")}。可大多数语音助手做不到：它们要等你说完，才轮到自己开口。</p>
  <p>难点有三个。第一是${w("延迟")}：从你停下到它回应，超过一秒，对话就像对讲机。第二是${w("回声")}：助手自己的声音被麦克风收回去，被误当成你在说话。第三是${w("打断")}：你一开口，它要立刻闭嘴，而不是把一整段念完。</p>
  <h2>新一代${w("全双工")}模型怎么做</h2>
  <p>${w("全双工")}模型一边听一边说。它不靠「静音多久算说完」来判断轮次，而是像人一样理解语义，回应${w("延迟")}压到了半秒左右。用户插话后约 0.2 秒，它就停了下来，${w("打断")}终于像人。</p>
  <p>但${w("全双工")}不等于万能。${w("回声")}消除仍然要靠设备；网络${w("延迟")}一抖，体验就退回半双工。更重要的是，听得懂之后，还得做得对。</p>
  <p>我的判断是：${w("全双工")}负责「聊」，后台助手负责「做」。你随口一句话，它分得清哪句是闲聊、哪句要动手；被${w("打断")}时，只停嘴，不停手。${w("回声")}，交给工程去磨。</p>`;
}
function renderWiki() {
  site.className = "wiki";
  site.innerHTML = `<div class="brand"><b>维基百科</b>自由的百科全书</div>
  <h1>回声消除</h1>
  <div class="from">维基百科，自由的百科全书</div>
  <p id="wk-lead"><b>回声消除</b>（Acoustic Echo Cancellation，AEC）是在双向通话中，去除扬声器播放后又被麦克风拾取的声音的技术。它最早用于长途<a>电话</a>线路，如今广泛用于手机、<a>视频会议</a>和<a>智能音箱</a>。</p>
  <p id="wk-how">常见做法是用<a>自适应滤波器</a>估计从扬声器到麦克风的回声路径，再从麦克风信号中减去估计出的回声。双方同时说话（双讲）时，滤波器容易出错，这是该领域的主要难点。</p>
  <div class="toc"><b>目录</b>1 原理<br>2 双讲检测<br>3 应用<br>4 参见</div>
  <p>在<a>全双工</a>语音系统中，回声消除决定了助手能否在自己说话时听清用户插话。</p>`;
}
function setTabs(list, active) {
  tabs.innerHTML = list.map((tb, i) => `<div class="tab ${tb.cls || ""} ${i === active ? "on" : ""}" id="tab-${i}"><i>${/wk/.test(tb.cls || "") ? "W" : ""}</i>${tb.title}</div>`).join("");
}
function clearInk() { ink.replaceChildren(); layer.replaceChildren(); tagYs = []; }
function boxOf(elm) { const r = elm.getBoundingClientRect(), v = vp.getBoundingClientRect(); return { x: r.left - v.left, y: r.top - v.top, w: r.width, h: r.height }; }
let seed = 7;
async function circle(elm, ms, pad = 3) {
  const b = boxOf(elm);
  const out = Rough.sketchFrame({ x: b.x - pad, y: b.y - pad + 1, w: b.w + pad * 2, h: b.h + pad * 2 - 2 }, { seed: seed++, roughness: 0.9 });
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", out.d); p.setAttribute("stroke", "#2d4a86"); p.setAttribute("stroke-width", "2.5");
  ink.append(p);
  const len = Math.ceil(p.getTotalLength());
  p.style.strokeDasharray = len; p.style.strokeDashoffset = len; p.getBoundingClientRect();
  p.style.transition = `stroke-dashoffset ${ms}ms ease-in-out`; p.style.strokeDashoffset = "0";
  await sleep(ms);
}
// 计数标签放在正文右侧空白，与第一处同高；同一行有两个就往下错开。
let tagYs = [];
function tag(elm, text) {
  const b = boxOf(elm), col = boxOf(site.querySelector("p")), t = document.createElement("div");
  let y = b.y - 2; while (tagYs.some((u) => Math.abs(u - y) < 26)) y += 26; tagYs.push(y);
  t.className = "tagcard"; t.style.left = `${col.x + col.w + 18}px`; t.style.top = `${y}px`;
  t.innerHTML = '<span class="orb-dot"></span><span></span>'; t.lastChild.textContent = text;
  layer.append(t); requestAnimationFrame(() => t.classList.add("on"));
}

// ---------- 光标 ----------
const ai = $("#ai"), win = $("#win");
let curXY = null;
function placeOf(elm, dx = 0.5) {
  const r = elm.getBoundingClientRect(), wr = win.getBoundingClientRect();
  return { x: r.left - wr.left + Math.min(r.width * dx, 80), y: r.top - wr.top + r.height * 0.6 };
}
async function moveTo(elm, label, ms, t, dx) {
  const p = placeOf(elm, dx), first = !curXY;
  ai.classList.add("on");
  $(".lbl .t", ai).textContent = label; $(".lbl", ai).classList.add("on");
  ai.style.transition = !first ? `transform ${ms}ms cubic-bezier(.3,.1,.2,1), opacity .2s` : "opacity .2s";
  ai.style.transform = `translate(${p.x}px, ${p.y}px)`; curXY = p;
  await wait(first ? 80 : ms, t);
}
const hideCursor = () => { $(".lbl", ai).classList.remove("on"); };

// ---------- 任务卡（同 route-replay 的真实侧栏写法） ----------
const el = (tag, cls, html) => { const e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
let run, trail, steps = [], started = 0;
function scrollEnd() { M.parentElement.scrollTop = 1e6; M.scrollTop = 1e6; }
function composer(running) {
  const input = D.getElementById("input"); if (input) input.placeholder = running ? "补充或改方向…" : "说说你想完成什么…";
  D.getElementById("composer")?.classList.toggle("steering-active", running);
  D.getElementById("send-btn")?.classList.toggle("stopping", running);
  for (const b of D.querySelectorAll("button")) if (b.textContent.trim() === "接管") b.hidden = !running;
}
function userMsg(text, chip) {
  const st = D.getElementById("starter"); if (st) st.hidden = true;
  M.append(el("div", "msg user", `<div class="user-msg-text">${esc(text)}</div>`), el("div", "ctx-chips", `<span class="ctx-chip"><span class="cl">${esc(chip)}</span></span>`));
  for (const tt of D.querySelectorAll(".conversation-title, .conversation-menu-title")) tt.textContent = text;
}
function startRun(icon) {
  run = el("details", "run-steps", `<summary><span class="run-icon"></span><span class="run-act-icon" data-kind="think">${SVG[icon]}</span><span class="run-title"><span class="act-verb"></span> <span class="act-object"></span></span><span class="run-time">0 秒</span><span class="run-chevron">${SVG.chev}</span></summary><div class="run-reveal"><div class="run-body"></div></div>`);
  run.querySelector("summary").addEventListener("click", (e) => e.preventDefault());
  trail = el("div", "run-trail"); steps = [];
  M.append(run, trail);
  started = performance.now();
  clearInterval(tick);
  tick = setInterval(() => { $(".run-time", run).textContent = `${Math.floor((performance.now() - started) / 1000)} 秒`; }, 200);
  composer(true); scrollEnd();
}
function title(verb, obj, icon) {
  $(".act-verb", run).textContent = verb; $(".act-object", run).textContent = obj ? `· ${obj}` : "";
  if (icon) $(".run-act-icon", run).innerHTML = SVG[icon];
}
function addStep(text, dur) {
  steps.push({ text, dur }); if (steps.length > 3) steps.shift();
  trail.innerHTML = steps.map((s) => `<div class="trail-step"><span class="trail-text">${esc(s.text)}</span><span class="trail-dur">${s.dur}</span></div>`).join("");
  scrollEnd();
}
function finishRun(count, answer) {
  clearInterval(tick);
  const secs = Math.round((performance.now() - started) / 1000);
  run.classList.add("done"); title("做了", "", "many"); $(".act-object", run).textContent = `${count} 件事`;
  trail.remove();
  M.append(el("div", "msg assistant markdown answer-latest", `<p>${answer}</p><div class="answer-actions"><button type="button" aria-label="复制回答">${SVG.copy}</button><span class="answer-time">${secs} 秒</span></div>`));
  composer(false); scrollEnd();
}
const since = (t0) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

// ---------- 三个场景 ----------
async function playChat(t) {
  await youSay("这作者把全双工比作打电话，挺形象的。", t);
  voiceState("thinking"); await wait(300, t);
  newAnswer();
  await aiSay(["是挺形象。", "打电话能同时说，也能随时插嘴，这正是它想做到的。"], t);
  voiceState("listening");
}

async function playCircle(t) {
  await youSay("这篇文章不错，帮我把里面的高频词圈出来。", t);
  voiceState("thinking"); await wait(300, t);
  newAnswer();
  userMsg("这篇文章不错，帮我把里面的高频词圈出来。", "全双工语音，为什么这么难做");
  startRun("think"); title("正在读", "这篇文章", "think");
  const ack = aiSay(["好，我数一下。"], t); ack.catch(() => {});
  // 委派：它还在应声，助手已经开始读页面。
  let t0 = performance.now();
  const paras = [...site.querySelectorAll("h1, p, h2")];
  for (const p of paras.slice(0, 4)) await moveTo(p, "正在读这篇文章", 380, t, 0.15);
  await ack; voiceState("thinking", "在圈高频词");
  for (const p of paras.slice(4)) await moveTo(p, "正在读这篇文章", 360, t, 0.15);
  addStep("读了这篇文章", since(t0));
  t0 = performance.now(); title("正在数", "词频", "think"); hideCursor();
  await wait(700, t);
  const groups = ["全双工", "打断", "延迟", "回声"].map((word) => ({ word, els: [...site.querySelectorAll(`.w[data-w="${word}"]`)] }));
  addStep(`数出 ${groups.length} 个高频词`, since(t0));
  t0 = performance.now();
  let total = 0;
  for (const g of groups) {
    title("正在圈", `${g.word} · ${g.els.length} 处`, "pen");
    for (const [i, e] of g.els.entries()) {
      await moveTo(e, `圈「${g.word}」`, 230, t);
      await circle(e, 240); guard(t);
      if (i === 0) tag(e, `${g.word} · ${g.els.length}`);
      total++;
    }
  }
  hideCursor();
  addStep(`圈了 ${total} 处`, since(t0));
  await wait(300, t);
  const summary = `出现最多的是「全双工」，${groups[0].els.length} 次；其次「打断」${groups[1].els.length} 次；「延迟」「回声」各 ${groups[2].els.length} 次。`;
  finishRun(3, `圈好了。${summary}`);
  const cn = (n) => "零一二三四五六七八九十"[n] ?? String(n);
  await aiSay(["圈好了。", `出现最多的是${groups[0].word}，${cn(groups[0].els.length)}次；其次是${groups[1].word}，${cn(groups[1].els.length)}次；${groups[2].word}和${groups[3].word}各${cn(groups[2].els.length)}次。`], t);
  voiceState("listening");
}

async function playWiki(t) {
  await youSay("帮我把回声消除在维基百科查一下。", t);
  voiceState("thinking"); await wait(300, t);
  newAnswer();
  userMsg("帮我把回声消除在维基百科查一下。", "全双工语音，为什么这么难做");
  startRun("globe"); title("正在打开", "维基百科", "globe");
  const ack = aiSay(["好，我去查。"], t); ack.catch(() => {});
  let t0 = performance.now();
  await moveTo($("#tab-0"), "正在打开维基百科", 420, t, 0.9);
  setTabs([{ title: "全双工语音，为什么这么难做" }, { title: "回声消除 - 维基百科", cls: "wk new" }], 1);
  url.textContent = "zh.wikipedia.org/wiki/回声消除";
  clearInk(); renderWiki();
  await moveTo($("#tab-1"), "正在打开维基百科", 300, t, 0.5);
  addStep("打开了维基百科「回声消除」", since(t0));
  await ack; voiceState("thinking", "在读回声消除");
  t0 = performance.now(); title("正在读", "回声消除", "think");
  await moveTo(site.querySelector("h1"), "正在读回声消除", 420, t, 0.3);
  await moveTo($("#wk-lead"), "正在读回声消除", 380, t, 0.1);
  await circle($("#wk-lead"), 520, 6); guard(t);
  await moveTo($("#wk-how"), "正在读回声消除", 380, t, 0.1);
  addStep("读了前两段，圈出定义", since(t0));
  hideCursor();
  await wait(400, t);
  finishRun(2, "回声消除（AEC）：在双向通话中，去掉扬声器播出后又被麦克风收进去的声音。最早用于长途电话，现在手机、视频会议和智能音箱都在用。");
  const r = await aiSay([
    "查到了。",
    "回声消除，是在双向通话里，把喇叭放出来、又被麦克风收进去的声音去掉。",
    "它最早用在长途电话上，现在手机、视频会议和智能音箱都在用；常见做法是用自适应滤波器，估计从喇叭到麦克风的回声路径，再把它减掉。",
  ], t, { at: 2, after: 22, text: "等一下，说简单点。" });
  if (r === "cut") {
    voiceState("thinking"); await wait(300, t);
    newAnswer();
    await aiSay(["简单说：让麦克风别把自己喇叭里的声音再听一遍。"], t);
  }
  voiceState("listening");
}

async function play() {
  const t = ++token, sc = SCENES[scene];
  $("#play").disabled = true;
  resetInner();
  narr(sc.intro);
  try {
    await wait(700, t);
    await ({ chat: playChat, circle: playCircle, wiki: playWiki })[scene](t);
    narr(sc.outro);
  } catch (e) { if (!(e instanceof Cut)) throw e; }
  if (alive(t)) $("#play").disabled = false;
}

// ---------- 控制 ----------
const narr = (html) => { $("#narr").innerHTML = html; };
function resetInner() {
  clearInterval(tick);
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (M) { M.innerHTML = ""; composer(false); for (const tt of D.querySelectorAll(".conversation-title, .conversation-menu-title")) tt.textContent = "新会话"; const st = D.getElementById("starter"); if (st) st.hidden = false; }
  if (R) { R.hidden = false; voiceState("listening"); $(".voice-question", R).textContent = ""; newAnswer(); }
  setTabs([{ title: "全双工语音，为什么这么难做" }], 0);
  url.textContent = "notes.example.cn/full-duplex";
  renderBlog(); clearInk();
  mic.classList.remove("on");
  ai.classList.remove("on"); hideCursor(); curXY = null; seed = 7;
}
function reset() { token++; resetInner(); $("#play").disabled = false; narr(`${SCENES[scene].intro} 点「播放」。`); }
for (const b of document.querySelectorAll(".seg button")) {
  b.onclick = () => { scene = b.dataset.sc; for (const x of document.querySelectorAll(".seg button")) x.setAttribute("aria-pressed", String(x === b)); reset(); };
}
$("#play").onclick = play;
$("#reset").onclick = reset;
$("#sound").onclick = () => { soundOn = !soundOn; $("#sound").setAttribute("aria-pressed", String(soundOn)); $("#sound").textContent = soundOn ? "声音 开" : "声音 关"; if (!soundOn) speechSynthesis?.cancel(); };
