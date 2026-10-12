// 右边「改后」：节拍器 + 按段淡入 + 淡完拆壳。设计成能原样搬进 stream-reveal.ts（见 README「工程方案」）。
(function () {
  const BEAT_MIN = 150, BEAT_MAX = 200;      // 实测：每 150～200ms 一段
  const CHUNK_MIN = 14, CHUNK_MAX = 24;      // 实测：每段 14～24 个汉字
  const CATCH_UP_MS = 1500;                  // 积压太多时把段放大，让积压在约 1.5 秒内放完
  const STARVE_MIN = 6, STARVE_WAIT = 350;   // 手里不足 6 字且流没结束：最多再等 350ms 凑一段
  const FADE_MS = 400;                       // 实测：每段 400ms 匀速淡入
  const PUNCT = /[，。；：、！？,.;:!?）」”]/;
  const MD_SYNTAX = /[*_`#\[\]<>|~\\\n!-]/;

  // 半截 Markdown（只做本原型用到的一条）：活动块里 ** 是单数，就在末尾补一个，不让星号露出来。
  // 思路同 vercel/streamdown packages/remend/src/emphasis-handlers.ts。
  const remend = (md) => ((md.match(/\*\*/g) || []).length % 2 ? md + "**" : md);

  function createStreamer(el, opts) {
    const rng = opts.rng || Math.random;
    let buffer = "", source = "", done = false, timer = null, lastRelease = -1e9, finished = false;
    const blocks = []; // { md, nodes, len, fades: [{from,to,at}] }
    const stats = { beats: 0, releases: 0, fast: 0, slow: 0, spans: 0 };

    function push(text) { buffer += text; if (timer === null) timer = setTimeout(beat, 0); }
    function finish() { done = true; if (timer === null) timer = setTimeout(beat, 0); }

    function beat() {
      timer = null; stats.beats++;
      const now = performance.now();
      if (buffer.length && !(buffer.length < STARVE_MIN && !done && now - lastRelease < STARVE_WAIT)) {
        release(take(), now); lastRelease = now;
      }
      if (buffer.length || !done) { timer = setTimeout(beat, BEAT_MIN + rng() * (BEAT_MAX - BEAT_MIN)); return; }
      if (!finished) { finished = true; opts.onDone?.(); }
    }

    function take() {
      let prefix = "";
      if (buffer.startsWith("\n\n")) { prefix = "\n\n"; buffer = buffer.slice(2); }
      let n = CHUNK_MIN + Math.floor(rng() * (CHUNK_MAX - CHUNK_MIN + 1));
      n = Math.max(n, Math.ceil(buffer.length / (CATCH_UP_MS / ((BEAT_MIN + BEAT_MAX) / 2))));
      if (n >= buffer.length) n = buffer.length;
      else {
        const br = buffer.indexOf("\n\n");
        if (br > 0 && br <= n + 6) n = br;                      // 段落结尾就停在段尾，下一拍从新段开始
        else for (let k = Math.min(n + 4, buffer.length); k >= Math.max(n - 6, 1); k--) { if (PUNCT.test(buffer[k - 1])) { n = k; break; } } // 尽量停在标点后
      }
      if (buffer[n - 1] === "*" && buffer[n] === "*") n += 1;   // 不把 ** 切成两半
      const chunk = prefix + buffer.slice(0, n);
      buffer = buffer.slice(n);
      return chunk;
    }

    function release(chunk, now) {
      source += chunk; stats.releases++;
      const parts = source.split("\n\n");
      parts.forEach((md, i) => {
        const live = i === parts.length - 1;
        const old = blocks[i];
        if (old && old.md === md) return;
        const added = old && md.startsWith(old.md) ? md.slice(old.md.length) : null;
        if (old && added && !MD_SYNTAX.test(added) && old.nodes.length) appendFast(old, added, now);
        else paintBlock(i, md, live, now);
      });
      opts.onRelease?.(chunk.replace(/\n/g, "").length);
      opts.onProgress?.();
    }

    // 快路径：新的一段不含 Markdown 记号，直接在最后一个文字节点后面接一个淡入 span；不重渲染。
    function appendFast(block, added, now) {
      stats.fast++;
      const last = lastText(block.nodes);
      const span = fadeSpan(added.length, 0);
      span.textContent = added;
      const anchor = last && last.parentNode.classList?.contains("chunk-fade") ? last.parentNode : last; // 不套进上一段还在淡的 span
      if (anchor) anchor.after(span); else block.nodes[block.nodes.length - 1].append(span);
      block.fades.push({ from: block.len, to: block.len + added.length, at: now });
      block.len += added.length; block.md += added;
    }

    // 慢路径：这一块的 Markdown 结构变了（** 闭合、新起一段…），只重渲染这一块；正在淡入的字用负 delay 接着淡。
    function paintBlock(i, md, live, now) {
      stats.slow++;
      const tpl = document.createElement("template");
      tpl.innerHTML = opts.render(live ? remend(md) : md);
      const nodes = [...tpl.content.childNodes].filter((n) => !(n.nodeType === 3 && !n.data.trim()));
      const len = nodes.reduce((s, n) => s + n.textContent.length, 0);
      const old = blocks[i];
      let fades = old ? old.fades.filter((f) => now - f.at < FADE_MS && f.from < len).map((f) => ({ ...f, to: Math.min(f.to, len) })) : [];
      const prevLen = old ? Math.min(old.len, len) : 0;
      if (len > prevLen) fades.push({ from: prevLen, to: len, at: now });
      const frag = document.createDocumentFragment(); nodes.forEach((n) => frag.append(n));
      if (old && old.nodes.length && old.nodes[0].parentNode === el) { el.insertBefore(frag, old.nodes[0]); old.nodes.forEach((n) => n.remove()); }
      else el.insertBefore(frag, el.querySelector(":scope > .answer-actions"));
      blocks[i] = { md, nodes, len, fades };
      wrapRanges(nodes, fades, now);
    }

    function fadeSpan(_len, delay) {
      const span = document.createElement("span");
      span.className = "chunk-fade";
      if (delay) span.style.animationDelay = `${-delay}ms`;
      span.addEventListener("animationend", function unwrap(e) { // 淡完拆壳：并回普通文字，长回答不留动画节点
        if (e.target !== span) return;
        span.removeEventListener("animationend", unwrap);
        const parent = span.parentNode; if (!parent) return;
        span.replaceWith(...span.childNodes); parent.normalize();
      });
      stats.spans++;
      return span;
    }

    function wrapRanges(nodes, fades, now) {
      if (!fades.length) return;
      const texts = [];
      for (const root of nodes) {
        if (root.nodeType === 3) { texts.push(root); continue; }
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) texts.push(t);
      }
      let offset = 0;
      for (const node of texts) {
        const s = offset, e = offset + node.data.length; offset = e;
        const cuts = [];
        for (const f of fades) { const c = { from: Math.max(f.from, s), to: Math.min(f.to, e), at: f.at }; if (c.to > c.from) cuts.unshift(c); }
        for (const c of cuts) {
          const tail = node.splitText(c.from - s); tail.splitText(c.to - c.from);
          const span = fadeSpan(c.to - c.from, Math.round(now - c.at));
          tail.replaceWith(span); span.append(tail);
        }
      }
    }

    function lastText(nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const root = nodes[i];
        if (root.nodeType === 3) return root;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let last = null;
        for (let t = w.nextNode(); t; t = w.nextNode()) last = t;
        if (last) return last;
      }
      return null;
    }

    return { push, finish, stats, get source() { return source; } };
  }

  window.BYS_NEW = { createStreamer, FADE_MS };
})();
