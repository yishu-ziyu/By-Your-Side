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
const FADE_MS = D_READ;
const FADE_SLACK_MS = 100;

const PUNCT = /[，。；：、！？,.;:!?）」”]/;
const AVG_BEAT = (BEAT_MIN + BEAT_MAX) / 2;

type Fade = { from: number; to: number; at: number };

type Block = { md: string; html: string; parsed: ChildNode[] | null; nodes: ChildNode[]; len: number; fades: Fade[] };

type Options = {
  render: (text: string) => string;
  onProgress?: () => void;
};

function points(text: string): string[] {
  return [...text];
}

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

function cardEnd(text: string, at: number): number {
  for (const { start, end } of cardSpans(text)) {
    if (end <= at) continue;

    return start < at || !text.slice(at, start).trim() ? end : at;
  }

  return at;
}

const needsWhole = (md: string) => md.includes("{=") || splitAnswer(md).some((part) => "card" in part);

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

function lastText(nodes: ChildNode[]): Text | null {
  const texts = collectTexts(nodes);

  for (let i = texts.length - 1; i >= 0; i -= 1) if (texts[i]!.data.trim()) return texts[i]!;

  return null;
}

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

  flush(): void {
    this.shown = this.target.length;
    this.blocks = [];
    this.whole = null;
    this.stop();
    patchAnswer(this.el, this.opts.render(this.target));
    this.finishIfDone();
  }

  private rewind(common: number): void {
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
    if (!this.whole) {
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

  private appendOffset(old: Block, nodes: ChildNode[], added: string): number | null {
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

export function revealText(el: HTMLElement, text: string, opts: Options & { live: boolean; final: boolean; after?: () => void }): void {
  let reveal = reveals.get(el);
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
