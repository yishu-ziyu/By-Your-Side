/**
 * 回答的平滑显示：模型输出一阵一阵到，这里先缓冲，再按固定节拍一段段放出来。
 *
 * - 节拍：每 150～200ms 放一段，一段 14～24 字；积压多时把段放大，约 1.5 秒内追平。
 * - 淡入：每段 400ms 只改透明度，淡完拆掉 span。不含记号的续写直接追加，否则只重渲染最后一块。
 * - 未闭合的 Markdown 先补齐，不让 `**`、`` ` ``、半截链接露出来。
 * - 有卡片的回答不分块：卡片前后的正文要用卡片里的数（{=名字}、「见下方卡片」），所以每段都按整个前缀渲染，
 *   走 patchAnswer 放进页面：已显示的卡片组件节点不动，卡片里的字不按段淡入，组件写完整块淡入。
 * - 卡片标记不走节拍，到多少放多少：组件自己管空位和淡入；按节拍切在组件中间，写得快的组件也会闪出占位条。
 */

import { Lexer } from "marked";
import { codeRanges, splitAnswer } from "../../../shared/answer-cards.js";
import { D_READ } from "../shared/motion-tokens.js";
import { dropPlaceholders, patchAnswer } from "./answer-cards.js";

const BEAT_MIN = 150;
const BEAT_MAX = 200;
const CHUNK_MIN = 14;
const CHUNK_MAX = 24;
const CATCH_UP_MS = 1500;
const STARVE_MIN = 6;
const STARVE_WAIT = 350;
export const FADE_MS = D_READ;

const PUNCT = /[，。；：、！？,.;:!?）」”]/;
const MD_SYNTAX = /[*_`#\[\]<>|~\\!-]/;
const AVG_BEAT = (BEAT_MIN + BEAT_MAX) / 2;

type Fade = { from: number; to: number; at: number };

type Block = { md: string; nodes: ChildNode[]; len: number; fades: Fade[] };

type Options = {
  render: (text: string) => string;
  /** 每次放出新内容后调用（用于跟随滚动）。 */
  onProgress?: () => void;
};

function points(text: string): string[] {
  return [...text];
}

/** 未闭合的围栏、粗体、行内代码、链接先补上，渲染时不露记号。思路同 streamdown remend。 */
function remendFence(md: string): string {
  let open = false;

  for (const line of md.split("\n")) {
    if (/^ {0,3}```/.test(line)) open = !open;
  }

  return open ? `${md}\n\`\`\`` : md;
}

function fenceOpen(md: string): boolean {
  let open = false;

  for (const line of md.split("\n")) {
    if (/^ {0,3}```/.test(line)) open = !open;
  }

  return open;
}

function remendBold(md: string): string {
  const visible = md.replace(/`[^`\n]*`/g, "");

  return (visible.match(/\*\*/g) ?? []).length % 2 ? `${md}**` : md;
}

function remendCode(md: string): string {
  const visible = md.replace(/```[\s\S]*?(```|$)/g, "");

  return (visible.match(/`/g) ?? []).length % 2 ? `${md}\`` : md;
}

function remendLink(md: string): string {
  if (/\[[^\]]*\]\([^)\n]*$/.test(md)) return `${md})`;
  if (/\[[^\]]*$/.test(md)) return `${md}]`;

  return md;
}

function remend(md: string): string {
  const fenced = remendFence(md);

  return fenceOpen(md) ? fenced : remendLink(remendCode(remendBold(fenced)));
}

/** 原文里真正的卡片开头（代码里讲卡片写法的 <card 不算，同 splitAnswer）。 */
function cardStarts(text: string): number[] {
  const code = codeRanges(text);

  return [...text.matchAll(/<card[\s>]/g)].map((m) => m.index).filter((i) => !code.some(([a, b]) => i >= a && i < b));
}

/** 从 at 起是卡片（at 在没写完的卡片里，或后面只隔空白就是卡片开头）时，返回卡片结尾或已到文字的结尾；否则返回 at。 */
function cardEnd(text: string, at: number): number {
  for (const start of cardStarts(text)) {
    const close = text.indexOf("</card>", start);
    const end = close < 0 ? text.length : close + "</card>".length;

    if (end <= at) continue;

    return start < at || !text.slice(at, start).trim() ? end : at;
  }

  return at;
}

/** 有卡片或引用卡片里的数（{=名字}）时整段渲染：这类正文要看完整前缀才知道显示什么。 */
const needsWhole = (md: string) => md.includes("{=") || splitAnswer(md).some((part) => "card" in part);

/** 只补最后一张卡片之后的正文；停在没写完的卡片里时不补，补上的记号会混进卡片属性。 */
function remendAfterCards(md: string): string {
  if ("card" in (splitAnswer(md).at(-1) ?? { card: undefined })) return md;
  let cut = 0;

  for (const start of cardStarts(md)) {
    if (start < cut) continue;
    const close = md.indexOf("</card>", start);

    if (close < 0) return md;
    cut = close + "</card>".length;
  }

  return md.slice(0, cut) + remend(md.slice(cut));
}

function splitBlocks(md: string): string[] {
  if (!md) return [];
  const parts: string[] = [];

  for (const token of Lexer.lex(md, { gfm: true, breaks: true })) {
    if (token.type === "space") {
      if (parts.length) parts[parts.length - 1] += token.raw;
      else parts.push(token.raw);
    } else {
      parts.push(token.raw);
    }
  }

  return parts.length ? parts : [md];
}

function take(buffer: string, done: boolean, rng: () => number): { chunk: string; rest: string } {
  let prefix = "";

  if (buffer.startsWith("\n\n")) {
    prefix = "\n\n";
    buffer = buffer.slice(2);
  }

  const chars = points(buffer);

  if (done || chars.length === 0) return { chunk: prefix + buffer, rest: "" };

  let n = CHUNK_MIN + Math.floor(rng() * (CHUNK_MAX - CHUNK_MIN + 1));
  n = Math.max(n, Math.ceil(chars.length / (CATCH_UP_MS / AVG_BEAT)));

  if (n >= chars.length) n = chars.length;
  else {
    const br = buffer.indexOf("\n\n");

    if (br > 0 && points(buffer.slice(0, br)).length <= n + 6) n = points(buffer.slice(0, br)).length;
    else {
      const lo = Math.max(n - 6, 1);
      const hi = Math.min(n + 4, chars.length);

      for (let k = hi; k >= lo; k -= 1) {
        const prev = chars[k - 1]!;
        const next = chars[k] ?? "";

        if (PUNCT.test(prev) || (prev === " " && /[A-Za-z]/.test(next))) {
          n = k;
          break;
        }
      }
    }
  }

  if (chars[n - 1] === "*" && chars[n] === "*") n += 1;

  return { chunk: prefix + chars.slice(0, n).join(""), rest: chars.slice(n).join("") };
}

function lastText(nodes: ChildNode[]): Text | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const root = nodes[i]!;

    if (root.nodeType === Node.TEXT_NODE) return root as Text;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
    if (last) return last;
  }

  return null;
}

function collectTexts(nodes: ChildNode[]): Text[] {
  const texts: Text[] = [];

  for (const root of nodes) {
    if (root.nodeType === Node.TEXT_NODE) {
      texts.push(root as Text);
      continue;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  }

  return texts;
}

function fadeSpan(delay: number): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "chunk-fade";
  if (delay) span.style.animationDelay = `${-delay}ms`;
  span.addEventListener("animationend", function unwrap(event) {
    if (event.target !== span) return;
    span.removeEventListener("animationend", unwrap);
    const parent = span.parentNode;

    if (!parent) return;
    span.replaceWith(...span.childNodes);
    parent.normalize();
  });

  return span;
}

function wrapRanges(nodes: ChildNode[], fades: Fade[], now: number): void {
  if (!fades.length) return;
  const texts = collectTexts(nodes);
  let offset = 0;

  for (const node of texts) {
    const start = offset;
    const end = offset + node.data.length;
    offset = end;
    if (node.parentElement?.closest(".gen-card")) continue;
    const cuts: Fade[] = [];

    for (const fade of fades) {
      const cut = { from: Math.max(fade.from, start), to: Math.min(fade.to, end), at: fade.at };

      if (cut.to > cut.from) cuts.unshift(cut);
    }

    for (const cut of cuts) {
      const tail = node.splitText(cut.from - start);
      tail.splitText(cut.to - cut.from);
      const span = fadeSpan(Math.round(now - cut.at));
      tail.replaceWith(span);
      span.append(tail);
    }
  }
}

function topNodes(html: string): ChildNode[] {
  const template = document.createElement("template");
  template.innerHTML = html;

  return [...template.content.childNodes].filter((node) => !(node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()));
}

function anchorBefore(el: HTMLElement): ChildNode | null {
  return el.querySelector(":scope > .answer-actions, :scope > .answer-panel");
}

class Reveal {
  private target = "";
  private shown = 0;
  private final = false;
  private after: (() => void) | null = null;
  private timer: number | null = null;
  private lastRelease = -1e9;
  private blocks: Block[] = [];
  /** 有卡片时整段渲染的淡入记录（按渲染后文本的位置）；null 表示还在按块放。 */
  private whole: Fade[] | null = null;
  private wholeLen = 0;
  private entered = false;
  private rng = Math.random;

  constructor(private el: HTMLElement, private opts: Options) {}

  update(text: string, final: boolean, after?: () => void): void {
    if (!text.startsWith(this.target.slice(0, this.shown))) {
      let common = 0;

      while (common < this.shown && text[common] === this.target[common]) common += 1;
      this.rewind(common);
    }

    this.target = text;
    this.final = final;
    if (after) this.after = after;
    this.schedule(final || cardEnd(text, this.shown) > this.shown);
  }

  /** 立即显示全部（历史、减弱动态、被新回合打断时）。 */
  flush(): void {
    this.shown = this.target.length;
    this.blocks = [];
    this.whole = null;
    this.stop();
    patchAnswer(this.el, this.opts.render(this.target));
    this.finishIfDone();
  }

  private rewind(common: number): void {
    // 整段渲染时交给 patchAnswer 对比：已显示的卡片（勾选、翻到的那面）留着，前缀里的字不重新淡入。
    if (this.whole && needsWhole(this.target.slice(0, common))) {
      this.shown = common;
      this.lastRelease = -1e9;
      this.paintWhole(this.target.slice(0, common), performance.now());

      return;
    }

    this.shown = common;
    this.blocks = [];
    this.whole = null;
    this.lastRelease = -1e9;

    for (const node of [...this.el.childNodes]) {
      if (node instanceof HTMLElement && (node.classList.contains("answer-actions") || node.classList.contains("answer-panel"))) continue;
      node.remove();
    }

    if (common) this.paintPrefix(this.target.slice(0, common));
  }

  private paintPrefix(md: string): void {
    const now = performance.now();

    if (needsWhole(md)) {
      this.paintWhole(md, now);

      return;
    }

    for (const [i, part] of splitBlocks(md).entries()) this.paintBlock(i, part, false, now);
  }

  private schedule(immediate = false): void {
    if (immediate && this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.timer !== null) return;
    this.el.dataset.revealing = "true";
    this.timer = window.setTimeout(() => this.beat(), immediate ? 0 : 0);
  }

  private stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    delete this.el.dataset.revealing;
  }

  private beat(): void {
    this.timer = null;
    const now = performance.now();
    const buffer = this.target.slice(this.shown);
    const card = cardEnd(this.target, this.shown) > this.shown;
    const starved = buffer.length > 0 && buffer.length < STARVE_MIN && !this.final && !card && now - this.lastRelease < STARVE_WAIT;

    if (buffer.length && !starved) {
      const { chunk } = card ? { chunk: "" } : take(buffer, this.final, this.rng);
      this.shown = cardEnd(this.target, this.shown + chunk.length);
      this.release(now);
      this.lastRelease = now;
      this.opts.onProgress?.();
    }

    if (this.shown >= this.target.length) this.finishIfDone();

    if (this.shown < this.target.length || !this.final) {
      this.timer = window.setTimeout(() => this.beat(), BEAT_MIN + this.rng() * (BEAT_MAX - BEAT_MIN));

      return;
    }

    if (this.el.querySelector(".chunk-fade")) {
      this.timer = window.setTimeout(() => this.beat(), FADE_MS);

      return;
    }

    delete this.el.dataset.revealing;
  }

  private finishIfDone(): void {
    if (!this.final || this.shown < this.target.length) return;
    dropPlaceholders(this.el);

    if (!this.after) return;
    const after = this.after;
    this.after = null;
    after();
  }

  private release(now: number): void {
    if (!this.entered) {
      this.el.classList.add("stream-enter");
      this.entered = true;
    }

    const source = this.target.slice(0, this.shown);

    if (this.whole || needsWhole(source)) {
      this.paintWhole(source, now);

      return;
    }

    const parts = splitBlocks(source);

    for (const [i, md] of parts.entries()) {
      const live = i === parts.length - 1;
      const old = this.blocks[i];

      if (old && old.md === md) continue;
      const added = old && md.startsWith(old.md) ? md.slice(old.md.length) : null;
      const codeTail = old?.md.startsWith("```") && added !== null && !/[*_`#\[\]<>|~\\!]/.test(added);

      if (old && added && old.nodes.length && (!MD_SYNTAX.test(added) || codeTail)) this.appendFast(old, added, now);
      else this.paintBlock(i, md, live, now);
    }

    while (this.blocks.length > parts.length) {
      const extra = this.blocks.pop()!;

      for (const node of extra.nodes) node.remove();
    }
  }

  private paintWhole(source: string, now: number): void {
    // 从按块切到整段：正在淡入的段换算成整段里的位置接着淡，不突然变实。
    if (!this.whole) {
      // 块之间的换行文本节点不算进 block.len，位置按页面里实际的字数算。
      const before = (node: ChildNode) => {
        let len = 0;

        for (let n = node.previousSibling; n; n = n.previousSibling) len += n.textContent?.length ?? 0;

        return len;
      };
      this.whole = [];

      for (const block of this.blocks) {
        const offset = block.nodes[0]?.parentNode === this.el ? before(block.nodes[0]) : 0;

        for (const fade of block.fades) this.whole.push({ from: fade.from + offset, to: fade.to + offset, at: fade.at });
      }

      this.wholeLen = this.el.textContent?.length ?? 0;
      this.blocks = [];
    }

    patchAnswer(this.el, this.opts.render(remendAfterCards(source)));
    const len = this.el.textContent?.length ?? 0;
    const fades = this.whole.filter((fade) => now - fade.at < FADE_MS && fade.from < len).map((fade) => ({ ...fade, to: Math.min(fade.to, len) }));

    if (len > this.wholeLen) fades.push({ from: this.wholeLen, to: len, at: now });
    this.whole = fades;
    this.wholeLen = len;
    wrapRanges([...this.el.childNodes], fades, now);
  }

  private appendFast(block: Block, added: string, now: number): void {
    const last = lastText(block.nodes);
    const span = fadeSpan(0);
    span.textContent = added;
    const parent = last?.parentElement;
    const anchor = parent?.classList.contains("chunk-fade") ? parent : last;

    if (anchor) anchor.after(span);
    else {
      const host = block.nodes[block.nodes.length - 1];
      if (host instanceof Element) host.append(span);
      else this.el.insertBefore(span, anchorBefore(this.el));
    }
    block.fades.push({ from: block.len, to: block.len + added.length, at: now });
    block.len += added.length;
    block.md += added;
  }

  private paintBlock(i: number, md: string, live: boolean, now: number): void {
    const nodes = topNodes(this.opts.render(live ? remend(md) : md));
    const len = nodes.reduce((sum, node) => sum + (node.textContent?.length ?? 0), 0);
    const old = this.blocks[i];
    let fades = old ? old.fades.filter((fade) => now - fade.at < FADE_MS && fade.from < len).map((fade) => ({ ...fade, to: Math.min(fade.to, len) })) : [];
    const prevLen = old ? Math.min(old.len, len) : 0;

    if (len > prevLen) fades.push({ from: prevLen, to: len, at: now });
    const frag = document.createDocumentFragment();

    for (const node of nodes) frag.append(node);
    if (old?.nodes[0]?.parentNode === this.el) {
      this.el.insertBefore(frag, old.nodes[0]);
      for (const node of old.nodes) node.remove();
    } else {
      this.el.insertBefore(frag, anchorBefore(this.el));
    }

    this.blocks[i] = { md, nodes, len, fades };
    wrapRanges(nodes, fades, now);
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
  // 原文留在元素上：「复制为 Markdown」要原样的标题、列表、链接和代码块，渲染后的 DOM 里已经没有了。
  el.dataset.markdown = text;

  if (!opts.live || reducedMotion()) {
    if (reveal) {
      reveal.update(text, opts.final, opts.after);
      reveal.flush();

      return;
    }

    patchAnswer(el, opts.render(text));

    if (opts.final || !opts.live) dropPlaceholders(el);
    opts.after?.();

    return;
  }

  if (!reveal) {
    reveal = new Reveal(el, opts);
    reveals.set(el, reveal);
  }

  reveal.update(text, opts.final, opts.after);
}
