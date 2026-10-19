/**
 * 回答的平滑显示：模型输出一阵一阵到，这里先缓冲，再按固定节拍一段段放出来。
 *
 * - 节拍：每 150～200ms 放一段，一段 14～24 字；积压多时把段放大，约 1.5 秒内追平。
 * - 淡入：每段 400ms 只改透明度，淡完拆掉 span。渲染结果只是在最后一个字后面多出续写时直接追加，否则只重渲染最后一块。
 * - 未闭合的 Markdown 先补齐，不让 `**`、`` ` ``、半截链接露出来。
 * - 有卡片的回答不分块：卡片前后的正文要用卡片里的数（{=名字}、「见下方卡片」），所以每段都按整个前缀渲染，
 *   走 patchAnswer 放进页面：已显示的卡片组件节点不动，卡片里的字不按段淡入，组件写完整块淡入。
 * - 卡片标记不走节拍，到多少放多少：组件自己管空位和淡入；按节拍切在组件中间，写得快的组件也会闪出占位条。
 */

import { Lexer } from "marked";
import { cardSpans, splitAnswer } from "../../../shared/answer-cards.js";
import { D_READ } from "../shared/motion-tokens.js";
import { keepOpenedImages } from "../shared/answer-html.js";
import { dropPlaceholders, patchAnswer } from "./answer-cards.js";

const BEAT_MIN = 150;
const BEAT_MAX = 200;
const CHUNK_MIN = 14;
const CHUNK_MAX = 24;
const CATCH_UP_MS = 1500;
const STARVE_MIN = 6;
const STARVE_WAIT = 350;
export const FADE_MS = D_READ;
const FADE_SLACK_MS = 100;

const PUNCT = /[，。；：、！？,.;:!?）」”]/;
const AVG_BEAT = (BEAT_MIN + BEAT_MAX) / 2;

type Fade = { from: number; to: number; at: number };

/** html 是这一块上次的渲染结果，用来判断续写能不能直接追加；parsed 是它解析出来、没放进页面的那份，没有时再解析。 */
type Block = { md: string; html: string; parsed: ChildNode[] | null; nodes: ChildNode[]; len: number; fades: Fade[] };

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
  // 没写完的图片先不显示：补上 `)` 会给半截地址出一个能点开的图片占位，点开的是错的那张。
  const image = /!\[[^\]\n]*(?:\]\([^)\n]*)?$/.exec(md);

  if (image) return md.slice(0, image.index);
  if (/\[[^\]]*\]\([^)\n]*$/.test(md)) return `${md})`;
  if (/\[[^\]]*$/.test(md)) return `${md}]`;

  return md;
}

function remend(md: string): string {
  const fenced = remendFence(md);

  return fenceOpen(md) ? fenced : remendLink(remendCode(remendBold(fenced)));
}

/** 从 at 起是卡片或小程序（at 在没写完的里面，或后面只隔空白就是开头）时，返回它的结尾或已到文字的结尾；否则返回 at。 */
function cardEnd(text: string, at: number): number {
  for (const { start, end } of cardSpans(text)) {
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

  for (const { end, closed } of cardSpans(md)) {
    if (!closed) return md;
    cut = end;
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

/** 最后一个有字的文本节点。marked 在 </li>、</tbody>、</blockquote> 前留的换行不算，续写要接在条目里面。 */
function lastText(nodes: ChildNode[]): Text | null {
  const texts = collectTexts(nodes);

  for (let i = texts.length - 1; i >= 0; i -= 1) if (texts[i]!.data.trim()) return texts[i]!;

  return null;
}

/** 续写接在最后一个字后面：代码块的字后面还跟着渲染出来的换行，接在换行前。 */
function insertAt(last: Text): Text {
  const end = last.data.trimEnd().length;

  if (end < last.data.length) last.splitText(end);

  return last;
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
  const unwrap = () => {
    window.clearTimeout(timer);
    span.removeEventListener("animationend", onEnd);
    const parent = span.parentNode;

    if (!parent) return;
    span.replaceWith(...span.childNodes);
    parent.normalize();
  };
  const onEnd = (event: AnimationEvent) => {
    if (event.target === span) unwrap();
  };
  // 不显示的元素里（<span hidden>、收起的 <details>）动画不跑，等不到 animationend；淡入时长过了就自己拆，
  // 否则收尾一直等 .chunk-fade 消失，回答永远停在「正在显示」。
  const timer = window.setTimeout(unwrap, Math.max(FADE_MS - delay, 0) + FADE_SLACK_MS);
  span.addEventListener("animationend", onEnd);

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

function topNodes(html: string, answer: HTMLElement): ChildNode[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  keepOpenedImages(template.content, answer);

  return [...template.content.childNodes].filter((node) => !(node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()));
}

function serialize(nodes: ChildNode[]): string {
  return nodes.map((node) => (node instanceof Element ? node.outerHTML : node.textContent ?? "")).join("");
}

function anchorBefore(el: HTMLElement): ChildNode | null {
  return el.querySelector(":scope > .answer-actions, :scope > .answer-panel, :scope > .send-declined-card");
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
      if (node instanceof HTMLElement && node.matches(".answer-actions, .answer-panel, .send-declined-card, .memory-used-line, .memory-used-cite-row")) continue;
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

    for (const [i, part] of splitBlocks(md).entries()) {
      const html = this.opts.render(part);
      this.paintBlock(i, part, html, topNodes(html, this.el), now);
    }
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

    if (this.shown < this.target.length || !this.final) {
      this.timer = window.setTimeout(() => this.beat(), BEAT_MIN + this.rng() * (BEAT_MAX - BEAT_MIN));

      return;
    }

    if (this.el.querySelector(".chunk-fade")) {
      this.timer = window.setTimeout(() => this.beat(), FADE_MS);

      return;
    }

    delete this.el.dataset.revealing;
    // 收尾会拆分正文节点；必须等淡入拆掉 span，避免复制节点时丢失 animationend 监听。
    this.finishIfDone();
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
      const html = this.opts.render(live ? remend(md) : md);
      const nodes = topNodes(html, this.el);
      const added = old && md.startsWith(old.md) ? md.slice(old.md.length) : null;
      const at = old && added && old.nodes.length ? this.appendOffset(old, nodes, added) : null;

      if (!(old && added && at !== null && this.appendFast(old, md, html, nodes, added, at, now))) this.paintBlock(i, md, html, nodes, now);
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

  /**
   * 续写不含记号也可能改掉已渲染的结构：补上的 `)` 让「[来源](https:」先成了链接，后半截网址其实在地址里；
   * 「[来源]」接上「(网址)」才成链接；裸网址接着写要改地址；「```j」接上「s」语言名才完整；段尾的空行不是正文。
   * 所以只在新渲染结果正好等于旧结果最后一个字后面接上 added 时才直接追加，返回接上的位置（按块里的字数）；否则返回 null。
   */
  private appendOffset(old: Block, nodes: ChildNode[], added: string): number | null {
    // 改的是旧块的那份解析：判完不管成不成，旧块的渲染结果都会换成新的。
    const before = old.parsed ?? topNodes(old.html, this.el);
    const last = lastText(before);

    if (!last) return null;
    insertAt(last).appendData(added);

    if (serialize(before) !== serialize(nodes)) return null;
    let at = 0;

    for (const text of collectTexts(before)) {
      if (text === last) return at + last.data.length - added.length;
      at += text.data.length;
    }

    return null;
  }

  private appendFast(block: Block, md: string, html: string, parsed: ChildNode[], added: string, at: number, now: number): boolean {
    const text = lastText(block.nodes);

    if (!text) return false;
    const last = insertAt(text);
    const span = fadeSpan(0);
    span.textContent = added;
    const parent = last.parentElement;
    const anchor = parent?.classList.contains("chunk-fade") && parent.lastChild === last ? parent : last;

    anchor.after(span);
    block.fades.push({ from: at, to: at + added.length, at: now });
    block.len += added.length;
    block.md = md;
    block.html = html;
    block.parsed = parsed;

    return true;
  }

  private paintBlock(i: number, md: string, html: string, nodes: ChildNode[], now: number): void {
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

    this.blocks[i] = { md, html, parsed: null, nodes, len, fades };
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
