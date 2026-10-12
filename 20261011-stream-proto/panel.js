// 一块侧栏的时间线：上一轮对话 → 发问 → 思考行（秒数、换字）→ 回答流出 → 复制按钮。
(function () {
  const q = new URLSearchParams(location.search);
  const V = q.get("v") === "new" ? "new" : "cur";
  const root = document.documentElement;
  root.dataset.variant = V;
  if (q.get("serif") === "1") root.dataset.serif = "1";
  const S = window.BYS_STREAM;
  const messages = document.getElementById("messages");
  const frame = messages.parentElement;
  const render = (t) => DOMPurify.sanitize(marked.parse(t, { async: false }));

  const COPY = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const CHEV = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  const PREV_Q = "Studio Ghibli 是哪家公司？";
  const PREV_A = "吉卜力工作室（Studio Ghibli）是日本的动画工作室，1985 年由宫崎骏、高畑勋和铃木敏夫创立，代表作有《龙猫》《千与千寻》《幽灵公主》。\n\n它的作品以手绘质感、自然与成长主题著称，2023 年的《你想活出怎样的人生》拿下了奥斯卡最佳动画长片。";
  const NEW_Q = "用三段话介绍一下黑洞";

  // main.ts:2428 syncScrollFade + 2445 scrollToEnd（跟随到底）
  const syncScrollFade = () => { frame.dataset.fadeTop = String(messages.scrollTop > 0); frame.dataset.fadeBottom = String(messages.scrollHeight - messages.scrollTop - messages.clientHeight > 1); };
  messages.addEventListener("scroll", syncScrollFade);
  new ResizeObserver(syncScrollFade).observe(messages);
  new MutationObserver(syncScrollFade).observe(messages, { childList: true, subtree: true, characterData: true });
  const scrollToEnd = () => { messages.scrollTop = messages.scrollHeight; };
  const spoken = (ms) => `${Math.max(1, Math.round(ms / 1000))} 秒`; // steps.ts:321 spokenDuration

  function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }

  function attachActions(answer, time, animate) { // answer-actions.ts:13 的结构：复制 · 来源（隐藏）· 耗时
    const a = el("div", "answer-actions" + (animate ? " enter" : ""));
    const copy = el("button", "", COPY); copy.type = "button"; copy.setAttribute("aria-label", "复制回答");
    const t = el("span", "answer-time"); t.textContent = time;
    a.append(copy, t); answer.append(a);
    document.querySelectorAll(".answer-latest").forEach((n) => n.classList.remove("answer-latest"));
    answer.classList.add("answer-latest");
  }

  let timers = [], counter = 0, t0 = 0;
  const at = (ms, f) => timers.push(setTimeout(f, ms));
  const post = (m) => parent !== window && parent.postMessage({ ...m, v: V }, "*");

  function setTitle(title, text, animate) {
    const old = title.querySelector(".ttl");
    const next = el("span", "ttl"); next.innerHTML = `<span class="act-verb">${text}</span>`;
    if (!animate || !old) { title.replaceChildren(next); return; } // 现在：paintAction 直接 replaceChildren（main.ts:2271）
    const w0 = title.getBoundingClientRect().width;
    old.className = "ttl ttl-out"; next.className = "ttl ttl-in"; title.append(next);
    const w1 = next.getBoundingClientRect().width;
    title.style.width = w0 + "px"; title.getBoundingClientRect();
    title.style.transition = "width 180ms var(--e-swift)"; title.style.width = w1 + "px";
    setTimeout(() => { old.remove(); title.style.width = ""; title.style.transition = ""; }, 190);
  }

  function play() {
    timers.forEach(clearTimeout); timers = []; clearInterval(counter);
    t0 = performance.now(); window.__paints = 0;
    messages.innerHTML = "";
    const u0 = el("div", "msg user"); u0.textContent = PREV_Q; messages.append(u0);
    const a0 = el("div", "msg assistant markdown", render(PREV_A)); messages.append(a0); attachActions(a0, "6 秒", false);
    messages.querySelectorAll(".msg").forEach((n) => (n.style.animation = "none"));
    scrollToEnd();

    let run, title, time, thinkAt;
    at(S.T.user, () => { const u = el("div", "msg user"); u.textContent = NEW_Q; messages.append(u); scrollToEnd(); });
    at(S.T.think, () => {
      thinkAt = performance.now();
      run = el("details", "run-steps"); const sum = el("summary");
      title = el("span", "run-title"); time = el("span", "run-time"); const chev = el("span", "run-chevron", CHEV);
      setTitle(title, "正在思考", false); time.textContent = spoken(0);
      sum.append(title, time, chev); run.append(sum); messages.append(run); scrollToEnd();
      counter = setInterval(() => { time.textContent = spoken(performance.now() - thinkAt); }, 1000); // main.ts:3179
    });
    at(S.T.swap, () => setTitle(title, "正在整理思路", V === "new"));

    const arr = S.arrivals; let answer, text = "", reveal, streamer;
    arr.forEach((a, i) => at(S.T.answer + a.t, () => {
      if (i === 0) {
        clearInterval(counter);
        setTitle(title, `想了 ${spoken(performance.now() - thinkAt)}`, V === "new");
        run.classList.add("done");
        if (V === "cur") {
          answer = el("div", "msg assistant markdown streaming"); messages.append(answer); scrollToEnd(); // main.ts:3762 addMsg
          reveal = new BYS_CURRENT.Reveal(answer, { render, onProgress: scrollToEnd, onRelease: (n) => post({ type: "rel", t: performance.now() - t0, n }) });
        } else {
          answer = el("div", "msg assistant markdown enter"); messages.append(answer); scrollToEnd();
          streamer = BYS_NEW.createStreamer(answer, { render, rng: S.rng(7), onProgress: scrollToEnd,
            onRelease: (n) => post({ type: "rel", t: performance.now() - t0, n }),
            onDone: () => { attachActions(answer, spoken(performance.now() - thinkAt), true); scrollToEnd(); post({ type: "done", t: performance.now() - t0, stats: streamer.stats }); } });
          window.__streamer = streamer;
        }
      }
      post({ type: "arr", t: performance.now() - t0, n: a.text.length });
      if (V === "cur") {
        text += a.text;
        const last = i === arr.length - 1;
        reveal.update(text, last, last ? () => { attachActions(answer, spoken(performance.now() - thinkAt), false); scrollToEnd(); post({ type: "done", t: performance.now() - t0, stats: { paints: window.__paints } }); } : undefined);
        if (last) answer.classList.remove("streaming"); // main.ts:3591 closeBlocks：流一结束就去掉光标
      } else {
        streamer.push(a.text);
        if (i === arr.length - 1) streamer.finish();
      }
    }));
    at(S.T.end, () => { window.__recDone = true; post({ type: "end" }); });
  }

  window.__play = play;
  window.addEventListener("message", (e) => {
    if (e.data?.type === "play") play();
    if (e.data?.type === "serif") { if (e.data.on) root.dataset.serif = "1"; else delete root.dataset.serif; }
  });
  if (parent === window && !q.has("wait")) play();
})();
