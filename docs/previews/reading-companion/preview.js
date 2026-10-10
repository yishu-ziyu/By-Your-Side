// 伴读改口预览：左边是网页和真实阅读卡样式，右边是真实侧栏 DOM 与样式表。带「新」的是要改的交互；勾上「对照：现在的产品」看今天的行为。
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svg = (paths, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;
const ICON = {
  sparkles: svg('<path d="M9.94 14.06 4 20M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  copy: svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  panel: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>'),
  up: svg('<path d="m5 12 7-7 7 7M12 19V5"/>'),
  stop: svg('<rect width="12" height="12" x="6" y="6" rx="1.5"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  quote: svg('<path d="M17 5H3"></path><path d="M21 12H8"></path><path d="M21 19H8"></path><path d="M3 12v7"></path>'),
  open: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
};

const PARA = '城市中心的气温常比郊区高出两到三度，这被称为城市热岛效应；差距在夜里最明显。';
const DEF = '「城市热岛效应」是气候学里的一个术语，指城市中心的气温明显高于周围郊区的现象。因为城市在温度分布图上像一座比周围更热的「岛」，所以叫热岛。衡量它通常看城区和郊区同一时刻的温差，单位是摄氏度。这个词最早在十九世纪的伦敦气象记录里出现，后来被用来描述世界各地的大城市……';
const WHY = '原因主要有三层：\n\n1. 沥青和混凝土白天吸热多，夜里慢慢放热，所以夜间温差最大。\n2. 城里楼多树少，水分蒸发带走的热量少。\n3. 空调、汽车和工厂直接往外排热。\n\n所以原文说高出两到三度，而且夜里最明显。';
const WHY_FIRST = '先说原因：沥青和混凝土白天吸热、夜里放热，城里树少、蒸发少，再加上空调和汽车排热，所以市中心比郊区高两到三度，夜里差得最多。\n\n这叫「城市热岛效应」：城市在温度图上像一座更热的岛。';
const EVIDENCE = '依据：[热岛观测报告](#b) 记录了 2025 年夏季 42 个站点的数据，市中心夜间平均比郊区高 2.6 度，白天高 1.1 度，并认为路面和建筑夜里放热是主要来源。这和原文「高出两到三度、夜里最明显」一致。';

const state = { step: 1, today: false, card: 'hidden', streaming: null, prefSaved: false, prefForgotten: false, round: 1, verified: false, asked: false };
const today = $('#today');
today.onchange = () => { state.today = today.checked; restart(); };
$('#restart').onclick = () => restart(true);

function setStep(n, hint) {
  state.step = Math.max(state.step, n);
  for (const el of document.querySelectorAll('.step')) {
    const s = Number(el.dataset.step);
    el.classList.toggle('on', s === n);
    el.classList.toggle('done', s < n || (s === 3 && state.verified) || (s === 4 && state.prefSaved));
  }
  if (hint) $('#hint').innerHTML = hint;
}

// ── 网页上的阅读卡：真实 ASK_STYLES，放在 shadow root 里，和产品一样 ──
const host = document.createElement('div');
// 和产品一样：卡片宿主不接点击，只有卡片本身接。
host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';
document.body.append(host);
const root = host.attachShadow({ mode: 'open' });
root.innerHTML = `<style>${ASK_STYLES}
  .turn.folded .answer { max-height: 3.4em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 40%, transparent); }
  .fold { font-size: 11px; color: #5779bf; min-height: 22px; padding: 0 6px; margin-left: -6px; }
  .tag { display: inline-block; font-size: 11px; color: #b4532a; background: #fbeee8; border-radius: 4px; padding: 0 5px; margin-left: 6px; font-weight: 500; }
  .memo { margin: 2px 16px 12px; font-size: 12.5px; color: #3f3f45; }
  .memo p { margin: 0; }
  .memo .pills { display: flex; gap: 6px; margin-top: 6px; }
  .memo .pills button { min-height: 28px; font-size: 12px; border: 1px solid #e3e3e6; border-radius: 14px; padding: 0 10px; }
  .memo .pills button.yes { background: #222225; color: #fff; border-color: #222225; }
  .memo.saved { color: #55555c; display: flex; gap: 6px; align-items: center; }
  .memo.saved button { min-height: 24px; font-size: 11.5px; color: #5779bf; padding: 0 4px; }
  .used { margin: 6px 0 0; font-size: 11.5px; color: #77777d; }
  .used button { min-height: 22px; font-size: 11.5px; color: #5779bf; padding: 0 4px; }
  .footer .verify { color: #232326; font-weight: 550; }
  .footer .verify .tag { margin-left: 0; }
</style>
<section class="surface" role="dialog" aria-label="划词阅读" hidden></section>`;
const surface = $('.surface', root);
const para = $('#para');

function placeCard() {
  if (surface.hidden) return;
  const r = para.getBoundingClientRect();
  const box = surface.getBoundingClientRect();
  surface.style.left = `${Math.max(12, Math.min(r.left + r.width / 2 - box.width / 2, innerWidth - 372 - box.width))}px`;
  surface.style.top = `${Math.max(12, Math.min(r.bottom + 8, innerHeight - box.height - 12))}px`;
}
$('#page').addEventListener('scroll', placeCard);
addEventListener('resize', placeCard);

function showBar() {
  surface.className = 'surface enter';
  surface.hidden = false;
  surface.innerHTML = `<div class="bar"><button class="ask"><span class="identity">${ICON.sparkles}</span>问 AI</button><button class="explain" data-act="explain">解释</button><button>朗读</button><button>转入侧栏</button></div>`;
  $('[data-act="explain"]', root).onclick = explain;
  placeCard();
}

function expandCard() {
  surface.className = 'surface expanded';
  surface.innerHTML = `
    <div class="header"><span class="identity">${ICON.sparkles}</span><span class="site">article-a.test</span><button class="icon" data-act="close" aria-label="收起阅读">${ICON.x}</button></div>
    <details class="quote"><summary>“${PARA}”</summary><p>${PARA}</p></details>
    <div class="messages" tabindex="0" aria-label="阅读问答"></div>
    <form class="composer"><textarea rows="1" aria-label="关于选中文字的问题" placeholder="继续问这段文字…"></textarea><button class="send" type="submit" aria-label="发送问题">${ICON.up}</button></form>
    <div class="footer"><button data-act="copy">${ICON.copy}复制</button><span style="flex:1"></span><button data-act="verify" class="verify" hidden>${ICON.search}找依据 <span class="tag">新</span></button><button data-act="handoff">${ICON.panel}在侧栏继续</button></div>`;
  $('[data-act="close"]', root).onclick = () => { surface.hidden = true; };
  const form = $('form', root), input = $('textarea', root);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value.trim()); } });
  input.addEventListener('input', syncSend);
  form.onsubmit = (e) => { e.preventDefault(); if (state.streaming && !input.value.trim()) return stopCurrent(); if (state.streaming && state.today) return stopCurrent(); submit(input.value.trim()); };
  $('[data-act="verify"]', root).onclick = verify;
  placeCard();
}

function syncSend() {
  const btn = $('.send', root), input = $('textarea', root);
  if (!btn) return;
  // 现在：生成中按钮固定是「停止」。改后：生成中输入了改口，按钮变成发送，回车即改口。
  const asStop = state.streaming && (state.today || !input.value.trim());
  btn.innerHTML = asStop ? ICON.stop : ICON.up;
  btn.setAttribute('aria-label', asStop ? '停止回答' : state.streaming ? '改口：停下旧回答，按这句重答' : '发送问题');
  btn.title = btn.getAttribute('aria-label');
}

function addTurn(question, tag = '') {
  const t = document.createElement('article');
  t.className = 'turn';
  t.innerHTML = `<div class="question"></div><div class="answer"></div><div class="status" role="status"></div>`;
  $('.question', t).textContent = question;
  if (tag) $('.question', t).insertAdjacentHTML('beforeend', `<span class="tag">${tag}</span>`);
  $('.messages', root).append(t);
  return t;
}

const md = (text) => text.split('\n\n').map((p) => /^\d\./.test(p) ? `<ol>${p.split('\n').map((l) => `<li>${l.replace(/^\d\.\s*/, '')}</li>`).join('')}</ol>` : `<p>${p}</p>`).join('');

function stream(target, text, { speed = 45, render = (t) => md(t), onDone } = {}) {
  let i = 0, stopped = false;
  const ctl = { stop() { stopped = true; }, done: false };
  (async () => {
    while (!stopped && i < text.length) {
      i = Math.min(text.length, i + 2);
      target(render(text.slice(0, i)));
      await sleep(speed);
    }
    ctl.done = !stopped;
    if (!stopped) onDone?.();
  })();
  return ctl;
}

function explain() {
  para.classList.add('hl');
  expandCard();
  const turn = addTurn('解释这段文字');
  const answer = $('.answer', turn), status = $('.status', turn);
  status.textContent = '正在生成…';
  const firstWhy = state.round > 1 && state.prefSaved && !state.prefForgotten && !state.today;
  const text = firstWhy ? WHY_FIRST : DEF;
  const ctl = stream((h) => { answer.innerHTML = h; const m = $('.messages', root); m.scrollTop = m.scrollHeight; placeCard(); }, text, { speed: firstWhy ? 30 : 110, onDone: () => {
    state.streaming = null; status.textContent = ''; syncSend();
    if (firstWhy) usedLine(turn);
    else if (state.round > 1) setStep(5, state.today ? '现在的产品：阅读卡不带记忆，所以新会话里还是先讲定义。取消勾选「对照」看改后。' : '记忆已忘掉，所以这次按默认先讲定义。');
    else setStep(2, '旧解释已经写完了。点「从头再来」，在它还在写的时候改口。');
  } });
  ctl.turn = turn;
  state.streaming = ctl;
  syncSend();
  if (state.round === 1) setStep(2, `解释还在写的时候，在卡片下面的输入框里打「不是定义，我想知道为什么」，按回车。 <button id="fill">帮我填入这句</button>`);
  else setStep(5, firstWhy ? '新会话、新的一次「解释」：阅读卡也带上了你确认过的偏好，先讲原因。' : '');
  $('#fill')?.addEventListener('click', () => { const i = $('textarea', root); i.value = '不是定义，我想知道为什么'; i.focus(); syncSend(); });
}

function stopCurrent() {
  const ctl = state.streaming;
  if (!ctl) return;
  ctl.stop();
  state.streaming = null;
  $('.status', ctl.turn).textContent = '已停止，内容已保留';
  syncSend();
}

function submit(text) {
  if (!text) return;
  if (state.streaming && state.today) {
    // 现在的产品：生成中回车被吞掉，没有任何提示（ask.ts 的 Enter 只在不忙时发送）。
    setStep(2, '现在的产品：回车没有反应，也没有提示，旧解释照写。要先点 ■ 停止，再按一次回车，改口才发得出去。');
    return;
  }
  const input = $('textarea', root);
  const correcting = Boolean(state.streaming);
  if (correcting) {
    const old = state.streaming.turn;
    stopCurrent();
    old.classList.add('folded');
    $('.status', old).innerHTML = '已停止，内容已保留 <button class="fold">展开</button>';
    $('.fold', old).onclick = () => { old.classList.toggle('folded'); $('.fold', old).textContent = old.classList.contains('folded') ? '展开' : '收起'; };
  }
  input.value = '';
  const turn = addTurn(text, correcting && !state.today ? '已改口' : '');
  const answer = $('.answer', turn), status = $('.status', turn);
  status.textContent = '正在生成…';
  const ctl = stream((h) => { answer.innerHTML = h; const m = $('.messages', root); m.scrollTop = m.scrollHeight; placeCard(); }, WHY, { speed: 35, onDone: () => {
    state.streaming = null; status.textContent = ''; syncSend();
    if (!state.today) { $('[data-act="verify"]', root).hidden = false; memoryAsk(); }
    setStep(3, state.today ? '现在的产品：阅读卡不能去别的网页查证据，也不会问要不要记住。取消勾选「对照」看改后。' : '原文这一段一直高亮着。点卡片底部的「找依据」，或者先在卡片里回答要不要记住。');
  } });
  ctl.turn = turn;
  state.streaming = ctl;
  syncSend();
  if (correcting && !state.today) note(surface, '回车就是改口：旧回答停在原处、可展开，新回答仍对着这一段', -46);
}

function note(anchor, text, dy = -40) {
  const r = anchor.getBoundingClientRect();
  const n = document.createElement('div');
  n.className = 'note-new';
  n.textContent = `新 · ${text}`;
  n.style.left = `${Math.max(8, r.left)}px`;
  n.style.top = `${Math.max(84, r.top + dy)}px`;
  document.body.append(n);
  setTimeout(() => n.remove(), 4200);
}

// ── 记住偏好：改口后在卡片里问一句，用户点「记住」才生效 ──
function memoryAsk() {
  if (state.asked) return;
  state.asked = true;
  const m = document.createElement('div');
  m.className = 'memo';
  m.innerHTML = `<p>以后解释时先讲原因，要我记住吗？<span class="tag">新</span></p><div class="pills"><button class="yes">记住</button><button class="once">这次就行</button><button>改一下</button></div>`;
  $('.messages', root).after(m);
  $('.yes', m).onclick = () => {
    state.prefSaved = true; state.prefForgotten = false;
    m.className = 'memo saved';
    m.innerHTML = `<span>已记住：以后解释时先讲原因</span><button class="undo">撤销</button><button class="view">查看</button>`;
    $('.undo', m).onclick = () => { state.prefSaved = false; m.innerHTML = '<span>已撤销，不记</span>'; };
    $('.view', m).onclick = () => { const b = panelDoc.querySelector('#memory-open'); b.style.outline = '2px solid #b4532a'; setTimeout(() => (b.style.outline = ''), 1600); };
    setStep(5, '偏好已生效，可在侧栏「记忆」里查看、修改、忘记。点侧栏右上角的「新会话」图标，再点第二段 → 解释，看下次会不会先讲原因。');
  };
  $('.once', m).onclick = () => { m.className = 'memo saved'; m.innerHTML = '<span>好，只这次</span>'; };
  placeCard();
}

function usedLine(turn) {
  const u = document.createElement('div');
  u.className = 'used';
  u.innerHTML = `按你说过的「以后解释时先讲原因」 <button class="forget">忘掉</button><button>这里别用</button>`;
  turn.append(u);
  $('.forget', u).onclick = () => { state.prefForgotten = true; u.textContent = '已忘掉。下次解释按默认先讲定义。'; setStep(5, '已忘掉。再点一次「从头再来」之外的路径：关掉卡片，重新点第二段 → 解释，会先讲定义。'); };
  placeCard();
}

// ── 找依据：侧栏接手，带着这一段；证据页在后台标签打开，用户的页不动 ──
let panelDoc;
const panel = $('#panel');
panel.srcdoc = PANEL_HTML;
panel.onload = () => {
  panelDoc = panel.contentDocument;
  $('.conversation-title', panelDoc).textContent = '城市为什么更热';
  panelDoc.querySelector('#conversation-new').onclick = newConversation;
};

const messagesEl = () => $('#messages', panelDoc);
function panelAdd(html) {
  const wrap = panelDoc.createElement('div');
  wrap.innerHTML = html;
  const nodes = [...wrap.childNodes];
  for (const n of nodes) messagesEl().insertBefore(n, $('#resume-entry-root', panelDoc));
  return nodes.find((n) => n.nodeType === 1);
}

async function verify() {
  if (state.verified) return;
  state.verified = true;
  $('[data-act="verify"]', root).disabled = true;
  setStep(3, '侧栏接手：你的提问带着这一段（引用条）。证据页在后台标签打开，你看的页面不动。');
  panelAdd(`<div class="msg user"><div class="user-msg-text">给这一段的原因找依据</div></div>
    <div class="ctx-chips" aria-label="这一轮带给助手的内容"><span class="ctx-chip" title="城市为什么更热"><span class="cg"></span><span class="cl">城市为什么更热</span></span><span class="ctx-chip" data-quote style="cursor:pointer;outline:1px dashed #b4532a" title="点一下：回到原文这一段（新）"><span class="cg">${ICON.quote}</span><span class="cl">「城市中心的气温常比…」</span></span></div>`);
  $('[data-quote]', panelDoc).onclick = backToPara;
  const run = panelAdd(`<details class="run-steps running"><summary><span class="run-icon"></span><span class="run-act-icon" data-kind="open">${ICON.open}</span><span class="run-title"><span class="act-verb">正在后台打开</span> <span class="act-object">热岛观测报告</span></span><span class="run-chain">读取页面结构 → 后台打开标签页</span><span class="run-time"></span></summary></details>`);
  await sleep(700);
  const tab = document.createElement('div');
  tab.className = 'tab enter';
  tab.dataset.tab = 'b';
  tab.innerHTML = '<span class="busy"></span>热岛观测报告';
  $('#tabs').append(tab);
  tab.onclick = () => showTab('b');
  note(tab, '助手在后台标签页查，你这一页一直在前面', 32);
  await sleep(1800);
  tab.querySelector('.busy')?.remove();
  run.className = 'run-steps done';
  $('.run-title', run).innerHTML = '<span class="act-verb">后台打开了</span> <span class="act-object">热岛观测报告</span>';
  $('.run-chain', run).textContent = '读取页面结构 → 后台打开标签页 → 读取页面结构';
  $('.run-time', run).textContent = '3 秒';
  const ans = panelAdd('<div class="msg assistant markdown answer-latest"><p></p></div>');
  const p = $('p', ans);
  const link = (t) => t.replace('[热岛观测报告](#b)', '<a href="#b" data-src="b" title="点开回原页核对"><span class="answer-source-glyph source-fav"></span>热岛观测报告</a>');
  stream((h) => { p.innerHTML = h; messagesEl().parentElement.scrollTop = 1e6; }, EVIDENCE, { speed: 28, render: link, onDone: () => {
    p.querySelector('[data-src="b"]').onclick = (e) => { e.preventDefault(); showTab('b'); };
    ans.insertAdjacentHTML('beforeend', `<div class="answer-actions"><button type="button" aria-label="复制回答">${ICON.copy}</button><button type="button" class="answer-sources-btn" aria-expanded="true"><span class="answer-source-glyph"></span><span class="answer-source-glyph"></span>来源</button><span class="answer-time">3 秒</span></div>
      <div class="answer-panel"><section data-section="sources"><h3>读过的网页</h3><div class="answer-panel-body"><ol class="answer-sources">
      <li><button type="button" class="answer-source" data-src="a"><span class="answer-source-index">1</span><span class="answer-source-glyph"></span><span class="answer-source-label">城市为什么更热（原文这一段）</span><span class="answer-source-host">article-a.test</span></button></li>
      <li><button type="button" class="answer-source" data-src="b"><span class="answer-source-index">2</span><span class="answer-source-glyph"></span><span class="answer-source-label">热岛观测报告</span><span class="answer-source-host">report.test</span></button></li></ol></div></section></div>`);
    for (const b of ans.querySelectorAll('.answer-source')) b.onclick = () => (b.dataset.src === 'a' ? backToPara() : showTab('b'));
    messagesEl().parentElement.scrollTop = 1e6;
    setStep(state.prefSaved ? 5 : 4, '来源里同时有原文和证据页。点「热岛观测报告」核对证据；点引用条或来源 1 回到原文这一段。');
  } });
}

function showTab(which) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === which);
  $('#tab-a').style.display = which === 'a' ? 'block' : 'none';
  $('#tab-b').style.display = which === 'b' ? 'block' : 'none';
  // 换到证据页时把卡片藏起来；回到原文时只恢复原本开着的卡片。
  if (which === 'b') { surface.dataset.wasOpen = surface.hidden ? '' : '1'; surface.hidden = true; }
  else if (surface.dataset.wasOpen === '1') { surface.hidden = false; surface.dataset.wasOpen = ''; }
  if (which === 'b') { const l = $('#evidence-line'); l.style.background = '#fdf1c7'; setTimeout(() => (l.style.background = ''), 1600); }
  placeCard();
}

function backToPara() {
  showTab('a');
  para.scrollIntoView({ block: 'center', behavior: 'smooth' });
  para.classList.add('flash');
  setTimeout(() => para.classList.remove('flash'), 1200);
}

function newConversation() {
  surface.dataset.wasOpen = '';
  state.round += 1;
  state.streaming?.stop();
  state.streaming = null;
  surface.hidden = true;
  para.classList.remove('hl');
  for (const n of [...messagesEl().children]) if (n.id !== 'resume-entry-root') n.remove();
  for (const t of [...document.querySelectorAll('.tab')]) if (t.dataset.tab === 'b') t.remove();
  showTab('a');
  setStep(5, '新会话。点第二段 → 解释。');
}

para.onclick = () => { if (surface.hidden || surface.classList.contains('expanded') === false) showBar(); };

function restart(full) {
  state.streaming?.stop();
  Object.assign(state, { step: 1, card: 'hidden', streaming: null, round: 1, verified: false, asked: false });
  if (full) Object.assign(state, { prefSaved: false, prefForgotten: false });
  surface.hidden = true;
  surface.dataset.wasOpen = '';
  para.classList.remove('hl');
  if (panelDoc) for (const n of [...messagesEl().children]) if (n.id !== 'resume-entry-root') n.remove();
  for (const t of [...document.querySelectorAll('.tab')]) if (t.dataset.tab === 'b') t.remove();
  showTab('a');
  setStep(1, state.today ? '对照模式：这是现在产品的行为。点文章第二段，再点「解释」。' : '点文章第二段（浅色那段），再点卡片上的「解释」。');
}
restart(true);
