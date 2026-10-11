(() => {
const q = new URLSearchParams(location.search);
const { Panel, speedAt, spoken } = window.Proto;
const h = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };

const INFO = {
  cur: { name: "现状", one: "复刻现在的产品：「正在思考 · 已做 6 件事」+ 竖线下最近 3 步，耗时照截图写 0.0s。",
    card: null, notes: ["结构取自 main.ts ensureRun / renderTrail，文案取自 steps.ts betweenStepsTitle、recentSteps。", "录像里不录这一版；对比图里放在第一行。"] },
  A: { name: "A · 一行「现在」+ 收起的记录", one: "最上面一行只说现在在做什么；下面一行小字「已做 N 件事 ›」，点开才看做过的事。",
    card: ["看着助手在网页上干活的人", "任务跑了一分钟，中间有 40 秒在想", "一眼知道它现在在干什么，卡没卡住", "现在的块把状态和进度挤在一行，「执行脚本 0.0s」看不懂，想的 40 秒看不见", "第一行只写「正在打开 Studio Ghibli 词条」，想的时候写「正在思考 18 秒」；第二行「已做 2 件事 ›」，做过的事默认收起，点开是人话记录，超过 3 秒才写秒数，最后一行写「共 1 分 2 秒，其中想了 49 秒」"],
    notes: ["和现在的「过程行 A」最接近：同一个 summary、同一道扫光、同一条细线，只是把进度挪到第二行。", "收尾仍是「做了 6 件事 ›」，总耗时和想了多久放进展开后的最后一行，不回到回执上。"] },
  B: { name: "B · 紧凑时间线，现在在最底下", one: "顶上一条细时间条（浅色段=在想，深色段=在动手）+ 总时长；下面最近两件淡出，最底下一行是现在。",
    card: ["看着助手在网页上干活的人", "任务跑了一分钟，中间有 40 秒在想", "看出时间花在哪：在想，还是在动手", "现在每步都写 0.0s、总共却 1 分 2 秒，想的时间没处放", "顶上一条按时长分段的细条，想的那段是浅色、有多长画多长；下面像日志一样往下长，最新一行在最底下、墨色扫光；收尾成「做了 6 件事 ▬ 1 分 2 秒 ›」"],
    notes: ["和 A、C 不同：进行中会多露两行做过的事（淡出），换来「最新的就在眼前」。", "收尾这行带总时长和小时间条，和 10-06「耗时挪到回答下面」的决定有冲突，选它要改那条。"] },
  AC: { name: "AC · 进行中像 A，收尾像 C", one: "进行中和 A 一样：一行「现在」+「已做 N 件事 ›」；做完收成 C 的一行回执「做了 6 件事：打开词条 → … → 圈出 11 部 ›」，点开是 A 的人话记录。",
    card: ["看着助手在网页上干活的人", "任务跑了一分钟，中间想了 40 秒，做了 6 件事", "跑的时候知道它在干什么；跑完扫一眼知道做了哪些事", "现在的块状态和进度挤一行、「执行脚本 0.0s」看不懂、想的时间看不见；收尾「做了 6 件事 ›」又什么都没说", "进行中第一行写现在（「正在思考 18 秒」），第二行小字「已做 2 件事 ›」；做完收成一行回执，用短名加箭头，放不下从中间省略，不写耗时；点开是人话记录，末行「共 1 分 2 秒，其中想了 49 秒」"],
    notes: ["进行中不加胶囊：第二行已经说了进度，再加一排胶囊就吵了（守 10-06）。", "回执里的短名要工具给（「打开词条」「读作品表」），原型里是写死的。", "出错那轮：回执末尾留「· 1 件换了办法」，短名链先让位。"] },
  C: { name: "C · 一串胶囊，收尾收成一行回执", one: "现在一行在上；做完的事变成一排小胶囊从右边推进来，想的那段是虚线胶囊；做完整排收成一句回执。",
    card: ["看着助手在网页上干活的人", "任务跑了一分钟，做了 6 件事", "不想读日志，扫一眼就知道做到哪了", "现在三行竖排小字和一条线，看着散", "做过的事缩成短胶囊（打开词条、读作品表 4 秒、想 40 秒），排一行、最新的在最右；收尾收成「做了 6 件事 打开词条 → … → 圈出 11 部 ›」"],
    notes: ["最占横向空间，380px 宽下只露最近 4–5 个；短名要另写（不能直接用工具名）。", "胶囊和 10-06 去掉的「彩色胶囊」形状接近，虽然这里只用描边和墨色。"] },
};

const STATES = {
  ok: [["运行中", 47.3], ["思考中", 30], ["一步做完", 50.6], ["写回答前", 60.4], ["完成·收起", 62.6], ["完成·展开", 62.6, true]],
  err: [["出错那一下", 48.0], ["换办法", 48.8], ["完成·展开", 65.5, true]],
};

async function settle(ms) { await new Promise((r) => setTimeout(r, ms)); }
/* 一路推到 t，让列表按先后长出来。 */
function seek(panel, t) { for (let x = 0; x < t; x += 0.25) panel.render(x); panel.render(t); }

if (q.has("grid")) return grid();
if (q.has("rec")) return rec();
page();

function page() {
  document.body.className = "page";
  let v = q.get("v") || "A"; let runKey = q.get("run") || "ok"; let mode = "fast";
  let t = 0, playing = false, last = 0, panel;
  const main = h("main");
  main.innerHTML = `<header><h1>过程块 · 三种改法</h1><p>同一轮真实任务（打开 Studio Ghibli 词条，列出宫崎骏的电影）。点侧栏里的那行可以展开、收起；下面能换改法、换情况、拖时间。</p></header>`;
  const bar1 = h("div", "bar"), bar2 = h("div", "bar"), bar3 = h("div", "bar");
  const stage = h("section", "stage"); const screen = h("div", "screen"); const copy = h("div", "copy");
  stage.append(screen, copy);
  main.append(bar1, bar2, bar3, stage, h("footer", null, "侧栏宽 380px，样式是从仓库原样复制的 product-styles.css（6a8587b）加原型专用的 proto.css。时钟按真实秒数走；播放时「动手」1.8 倍速，长思考快进 16 倍。"));
  document.body.append(main);
  const btn = (label, on, fn) => { const b = h("button", null, label); b.setAttribute("aria-pressed", String(on)); b.onclick = fn; return b; };
  const range = h("input"); range.type = "range"; range.min = "0"; range.step = "0.1";
  const clock = h("span", "clock");
  function drawBars() {
    bar1.replaceChildren(h("span", "lbl", "改法"), ...["cur", "A", "B", "C", "AC"].map((k) => btn(INFO[k].name.split(" · ")[0], v === k, () => { v = k; build(t); })),
      h("span", "lbl", "　情况"), ...Object.keys(window.RUNS).map((k) => btn(window.RUNS[k].name, runKey === k, () => { runKey = k; build(0); })));
    bar2.replaceChildren(btn(playing ? "暂停" : "播放", playing, () => { if (!playing && t >= panel.run.end + 0.5) seekTo(0); playing = !playing; last = performance.now(); drawBars(); if (playing) requestAnimationFrame(loop); }),
      btn("从头", false, () => { seekTo(0); playing = true; last = performance.now(); drawBars(); requestAnimationFrame(loop); }),
      btn(mode === "fast" ? "速度：压缩" : "速度：真实", mode === "fast", () => { mode = mode === "fast" ? "real" : "fast"; drawBars(); }),
      range, clock);
    bar3.replaceChildren(h("span", "lbl", "跳到"), ...STATES[runKey].map(([label, at, open]) => btn(label, false, () => { playing = false; drawBars(); seekTo(at); panel.setOpen(!!open); })));
  }
  function seekTo(x) { if (x < t) { t = 0; build(0, true); } seek(panel, x); t = x; sync(); }
  function sync() { range.value = String(t); clock.textContent = `已过 ${t < 1 ? "0 秒" : spoken(Math.min(t, panel.run.end))}`; }
  range.oninput = () => { playing = false; drawBars(); seekTo(Number(range.value)); };
  function build(at, keepBars) {
    screen.replaceChildren(); panel = new Panel(screen, v, runKey);
    range.max = String(panel.run.end + 1);
    t = 0; seek(panel, at); t = at; sync();
    const info = INFO[v];
    copy.innerHTML = "";
    copy.append(h("h2", null, info.name));
    if (info.card) { const c = h("div", "card"); ["用户", "场景", "需求", "问题", "方案"].forEach((k, i) => c.append(h("b", null, k), h("span", null, info.card[i]))); copy.append(c); }
    copy.append(h("p", null, info.one));
    const ul = h("ul"); info.notes.forEach((n) => ul.append(h("li", null, n))); copy.append(ul);
    copy.append(h("p", "hint", "看点：思考那 40 秒怎么显示；一步做完时的淡入；收尾时怎么收；点开后看到什么。「中途出错」里点「作品」没找到按钮，改成滚过去找。"));
    if (!keepBars) drawBars();
  }
  function loop(now) {
    if (!playing) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    t += dt * speedAt(panel.run, t, mode);
    if (t >= panel.run.end + 0.5) { t = panel.run.end + 0.5; playing = false; drawBars(); }
    panel.render(t); sync();
    if (playing) requestAnimationFrame(loop);
  }
  build(Number(q.get("t") || 0));
  if (q.get("open")) panel.setOpen(true);
}

function rec() {
  document.body.className = "rec";
  const v = q.get("v") || "A"; const runKey = q.get("run") || "ok";
  const cap = h("div", "rec-cap"); const ff = h("span", "ff", "思考快进 ×16");
  cap.append(h("b", null, INFO[v].name.split(" · ")[0]), h("span", null, INFO[v].name.split(" · ")[1] || ""), ff);
  document.body.append(cap);
  const host = h("div"); document.body.append(host);
  const panel = new Panel(host, v, runKey);
  panel.app.style.setProperty("--ph", `${innerHeight - 30}px`);
  panel.render(0);
  window.__recDone = false;
  window.__start = async () => {
    await settle(700);
    let t = 0, last = performance.now();
    await new Promise((res) => {
      const loop = (now) => {
        const dt = Math.min(0.1, (now - last) / 1000); last = now;
        const sp = speedAt(panel.run, t, "fast");
        ff.classList.toggle("on", sp > 2);
        t += dt * sp;
        if (t >= panel.run.end + 0.05) { panel.render(panel.run.end + 0.05); return res(); }
        panel.render(t); requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    ff.classList.remove("on");
    await settle(1300);
    panel.setOpen(true);
    await settle(2600);
    window.__recDone = true;
  };
}

async function grid() {
  document.body.className = "grid";
  const kind = q.get("grid");
  const W = 380, H = Number(q.get("h") || 470);
  const cell = (v, runKey, t, open) => { const c = h("div", "g-cell"); const p = new Panel(c, v, runKey); p.app.style.setProperty("--pw", `${W}px`); p.app.style.setProperty("--ph", `${H}px`); return { c, p, t, open }; };
  const jobs = [];
  if (kind === "stills") {
    const v = q.get("v") || "A";
    const cols = [["运行中", "ok", 47.3], ["思考中（第 24 秒）", "ok", 30], ["一步做完，下一步 3 秒了", "ok", 50.6], ["出错：没找到按钮，换办法", "err", 48.8], ["完成 · 收起", "ok", 62.6], ["完成 · 展开", "ok", 62.6, true]];
    if (v === "AC") cols.push(["出错那轮 · 完成收起", "err", 65.5]);
    document.body.append(h("div", "g-title", INFO[v].name), h("div", "g-sub", INFO[v].one));
    const tb = h("div", "g-table"); tb.style.gridTemplateColumns = `repeat(${cols.length}, ${W}px)`;
    cols.forEach(([l]) => tb.append(h("div", "g-head", l)));
    cols.forEach(([, r, t, o]) => { const j = cell(v, r, t, o); jobs.push(j); tb.append(j.c); });
    document.body.append(tb);
  } else {
    const cols = [["思考中（第 24 秒）", 30], ["开始写回答前（1 分整，接近截图那一刻）", 60.4], ["完成 · 收起", 62.6], ["完成 · 展开", 62.6, true]];
    const rowsV = (q.get("rows") || "cur,A,B,C").split(",");
    const title = rowsV.length === 2 ? `过程块：现状 vs ${INFO[rowsV[1]].name.split(" · ")[0]}（同一轮任务、同一时刻）` : "过程块：现状 vs 三种改法（同一轮任务、同一时刻）";
    if (q.get("run") === "err") cols.push(["中途出错 · 完成展开", 65.5, true, "err"]);
    document.body.append(h("div", "g-title", title), h("div", "g-sub", "任务：打开 Studio Ghibli 词条，列出宫崎骏导演的电影。现状一行按产品代码复刻，耗时照你的截图写 0.0s。"));
    const tb = h("div", "g-table"); tb.style.gridTemplateColumns = `28px repeat(${cols.length}, ${W}px)`;
    tb.append(h("div")); cols.forEach(([l]) => tb.append(h("div", "g-head", l)));
    for (const v of rowsV) {
      tb.append(h("div", "g-row-label", INFO[v].name.split(" · ")[0]));
      cols.forEach(([, t, o, r]) => { const j = cell(v, r || "ok", t, o); jobs.push(j); tb.append(j.c); });
    }
    const shot = h("div", "g-shot"); const img = h("img"); img.src = "stills/current-screenshot.png"; shot.append(h("div", "g-head", "你截的现状（参考）"), img);
    shot.style.width = `${W}px`; shot.style.marginBottom = "14px";
    document.body.append(shot, tb);
  }
  for (const j of jobs) { seek(j.p, j.t); if (j.open) j.p.setOpen(true); }
  await settle(1200);
  for (const j of jobs) { j.p.msgs.scrollTop = j.open ? j.p.block.el.offsetTop - 16 : j.p.msgs.scrollHeight; j.p.edges(); }
  await settle(300);
  window.__gridDone = true;
}
})();
