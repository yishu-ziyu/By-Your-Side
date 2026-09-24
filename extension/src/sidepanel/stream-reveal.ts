/**
 * 回答的平滑显示：模型输出一阵一阵到，这里先缓冲，再按稳定节奏放出来；新出现的字逐字淡入。
 *
 * - 节奏：每秒至少 MIN_CPS 个字；积压多时加速，让积压在 CATCH_UP_MS 内放完，不会越落越远。
 * - 淡入：每次渲染后，最近 FADE_MS 内新出现的字包进 span，用负的 animation-delay 接着上一帧的进度，
 *   整段 innerHTML 重渲染也不会让已经在淡入的字重新开始。已显示完的字不再包 span。
 * - Markdown 每次按已放出的前缀整体渲染：未闭合的块照 marked 的结果显示，放完后与一次性渲染一致。
 */

const MIN_CPS = 45;

const CATCH_UP_MS = 1200;

const FRAME_MS = 32;

export const FADE_MS = 500;

type Batch = { from: number; to: number; at: number };

type Options = {
  render: (text: string) => string;
  /** 每次放出新内容后调用（用于跟随滚动）。 */
  onProgress?: () => void;
};

class Reveal {
  private target = "";
  private shown = 0;
  private final = false;
  private after: (() => void) | null = null;
  private timer: number | null = null;
  private lastTick = 0;
  private renderedLength = 0;
  private batches: Batch[] = [];

  constructor(private el: HTMLElement, private opts: Options) {}

  update(text: string, final: boolean, after?: () => void): void {
    // 新文本不是旧文本的延续（改写、换稿）：从共同前缀接着放，不重放已经看过的部分。
    if (!text.startsWith(this.target.slice(0, this.shown))) {
      let common = 0;

      while (common < this.shown && text[common] === this.target[common]) common += 1;
      this.shown = common;
    }

    this.target = text;
    this.final = final;

    if (after) this.after = after;
    this.schedule();
  }

  /** 立即显示全部（历史、减弱动态、被新回合打断时）。 */
  flush(): void {
    this.shown = this.target.length;
    this.batches = [];
    this.stop();
    this.el.innerHTML = this.opts.render(this.target);
    this.renderedLength = this.el.textContent?.length ?? 0;
    this.finishIfDone();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    // 还在放字时标出来：验收脚本据此等回答放完再读，不读到半截。
    this.el.dataset.revealing = "true";
    this.lastTick = performance.now();
    this.timer = window.setTimeout(() => this.tick(), 0);
  }

  private stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    delete this.el.dataset.revealing;
  }

  private tick(): void {
    this.timer = null;
    const now = performance.now();
    const elapsed = Math.max(FRAME_MS, now - this.lastTick);
    this.lastTick = now;
    const backlog = this.target.length - this.shown;

    if (backlog > 0) {
      const cps = Math.max(MIN_CPS, (backlog * 1000) / CATCH_UP_MS);
      this.shown = Math.min(this.target.length, this.shown + Math.max(1, Math.round((cps * elapsed) / 1000)));
      this.paint(now);
      this.opts.onProgress?.();
    } else if (this.batches.length) {
      // 已经放完：继续刷新几帧，让最后一批淡入走完后去掉 span。
      this.paint(now);
    }

    if (this.shown < this.target.length || this.batches.length) {
      this.lastTick = now;
      this.timer = window.setTimeout(() => this.tick(), FRAME_MS);

      return;
    }

    delete this.el.dataset.revealing;
    this.finishIfDone();
  }

  private finishIfDone(): void {
    if (!this.final || this.shown < this.target.length || !this.after) return;
    const after = this.after;
    this.after = null;
    after();
  }

  private paint(now: number): void {
    this.el.innerHTML = this.opts.render(this.target.slice(0, this.shown));
    const length = this.el.textContent?.length ?? 0;

    // Markdown 语法闭合时渲染出的字可能变少：丢掉越界的批次，不回退已显示的内容。
    if (length < this.renderedLength) this.batches = this.batches.filter((b) => b.from < length).map((b) => ({ ...b, to: Math.min(b.to, length) }));
    else if (length > this.renderedLength) this.batches.push({ from: this.renderedLength, to: length, at: now });
    this.renderedLength = length;
    this.batches = this.batches.filter((b) => now - b.at < FADE_MS);

    if (this.batches.length) wrapFading(this.el, this.batches, now);
  }
}

/** 把最近放出的字包进淡入 span；按渲染后文本的字符位置定位，跨越多个文本节点也成立。 */
function wrapFading(root: HTMLElement, batches: Batch[], now: number): void {
  const start = batches[0]!.from;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // SAFETY: 遍历器只接受 SHOW_TEXT，返回的节点都是 Text。
    nodes.push(node as Text);
  }

  let offset = 0;

  for (const node of nodes) {
    const nodeStart = offset;
    const nodeEnd = offset + node.data.length;
    offset = nodeEnd;

    if (nodeEnd <= start) continue;

    // 从后往前切，前面的位置不受影响。
    const cuts: Batch[] = [];

    for (const b of batches) {
      const cut = { from: Math.max(b.from, nodeStart), to: Math.min(b.to, nodeEnd), at: b.at };

      if (cut.to > cut.from) cuts.unshift(cut);
    }

    for (const cut of cuts) {
      const tail = node.splitText(cut.from - nodeStart);
      tail.splitText(cut.to - cut.from);
      const span = document.createElement("span");
      span.className = "reveal-fade";
      span.style.animationDelay = `${-Math.round(now - cut.at)}ms`;
      tail.replaceWith(span);
      span.append(tail);
    }
  }
}

const reveals = new WeakMap<HTMLElement, Reveal>();

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * 把一段回答（累计全文）显示到 el。live=false（历史回放）或减弱动态时直接整段显示。
 * final=true 表示这是最终稿；after 在最终稿全部放完后调用一次（挂复制按钮等要放在正文之后的东西）。
 */
export function revealText(el: HTMLElement, text: string, opts: Options & { live: boolean; final: boolean; after?: () => void }): void {
  let reveal = reveals.get(el);

  if (!opts.live || reducedMotion()) {
    if (reveal) {
      reveal.update(text, opts.final, opts.after);
      reveal.flush();

      return;
    }

    el.innerHTML = opts.render(text);
    opts.after?.();

    return;
  }

  if (!reveal) {
    reveal = new Reveal(el, opts);
    reveals.set(el, reveal);
  }

  reveal.update(text, opts.final, opts.after);
}
