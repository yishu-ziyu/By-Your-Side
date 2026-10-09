/* 预览脚本：侧栏是真实侧栏的 DOM + 真实样式；左边是虚构网站 Nimbus 云，表单真的能填。
   三个场景：新（先说一句 + 交给你）、新（没填就交还）、对照（现在的产品：发一句话等你说「继续」）。 */
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scene = "new";
let run = 0; // 每次重来递增，旧动画自己停
let doc; // 侧栏 document
let waiting = null; // 交给你期间：交还时要继续的函数
let saved = false; // 用户在网页上保存了银行卡
let timer = null;

const ASK = "帮我把 Nimbus 的开发者额度领了，账单没设好就先设好。";

/* ── 预览说明条 ── */
function narr(html) { $("#narr").innerHTML = html; }
const NEW = '<span class="new">新</span>';

/* ── 网页层 ── */
function view(name) {
  document.querySelectorAll("[data-view]").forEach((v) => v.classList.toggle("on", v.dataset.view === name));
  $("#nav-benefits").classList.toggle("on", name === "benefits");
  $("#nav-billing").classList.toggle("on", name === "billing");
  $("#url").textContent = `console.nimbus-cloud.example/${name}`;
  $("#vp").scrollTop = 0;
}
function owner(who) { // "agent" | "yours" | null
  $("#vp").classList.toggle("agent", who === "agent");
  $("#vp").classList.toggle("yours", who === "yours");
  const pill = $("#pill");
  if (!who) { pill.classList.remove("on"); return; }
  if (who === "agent") { $("#pill-text").innerHTML = "<b>助手正在操作</b>"; $("#pill-btn").textContent = "接管"; $("#pill-btn").className = ""; }
  else { $("#pill-text").innerHTML = "<b>现在归你</b> · 填好银行卡并保存，然后交还"; $("#pill-btn").textContent = "交还"; $("#pill-btn").className = "dark"; }
  pill.classList.add("on");
}
function resetPage() {
  view("benefits");
  for (const id of ["f-name", "f-card", "f-exp", "f-cvc"]) { const i = $("#" + id); i.value = ""; i.classList.remove("need"); }
  for (const id of ["claim-note", "claim-ok", "save-note", "save-ok"]) $("#" + id).classList.remove("on");
  saved = false; owner(null);
}
$("#claim").onclick = () => { $("#claim-ok").classList.toggle("on", saved); $("#claim-note").classList.toggle("on", !saved); };
$("#to-billing").onclick = (e) => { e.preventDefault(); view("billing"); };
$("#save").onclick = () => {
  const full = ["f-card", "f-exp", "f-cvc"].every((id) => $("#" + id).value.trim());
  $("#save-note").classList.toggle("on", !full);
  $("#save-ok").classList.toggle("on", full);
  if (full) { saved = true; ["f-card", "f-exp", "f-cvc"].forEach((id) => $("#" + id).classList.remove("need")); }
};
$("#pill-btn").onclick = () => { if (waiting) handBack(); };

/* ── 助手光标 ── */
const pos = { x: 0, y: 0 };
function place(p) { pos.x = p.x; pos.y = p.y; $("#ai").style.transform = `translate(${p.x}px, ${p.y}px)`; }
function cursorOn(on) { $("#ai").classList.toggle("on", on); if (!on) say(""); }
function say(text) { const l = $("#ai .lbl"); if (!text) { l.classList.remove("on"); return; } l.querySelector(".t").textContent = text; l.classList.add("on"); }
function ptOf(el) {
  const r = el.getBoundingClientRect(), win = $("#win").getBoundingClientRect();
  return { x: r.left - win.left + r.width * 0.5, y: r.top - win.top + r.height * 0.55 };
}
async function moveTo(el, my, ms = 650) {
  const to = ptOf(el), from = { ...pos };
  const dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy) || 1, bend = Math.min(70, d * 0.18);
  const cx = from.x + dx / 2 - (dy / d) * bend, cy = from.y + dy / 2 + (dx / d) * bend;
  const t0 = performance.now();
  while (true) {
    if (my !== run) return;
    const t = Math.min(1, (performance.now() - t0) / ms), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    place({ x: (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * to.x, y: (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * to.y });
    if (t >= 1) break;
    await new Promise(requestAnimationFrame);
  }
}
function ripple(el) {
  const p = ptOf(el), r = document.createElement("span");
  r.className = "ripple"; r.style.left = p.x + "px"; r.style.top = p.y + "px"; r.style.setProperty("--c", "#2d4a86");
  $("#cursors").append(r); setTimeout(() => r.remove(), 600);
}
async function aiClick(el, label, my) { say(label); await moveTo(el, my); if (my !== run) return; ripple(el); await sleep(180); el.click(); await sleep(350); }
async function aiType(el, text, label, my) {
  say(label); await moveTo(el, my); if (my !== run) return; ripple(el);
  for (const ch of text) { if (my !== run) return; el.value += ch; await sleep(60); }
  await sleep(250);
}

/* ── 侧栏（真实 DOM）操作 ── */
function loadPanel() {
  return new Promise((res) => {
    const f = $("#panel");
    f.onload = () => {
      doc = f.contentDocument;
      const st = doc.createElement("style");
      st.textContent = `
        .handoff-card { margin: 12px 0 6px; border: 1px solid var(--content-border); background: var(--content-subtle); border-radius: 14px; padding: 12px 14px 13px; }
        .hc-head { display: flex; gap: 8px; align-items: center; font-weight: 600; color: var(--text-primary); font-size: 13.5px; }
        .hc-dot { width: 8px; height: 8px; border-radius: 50%; background: #d2602a; flex: none; }
        .handoff-card p { margin: 6px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
        .handoff-card p b { color: var(--text-primary); font-weight: 500; }
        .hc-acts { margin-top: 11px; display: flex; gap: 8px; align-items: center; }
        .hc-primary { white-space: nowrap; flex: none; font: 500 13px -apple-system, "PingFang SC", sans-serif; background: var(--text-primary); color: #fff; border: 0; border-radius: 999px; padding: 6px 15px; cursor: pointer; }
        .hc-hint { font-size: 12px; color: var(--text-tertiary); }
        .handoff-card.done { background: transparent; border-color: transparent; padding: 2px 0; }
        .handoff-card.done .hc-head { font-weight: 400; color: var(--text-tertiary); font-size: 12.5px; }
        .handoff-card.done .hc-dot { background: var(--text-tertiary); }
        .handoff-card.done p, .handoff-card.done .hc-acts { display: none; }
        .run-trail .trail-step.wait::before { content: "⏳"; }
        .run-trail .trail-step.wait .trail-text { color: #b4531f; }
        .run-trail .trail-say { margin: 6px 0 6px -14px; font-size: 14px; line-height: 1.6; color: var(--text-primary); white-space: normal; animation: trailIn .32s cubic-bezier(.2, .8, .2, 1) both; }
        .msg.assistant.pre { margin-bottom: 2px; }
      `;
      doc.head.append(st);
      doc.getElementById("takeover-btn").addEventListener("click", () => { if (waiting) handBack(); });
      doc.getElementById("input").addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.shiftKey) return;
        e.preventDefault();
        if (scene === "old" && waiting && /继续/.test(e.target.value)) handBack(e.target.value.trim());
      });
      res();
    };
    f.srcdoc = PANEL_HTML;
  });
}
const msgs = () => doc.getElementById("messages");
function scrollEnd() { const f = doc.getElementById("messages-frame"); if (f) f.scrollTop = 1e6; msgs().scrollTop = 1e6; }
function el(html) { const t = doc.createElement("div"); t.innerHTML = html.trim(); return t.firstElementChild; }
function composer(state) { // "idle" | "running" | "yours"
  const send = doc.getElementById("send-btn"), tk = doc.getElementById("takeover-btn"), input = doc.getElementById("input");
  send.classList.toggle("stopping", state !== "idle");
  tk.hidden = state === "idle";
  tk.textContent = state === "yours" ? "交还" : "接管";
  tk.dataset.mode = state === "yours" ? "handback" : "takeover";
  input.placeholder = state === "yours" ? "现在归你。可补充要求，Enter 保存；点「交还」后生效" : state === "running" ? "补充或改方向..." : "说说你想完成什么…";
}
async function typeAsk(text, my) {
  const input = doc.getElementById("input");
  for (const ch of text) { if (my !== run) return; input.value += ch; await sleep(28); }
  await sleep(250);
  input.value = "";
  doc.getElementById("app")?.classList.remove("conversation-empty");
  const m = el(`<div class="msg user"><div class="user-msg-text"></div></div>`);
  m.firstChild.textContent = text; msgs().append(m);
  scrollEnd();
}
async function reveal(node, my) {
  const w = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts = [];
  while (w.nextNode()) texts.push(w.currentNode);
  const full = texts.map((t) => t.textContent); texts.forEach((t) => (t.textContent = ""));
  for (let i = 0; i < texts.length; i++) for (let j = 0; j < full[i].length; j += 2) { if (my !== run) return; texts[i].textContent = full[i].slice(0, j + 2); scrollEnd(); await sleep(20); }
}
async function line(html, my, cls = "pre") { // 助手说的一句话（动手前、中途发现）
  const m = el(`<div class="msg assistant markdown ${cls}"><p>${html}</p></div>`);
  msgs().append(m); await reveal(m, my); return m;
}
function runBlock(verb = "正在思考") { // 侧栏的步骤块：标题行 + 最近几步
  const d = el(`<details class="run-steps"><summary><span class="run-icon"></span><span class="run-act-icon" data-kind="think"></span><span class="run-title"><span class="act-verb">${verb}</span> <span class="act-object"></span></span><span class="run-chain"></span><span class="run-time">0 秒</span><span class="run-chevron"></span></summary></details>`);
  const trail = el(`<div class="run-trail"></div>`);
  msgs().append(d, trail); scrollEnd();
  let n = 0, secs = 0;
  clearInterval(timer);
  timer = setInterval(() => { secs++; d.querySelector(".run-time").textContent = `${secs} 秒`; }, 1000);
  return {
    step(text, dur = "0.2s", cls = "") {
      n += cls === "wait" ? 0 : 1;
      d.querySelector(".act-object").textContent = n ? `· 已做 ${n} 件事` : "";
      const s = el(`<div class="trail-step ${cls}"><span class="trail-text"></span><span class="trail-dur">${dur}</span></div>`);
      s.firstChild.textContent = text; trail.append(s); scrollEnd(); return s;
    },
    async say(html, my) { const s = el(`<div class="trail-say">${html}</div>`); trail.append(s); await reveal(s, my); },
    verb(v) { d.querySelector(".act-verb").textContent = v; },
    settle(waitText) { // 交还后：标题改成做了几件事，等你那一行改成实际结果
      const w = trail.querySelector(".trail-step.wait:last-of-type") || [...trail.querySelectorAll(".trail-step.wait")].pop();
      if (w && waitText) { w.classList.remove("wait"); w.firstChild.textContent = waitText; }
      d.querySelector(".act-verb").textContent = "做了"; d.querySelector(".act-object").textContent = `${n} 件事`; d.querySelector(".run-time").textContent = "";
    },
    stop() { clearInterval(timer); },
  };
}
async function answer(html, my, secs) {
  const m = el(`<div class="msg assistant markdown answer-latest">${html}</div>`);
  msgs().append(m); await reveal(m, my);
  m.append(el(`<div class="answer-actions"><span class="answer-time">${secs} 秒</span></div>`));
  scrollEnd();
}
function handoffCard(title, body) {
  const c = el(`<div class="handoff-card"><div class="hc-head"><span class="hc-dot"></span><span class="hc-title"></span></div><p>${body}</p><p>交给你期间，我不读也不动这个页面。</p><div class="hc-acts"><button type="button" class="hc-primary">做好了，交还</button><span class="hc-hint">或点页面下方的「交还」</span></div></div>`);
  c.querySelector(".hc-title").textContent = title;
  c.querySelector(".hc-primary").onclick = () => { if (waiting) handBack(); };
  msgs().append(c); scrollEnd(); return c;
}

/* ── 交给你 / 交还 ── */
function handTo(card, cont) {
  owner("yours"); composer("yours"); cursorOn(false);
  ["f-card", "f-exp", "f-cvc"].forEach((id) => { if (!$("#" + id).value) $("#" + id).classList.add("need"); });
  waiting = { card, cont };
  $("#fake-fill").hidden = false;
}
function handBack(text) {
  const w = waiting; if (!w) return;
  waiting = null; $("#fake-fill").hidden = true; $("#fake-continue").hidden = true;
  if (w.card) { w.card.classList.add("done"); w.card.querySelector(".hc-title").textContent = "你已交还 · 我从你所在的页面接着做"; }
  w.cont(text);
}
$("#fake-fill").onclick = async () => {
  const my = run;
  view("billing");
  for (const [id, v] of [["f-card", "4111 1111 1111 1111"], ["f-exp", "09/28"], ["f-cvc", "123"]]) { const i = $("#" + id); i.value = ""; for (const ch of v) { if (my !== run) return; i.value += ch; await sleep(25); } }
  $("#save").click();
  narr(`${NEW}保存好了。现在点 <b>「做好了，交还」</b>（侧栏卡片、页面胶囊、输入框旁任选一个）。`);
};

/* ── 场景：新 ── */
async function playNew(my, emptyFirst) {
  composer("idle");
  await typeAsk(ASK, my); if (my !== run) return;
  composer("running");
  await sleep(900);
  narr(`${NEW}<b>① 动手前先说一句</b>：打算做什么，哪些不会碰；和第一个动作一起发出，不多等一轮。页面蓝框 + 底部「助手正在操作 · 接管」胶囊也是新加的（学 Gemini）。`);
  await line("我先打开权益页领取额度；没有账单账号就去建一个。<b>卡号和安全码我会停下交给你填，不会替你付款。</b>", my);
  if (my !== run) return;
  const r = runBlock();
  owner("agent"); place(ptOf($("#nav-billing"))); cursorOn(true);
  await sleep(400);
  r.step("读了 我的权益", "0.3s");
  await aiClick($("#claim"), "点「领取 $30」", my); if (my !== run) return;
  r.step("点了 领取 $30", "0.4s");
  await sleep(500);
  narr(`${NEW}<b>② 计划变了，补一句</b>：发现新情况时说出来，不闷头改道。`);
  await r.say("发现这个账号还没有账单账号，先去建一个。", my);
  await aiClick($("#to-billing"), "打开账单设置", my); if (my !== run) return;
  r.step("打开了 设置账单账号", "0.2s");
  await aiType($("#f-name"), "我的账单", "填写账号名称", my); if (my !== run) return;
  r.step("填写了 账号名称", "0.5s");
  await sleep(300);
  r.verb("等你"); r.step("等你 · 填写银行卡", "", "wait"); r.stop();
  const card = handoffCard("需要你来这一步", "在左边填好 <b>卡号、有效期和安全码</b>，点「保存」。");
  handTo(card, () => resume(my, r));
  narr(`${NEW}<b>③ 需要你来这一步</b>：页面框变橙，侧栏卡片说清要做什么。${emptyFirst ? "这个场景请<b>直接点「做好了，交还」</b>，看它怎么处理没填的情况。" : "在左边随便填一组数字并保存，或点「模拟你填好并保存」。"}`);
}
async function resume(my, prev) {
  prev.settle(saved ? "你填好了 银行卡" : "你交还了（银行卡没保存）");
  owner("agent"); composer("running"); cursorOn(true);
  const r = runBlock("正在思考");
  await sleep(500); if (my !== run) return;
  view("billing");
  r.step("读了 设置账单账号", "0.3s");
  await sleep(500);
  if (!saved) {
    r.verb("等你"); r.step("等你 · 银行卡还没保存", "", "wait"); r.stop();
    await line("卡号和安全码还空着，页面还在等你。", my, "pre");
    const card = handoffCard("还差这一步", "填好 <b>卡号、有效期和安全码</b> 后点「保存」，再交还给我。");
    handTo(card, () => resume(my, r));
    narr(`${NEW}<b>④ 没填就交还</b>：它先读页面再判断，说清还差什么，再交给你一次；不会自己去填，也不会假装做完。`);
    return;
  }
  r.step("确认 银行卡已保存", "0.2s");
  narr(`${NEW}<b>交还后</b>：它先重读你所在的页面，确认你做完，再接着做剩下的。`);
  view("benefits"); r.step("打开了 我的权益", "0.2s");
  await aiClick($("#claim"), "点「领取 $30」", my); if (my !== run) return;
  r.step("点了 领取 $30", "0.4s");
  await sleep(300); r.step("读到 已领取 $30", "0.2s"); r.verb("做完了"); r.stop();
  cursorOn(false); owner(null); composer("idle");
  await answer("<p><b>领到了 $30</b>，已存入账单账号「我的账单」。三笔各 $10（7 月、9 月、10 月），领取后一年内有效。</p><p>银行卡是你填写并保存的，我没有读卡号。</p>", my, 41);
  narr("演示结束。可以换场景，或点「重来」。");
}

/* ── 场景：对照（现在的产品） ── */
async function playOld(my) {
  composer("idle");
  await typeAsk(ASK, my); if (my !== run) return;
  composer("running");
  narr("现在：发出后直接开始操作，<b>不先说打算做什么</b>。");
  const r = runBlock();
  owner(null); place(ptOf($("#nav-billing"))); cursorOn(true);
  await sleep(1400);
  r.step("读了 我的权益", "0.3s");
  await aiClick($("#claim"), "点「领取 $30」", my); if (my !== run) return;
  r.step("点了 领取 $30", "0.4s");
  await sleep(700);
  await aiClick($("#to-billing"), "打开账单设置", my); if (my !== run) return;
  r.step("打开了 设置账单账号", "0.2s");
  await aiType($("#f-name"), "我的账单", "填写账号名称", my); if (my !== run) return;
  r.step("填写了 账号名称", "0.5s"); r.verb("停下了"); r.stop();
  cursorOn(false); composer("idle");
  await answer("<p>需要你填写银行卡信息（卡号、有效期、安全码）。填好后告诉我「继续」。</p>", my, 19);
  waiting = { card: null, cont: (t) => oldResume(my, t || "继续") };
  $("#fake-continue").hidden = false;
  narr("现在：任务<b>到此结束</b>，页面没有归属变化，也没标出要填哪几栏。你填完后要在输入框打「继续」（或点「模拟你输入『继续』」）。");
}
async function oldResume(my, text) {
  const m = el(`<div class="msg user"><div class="user-msg-text"></div></div>`); m.firstChild.textContent = text; msgs().append(m);
  doc.getElementById("input").value = "";
  composer("running"); cursorOn(true);
  const r = runBlock();
  await sleep(1500); if (my !== run) return;
  view("billing"); r.step("读了 设置账单账号", "0.3s");
  if (!saved) { r.verb("停下了"); r.stop(); cursorOn(false); composer("idle"); await answer("<p>银行卡信息还没有保存，请先填写并保存后再告诉我「继续」。</p>", my, 6); waiting = { card: null, cont: (t) => oldResume(my, t || "继续") }; $("#fake-continue").hidden = false; return; }
  view("benefits"); r.step("打开了 我的权益", "0.2s");
  await aiClick($("#claim"), "点「领取 $30」", my); if (my !== run) return;
  r.step("点了 领取 $30", "0.4s"); r.stop();
  cursorOn(false); composer("idle");
  await answer("<p>已领取 $30。</p>", my, 9);
  narr("对照演示结束。");
}
$("#fake-continue").onclick = () => { if (!saved) $("#fake-fill").onclick(); setTimeout(() => handBack("继续"), 900); };

/* ── 控制条 ── */
async function reset() {
  run++; waiting = null; clearInterval(timer);
  $("#fake-fill").hidden = true; $("#fake-continue").hidden = true;
  resetPage(); cursorOn(false);
  await loadPanel(); composer("idle");
  narr(scene === "old" ? "对照：现在的产品怎么处理“要你填卡号”。点 <b>▶ 播放</b>。" : `${NEW}助手动手前先说一句；遇到卡号这一步，主动把页面交给你。点 <b>▶ 播放</b>。`);
}
document.querySelectorAll("[data-scene]").forEach((b) => (b.onclick = () => {
  scene = b.dataset.scene;
  document.querySelectorAll("[data-scene]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  reset();
}));
$("#play").onclick = async () => { await reset(); const my = run; if (scene === "old") playOld(my); else playNew(my, scene === "empty"); };
$("#reset").onclick = reset;
reset();
