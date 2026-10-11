// 左边「现在」：extension/src/sidepanel/stream-reveal.ts @ 6a8587b 逐行照搬（只去掉类型），不改任何数字。
(function () {
  const MIN_CPS = 45;
  const CATCH_UP_MS = 1200;
  const FRAME_MS = 32;
  const FADE_MS = 300;

  class Reveal {
    constructor(el, opts) { this.el = el; this.opts = opts; this.target = ""; this.shown = 0; this.final = false; this.after = null; this.timer = null; this.lastTick = 0; this.renderedLength = 0; this.batches = []; }
    update(text, final, after) {
      if (!text.startsWith(this.target.slice(0, this.shown))) {
        let common = 0;
        while (common < this.shown && text[common] === this.target[common]) common += 1;
        this.shown = common;
      }
      this.target = text; this.final = final;
      if (after) this.after = after;
      this.schedule();
    }
    flush() { this.shown = this.target.length; this.batches = []; this.stop(); this.el.innerHTML = this.opts.render(this.target); this.renderedLength = this.el.textContent?.length ?? 0; this.finishIfDone(); }
    schedule() { if (this.timer !== null) return; this.el.dataset.revealing = "true"; this.lastTick = performance.now(); this.timer = window.setTimeout(() => this.tick(), 0); }
    stop() { if (this.timer !== null) window.clearTimeout(this.timer); this.timer = null; delete this.el.dataset.revealing; }
    tick() {
      this.timer = null;
      const now = performance.now();
      const elapsed = Math.max(FRAME_MS, now - this.lastTick);
      this.lastTick = now;
      const backlog = this.target.length - this.shown;
      if (backlog > 0) {
        const cps = Math.max(MIN_CPS, (backlog * 1000) / CATCH_UP_MS);
        const before = this.shown;
        this.shown = Math.min(this.target.length, this.shown + Math.max(1, Math.round((cps * elapsed) / 1000)));
        this.paint(now);
        this.opts.onRelease?.(this.shown - before); // 原型埋点：画时间轴用
        this.opts.onProgress?.();
      } else if (this.batches.length) {
        this.paint(now);
      }
      if (this.shown < this.target.length || this.batches.length) { this.lastTick = now; this.timer = window.setTimeout(() => this.tick(), FRAME_MS); return; }
      delete this.el.dataset.revealing;
      this.finishIfDone();
    }
    finishIfDone() { if (!this.final || this.shown < this.target.length || !this.after) return; const after = this.after; this.after = null; after(); }
    paint(now) {
      this.el.innerHTML = this.opts.render(this.target.slice(0, this.shown));
      const length = this.el.textContent?.length ?? 0;
      if (length < this.renderedLength) this.batches = this.batches.filter((b) => b.from < length).map((b) => ({ ...b, to: Math.min(b.to, length) }));
      else if (length > this.renderedLength) this.batches.push({ from: this.renderedLength, to: length, at: now });
      this.renderedLength = length;
      this.batches = this.batches.filter((b) => now - b.at < FADE_MS);
      if (this.batches.length) wrapFading(this.el, this.batches, now, "reveal-fade");
      window.__paints = (window.__paints || 0) + 1;
    }
  }

  function wrapFading(root, batches, now, cls) {
    const start = batches[0].from;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    let offset = 0;
    for (const node of nodes) {
      const nodeStart = offset; const nodeEnd = offset + node.data.length; offset = nodeEnd;
      if (nodeEnd <= start) continue;
      const cuts = [];
      for (const b of batches) { const cut = { from: Math.max(b.from, nodeStart), to: Math.min(b.to, nodeEnd), at: b.at }; if (cut.to > cut.from) cuts.unshift(cut); }
      for (const cut of cuts) {
        const tail = node.splitText(cut.from - nodeStart);
        tail.splitText(cut.to - cut.from);
        const span = document.createElement("span");
        span.className = cls;
        span.style.animationDelay = `${-Math.round(now - cut.at)}ms`;
        tail.replaceWith(span); span.append(tail);
      }
    }
  }

  window.BYS_CURRENT = { Reveal, wrapFading };
})();
