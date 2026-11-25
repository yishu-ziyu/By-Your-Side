import { cardSpans } from "../../../shared/answer-cards.js";
import { IncrementalBlockFreezer, type StreamBlock, type StreamBlockKind } from "../../../shared/block-freezer.js";
import { repairStreamingTail } from "../../../shared/streaming-tail.js";
import { keepOpenedImages } from "../shared/answer-html.js";
import { D_STREAM_FADE } from "../shared/motion-tokens.js";
import { dropPlaceholders, patchAnswer, patchCardNodes } from "./answer-cards.js";
import { getCodeHighlighter } from "./code-highlighter.js";

const REBUILD_LOAD = 0.15;
const MAX_CATCH_UP = 260;
const MIN_CPS = 32;
const MAX_CPS = 360;
const FADE_SLACK = 80;
const HIGHLIGHT_INTERVAL = 110;
const CARD_INTERVAL = 120;
const TABLE_INTERVAL = 65;

const PLAIN_PROSE_DELTA = /^[^\n*_`~[\]()<>|#\\!{}$]+$/;
const SYNTAX_BOUNDARY = /[\n*_`~[\]()<>|#\\!{}]/;

type Fade = { from: number; to: number; at: number };

type Options = {
  render: (text: string) => string;
  onProgress?: () => void;
};

interface MountedSlot {
  index: number;
  kind: StreamBlockKind;
  raw: string;
  repaired: string;
  frozen: boolean;
  hasRef: boolean;
  nodes: ChildNode[];
  visibleLen: number;
  fades: Fade[];
  lastCodeText?: string;
  lastHighlightHtml?: string;
  lastHighlightAt?: number;
  lastStructuralAt?: number;
  lastCardCloseTags?: number;
}

const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function isSelectionTouching(node: Node): boolean {
  const sel = globalThis.getSelection?.();

  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  try {
    return sel.containsNode(node, true);
  } catch {
    return node.contains(sel.getRangeAt(0).commonAncestorContainer);
  }
}

function snapCharBoundary(text: string, targetIdx: number): number {
  let idx = Math.min(text.length, Math.max(0, targetIdx));

  if (idx > 0 && idx < text.length) {
    const prev = text.charCodeAt(idx - 1);

    if (prev >= 0xd800 && prev <= 0xdbff) idx += 1;
  }
  if (idx > 0 && idx < text.length && text[idx - 1] === "*" && text[idx] === "*") idx += 1;

  return Math.min(text.length, idx);
}

function cardFastForward(text: string, at: number): number {
  for (const { start, end } of cardSpans(text)) {
    if (end <= at) continue;

    return start <= at || !text.slice(at, start).trim() ? end : at;
  }

  return at;
}

function parseCodeFence(raw: string): { lang: string; code: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n {0,3}\1[ \t]*)?$/.exec(raw.trimEnd());

  if (!match) return null;

  return { lang: (match[2] ?? "").trim().split(/\s+/)[0] ?? "", code: match[3] ?? "" };
}

function collectTexts(nodes: ChildNode[]): Text[] {
  const texts: Text[] = [];

  for (const root of nodes) {
    if (root.nodeType === Node.TEXT_NODE) { texts.push(root as Text); continue; }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  }

  return texts;
}

function lastVisibleText(nodes: ChildNode[]): Text | null {
  const texts = collectTexts(nodes);

  for (let i = texts.length - 1; i >= 0; i -= 1) if (texts[i]!.data.trim().length > 0) return texts[i]!;

  return null;
}

function unwrapSpanIfSafe(span: HTMLSpanElement): void {
  const parent = span.parentNode;

  if (!parent || isSelectionTouching(span)) return;
  span.replaceWith(...span.childNodes);
  parent.normalize();
}

function fadeSpan(delay: number): HTMLSpanElement {
  const span = document.createElement("span");

  span.className = "chunk-fade";
  if (delay) span.style.animationDelay = `${-delay}ms`;
  const finish = () => {
    window.clearTimeout(timer);
    span.removeEventListener("animationend", onEnd);
    unwrapSpanIfSafe(span);
  };
  const onEnd = (event: Event) => {
    if (event.target === span) finish();
  };
  const timer = window.setTimeout(finish, Math.max(D_STREAM_FADE - delay, 0) + FADE_SLACK);

  span.addEventListener("animationend", onEnd);

  return span;
}

function disjointFades(fades: Fade[]): Fade[] {
  if (fades.length < 2) return fades;
  const newestFirst = [...fades].sort((a, b) => b.at - a.at);
  const boundaries = [...new Set(fades.flatMap(({ from, to }) => [from, to]))].sort((a, b) => b - a);
  const ranges: Fade[] = [];

  for (let i = 1; i < boundaries.length; i += 1) {
    const from = boundaries[i]!;
    const to = boundaries[i - 1]!;
    const fade = newestFirst.find((range) => range.from <= from && to <= range.to);

    if (!fade) continue;
    const previous = ranges.at(-1);

    if (previous?.from === to && previous.at === fade.at) previous.from = from;
    else ranges.push({ from, to, at: fade.at });
  }

  return ranges;
}

function wrapRanges(nodes: ChildNode[], fades: Fade[], now: number): void {
  if (!fades.length) return;
  const ranges = disjointFades(fades);
  const texts = collectTexts(nodes);
  let offset = 0;

  for (const node of texts) {
    const start = offset;
    const end = offset + node.data.length;

    offset = end;
    if (node.parentElement?.closest(".gen-card, .code-block-head")) continue;
    for (const range of ranges) {
      if (range.to <= start) break;
      const from = Math.max(range.from, start);
      const to = Math.min(range.to, end);

      if (to <= from) continue;
      const tail = node.splitText(from - start);

      tail.splitText(to - from);
      const span = fadeSpan(Math.round(now - range.at));

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

function anchorBefore(el: HTMLElement): ChildNode | null {
  return el.querySelector(":scope > .answer-actions, :scope > .answer-panel, :scope > .send-declined-card");
}

function markFrozenNodes(nodes: ChildNode[]): void {
  for (const node of nodes) {
    if (node instanceof HTMLElement && node.dataset.frozen !== "true") node.dataset.frozen = "true";
  }
}

function findCodeElement(nodes: ChildNode[]): HTMLElement | null {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    const code = node.matches("pre > code") ? node : node.querySelector("pre > code");

    if (code instanceof HTMLElement) return code;
  }

  return null;
}

let blockKeyCounter = 0;

function highlightStaticCodeBlocks(root: HTMLElement): void {
  const highlighter = getCodeHighlighter();

  for (const codeEl of root.querySelectorAll<HTMLElement>("pre > code")) {
    if (codeEl.querySelector(".tok-kw, .tok-str, .tok-com, .tok-fn, .tok-type")) continue;
    const code = codeEl.textContent ?? "";

    if (!code.trim()) continue;
    const lang = /^language-(\S+)$/.exec(codeEl.className)?.[1] ?? "";
    const key = `static:${++blockKeyCounter}`;
    const cached = highlighter.request(key, code, lang, (res) => {
      if (codeEl.isConnected && codeEl.textContent === res.code && !isSelectionTouching(codeEl)) codeEl.innerHTML = res.html;
    });

    if (cached !== null && !isSelectionTouching(codeEl)) codeEl.innerHTML = cached;
  }
}

function extractCardsSource(source: string): string {
  const parts: string[] = [];

  for (const span of cardSpans(source)) parts.push(source.slice(span.start, span.end));

  return parts.join("\n\n");
}

function unwrapAllSafeFades(root: HTMLElement): void {
  for (const span of [...root.querySelectorAll<HTMLSpanElement>(".chunk-fade")]) unwrapSpanIfSafe(span);
}

class Reveal {
  private target = "";
  private shown = 0;
  private final = false;
  private finalAt = 0;
  private after: (() => void) | null = null;
  private rafId: number | null = null;
  private settleTimer: number | null = null;
  private lastFrameAt = 0;
  private lastCommitAt = 0;
  private lastCostMs = 0;
  private carryChars = 0;
  private smoothedCps = 48;
  private lastPushAt = 0;
  private lastPushLen = 0;
  private entered = false;
  private cardSignature = "";
  private readonly id = ++blockKeyCounter;
  private readonly freezer = new IncrementalBlockFreezer();
  private slots: MountedSlot[] = [];

  constructor(private readonly el: HTMLElement, private readonly opts: Options) {}

  update(text: string, final: boolean, after?: () => void): void {
    const now = performance.now();

    if (!text.startsWith(this.target.slice(0, this.shown))) {
      let common = 0;

      while (common < this.shown && text[common] === this.target[common]) common += 1;
      this.rewind(common);
    }

    const deltaLen = Math.max(0, text.length - this.lastPushLen);

    if (this.lastPushAt > 0 && deltaLen > 0) {
      const dtSec = Math.max(0.02, (now - this.lastPushAt) / 1000);

      this.smoothedCps = this.smoothedCps * 0.72 + Math.min(MAX_CPS, deltaLen / dtSec) * 0.28;
    }
    this.lastPushAt = now;
    this.lastPushLen = text.length;
    this.target = text;
    if (final && !this.final) {
      this.final = true;
      this.finalAt = now;
    }
    if (after) this.after = after;

    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.el.dataset.revealing = "true";
    if (this.rafId === null) {
      this.lastFrameAt = now;
      this.rafId = window.requestAnimationFrame(this.tick);
    }
  }

  flush(): void {
    this.cancelTimers();
    this.shown = this.target.length;
    this.slots = [];
    this.freezer.reset();
    delete this.el.dataset.revealing;
    patchAnswer(this.el, this.opts.render(this.target));
    highlightStaticCodeBlocks(this.el);
    this.finishIfDone();
  }

  private cancelTimers(): void {
    if (this.rafId !== null) { window.cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.settleTimer !== null) { window.clearTimeout(this.settleTimer); this.settleTimer = null; }
  }

  private rewind(common: number): void {
    this.shown = common;
    this.slots = [];
    this.freezer.reset();
    this.cardSignature = "";
    for (const node of [...this.el.childNodes]) {
      if (node instanceof HTMLElement && node.matches(".answer-actions, .answer-panel, .send-declined-card, .memory-used-line, .memory-used-cite-row")) continue;
      node.remove();
    }
    if (common > 0) this.commit(this.target.slice(0, common), false);
  }

  private tick = (now: number): void => {
    this.rafId = null;
    const dtMs = Math.min(64, Math.max(8, now - this.lastFrameAt));

    this.lastFrameAt = now;
    const budgetWait = this.lastCostMs > 0 ? Math.min(100, this.lastCostMs / REBUILD_LOAD) : 0;

    if (budgetWait > 16 && now - this.lastCommitAt < budgetWait && !(this.final && now - this.finalAt >= MAX_CATCH_UP)) {
      this.rafId = window.requestAnimationFrame(this.tick);

      return;
    }

    const jumped = cardFastForward(this.target, this.shown);

    if (jumped > this.shown) {
      this.shown = jumped;
      const done = this.final && this.shown >= this.target.length;

      this.runCommit(done);
      if (done) { this.scheduleFinish(); return; }
      this.rafId = window.requestAnimationFrame(this.tick);

      return;
    }

    const backlog = this.target.length - this.shown;

    if (backlog > 0) {
      const step = this.computeStepChars(backlog, dtMs, now);

      if (step > 0) {
        this.carryChars = Math.max(0, this.carryChars - step);
        const nextIdx = snapCharBoundary(this.target, Math.min(this.target.length, this.shown + step));
        const advanced = cardFastForward(this.target, nextIdx);

        if (advanced > this.shown) {
          this.shown = advanced;
          const done = this.final && this.shown >= this.target.length;

          this.runCommit(done);
          if (done) { this.scheduleFinish(); return; }
        }
      }
    } else if (this.final) {
      this.runCommit(true);
      this.scheduleFinish();

      return;
    }

    if (this.shown < this.target.length || !this.final) {
      this.rafId = window.requestAnimationFrame(this.tick);
    }
  };

  private computeStepChars(backlog: number, dtMs: number, now: number): number {
    if (this.final) {
      const remaining = Math.max(16, MAX_CATCH_UP - (now - this.finalAt));

      if (remaining <= 24) return backlog;
      const cps = Math.max(this.smoothedCps * 1.4, (backlog / remaining) * 1000);

      this.carryChars += (cps * dtMs) / 1000;

      return Math.floor(this.carryChars);
    }
    const horizonSec = MAX_CATCH_UP / 1000;
    const cps = Math.max(MIN_CPS, Math.min(MAX_CPS, Math.max(backlog / horizonSec, this.smoothedCps * 0.88)));

    this.carryChars += (cps * dtMs) / 1000;

    return Math.floor(this.carryChars);
  }

  private runCommit(final: boolean): void {
    const t0 = performance.now();

    this.commit(this.target.slice(0, this.shown), final);
    this.lastCostMs = performance.now() - t0;
    this.lastCommitAt = performance.now();
    this.opts.onProgress?.();
  }

  private scheduleFinish(): void {
    const pendingFades = this.el.querySelectorAll(".chunk-fade").length;

    if (pendingFades > 0 && !isSelectionTouching(this.el)) {
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = null;
        unwrapAllSafeFades(this.el);
        this.completeReveal();
      }, D_STREAM_FADE + FADE_SLACK);

      return;
    }
    unwrapAllSafeFades(this.el);
    this.completeReveal();
  }

  private completeReveal(): void {
    delete this.el.dataset.revealing;
    this.finishIfDone();
    this.opts.onProgress?.();
  }

  private finishIfDone(): void {
    if (!this.final || this.shown < this.target.length) return;
    dropPlaceholders(this.el);
    if (!this.after) return;
    const after = this.after;

    this.after = null;
    after();
  }

  private commit(shownText: string, final: boolean): void {
    const now = performance.now();

    if (!this.entered && shownText.length > 0) {
      this.el.classList.add("stream-enter");
      this.entered = true;
    }

    const { blocks } = this.freezer.update(shownText, final);
    const nextCardSig = blocks.filter((b) => b.kind === "card").map((b) => `${b.index}:${b.raw.length}:${b.frozen ? 1 : 0}`).join("|");
    const cardsChanged = nextCardSig !== this.cardSignature;

    this.cardSignature = nextCardSig;
    const cardsSource = blocks.some((b) => b.hasRef) ? extractCardsSource(shownText) : "";

    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i]!;
      const isTail = i === blocks.length - 1;

      this.commitBlock(i, block, isTail && !final, final, cardsChanged, cardsSource, now);
    }

    while (this.slots.length > blocks.length) {
      const extra = this.slots.pop()!;

      for (const node of extra.nodes) node.remove();
    }
  }

  private commitBlock(
    index: number,
    block: StreamBlock,
    isLiveTail: boolean,
    final: boolean,
    cardsChanged: boolean,
    cardsSource: string,
    now: number,
  ): void {
    const prev = this.slots[index];

    if (prev && prev.frozen && block.frozen && prev.raw === block.raw) {
      if (block.hasRef && cardsChanged && !prev.nodes.some(isSelectionTouching)) {
        this.renderProseSlot(index, prev, block, block.raw, cardsSource, now, false);
        markFrozenNodes(prev.nodes);
      }

      return;
    }

    if (prev && prev.raw === block.raw && prev.frozen === block.frozen) return;

    if (
      isLiveTail &&
      block.kind === "markdown" &&
      prev &&
      prev.kind === "markdown" &&
      !prev.frozen &&
      !block.hasRef &&
      block.raw.startsWith(prev.raw) &&
      this.tryFastProseAppend(prev, block.raw, now)
    ) {
      return;
    }

    if (isLiveTail && prev && prev.kind === "table" && block.kind === "table") {
      const delta = block.raw.startsWith(prev.raw) ? block.raw.slice(prev.raw.length) : block.raw;

      if (!SYNTAX_BOUNDARY.test(delta) && prev.lastStructuralAt && now - prev.lastStructuralAt < TABLE_INTERVAL) return;
    }

    const slot = prev ?? this.createSlot(block);

    this.slots[index] = slot;
    if (block.kind === "code") this.renderCodeSlot(index, slot, block, now, isLiveTail);
    else if (block.kind === "card") this.renderCardSlot(index, slot, block, now, final);
    else {
      const effective = isLiveTail ? repairStreamingTail(block.raw).text : block.raw;

      this.renderProseSlot(index, slot, block, effective, cardsSource, now, isLiveTail);
      slot.lastStructuralAt = now;
    }

    slot.raw = block.raw;
    slot.kind = block.kind;
    slot.frozen = block.frozen;
    slot.hasRef = block.hasRef;
    if (block.frozen) markFrozenNodes(slot.nodes);
  }

  private createSlot(block: StreamBlock): MountedSlot {
    return {
      index: block.index,
      kind: block.kind,
      raw: "",
      repaired: "",
      frozen: false,
      hasRef: block.hasRef,
      nodes: [],
      visibleLen: 0,
      fades: [],
    };
  }

  private nextAnchor(index: number): ChildNode | null {
    for (let j = index + 1; j < this.slots.length; j += 1) {
      const first = this.slots[j]?.nodes[0];

      if (first && first.parentNode === this.el) return first;
    }

    return anchorBefore(this.el);
  }

  private mountSlotNodes(index: number, slot: MountedSlot, nextNodes: ChildNode[]): void {
    // WHY: 节点一离开页面再放回，卡片里的画框就会重新加载、从头画；已经在原位的节点留着不动。
    const reused = new Set(nextNodes);
    const placed = slot.nodes.filter((node) => node.parentNode === this.el);
    let at: ChildNode | null = placed[0] ?? this.nextAnchor(index);

    for (const node of placed) {
      if (reused.has(node)) continue;
      if (node === at) at = node.nextSibling;
      node.remove();
    }
    for (const node of nextNodes) {
      if (node === at) {
        at = node.nextSibling;
        continue;
      }
      this.el.insertBefore(node, at);
    }
    slot.nodes = nextNodes;
  }

  private tryFastProseAppend(slot: MountedSlot, nextRaw: string, now: number): boolean {
    const delta = nextRaw.slice(slot.raw.length);

    if (!delta || !PLAIN_PROSE_DELTA.test(delta)) return false;
    const repair = repairStreamingTail(nextRaw);
    const prevRepair = repairStreamingTail(slot.raw);

    if (repair.suffix !== prevRepair.suffix || repair.keptLength !== prevRepair.keptLength + delta.length) return false;
    const lastText = lastVisibleText(slot.nodes);

    if (!lastText) return false;
    const parent = lastText.parentElement;

    if (!parent || parent.closest("table, pre, .gen-card")) return false;
    const host = parent.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote");

    if (!host || !slot.nodes.some((n) => n === host || n.contains(host))) return false;
    const span = fadeSpan(0);

    span.textContent = delta;
    const inlineEl = parent.closest("code, a, strong, em, del");

    if (!repair.suffix && inlineEl && host.contains(inlineEl)) {
      inlineEl.after(span);
    } else {
      const anchor: ChildNode = parent.classList.contains("chunk-fade") && parent.lastChild === lastText ? parent : lastText;

      anchor.after(span);
    }
    const prevLen = slot.visibleLen;

    slot.visibleLen += delta.length;
    slot.fades = slot.fades.filter((f) => now - f.at < D_STREAM_FADE);
    slot.fades.push({ from: prevLen, to: slot.visibleLen, at: now });
    slot.raw = nextRaw;
    slot.repaired = repair.text;

    return true;
  }

  private renderProseSlot(
    index: number,
    slot: MountedSlot,
    block: StreamBlock,
    effective: string,
    cardsSource: string,
    now: number,
    isLive: boolean,
  ): void {
    if (!effective.trim()) {
      for (const node of slot.nodes) node.remove();
      slot.nodes = [];
      slot.visibleLen = 0;
      slot.repaired = effective;

      return;
    }
    if (slot.repaired === effective && slot.nodes.some(isSelectionTouching)) return;

    const html = block.hasRef && cardsSource ? this.opts.render(`${effective}\n\n${cardsSource}`) : this.opts.render(effective);
    const nodes = block.hasRef && cardsSource
      ? topNodes(html, this.el).filter((n) => !(n instanceof Element && n.classList.contains("gen-card")))
      : topNodes(html, this.el);
    const prevLen = slot.visibleLen;
    const nextLen = nodes.reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
    const fades = slot.fades
      .filter((f) => now - f.at < D_STREAM_FADE && f.from < nextLen)
      .map((f) => ({ ...f, to: Math.min(f.to, nextLen) }));

    if (isLive && nextLen > prevLen) fades.push({ from: prevLen, to: nextLen, at: now });
    const isNewTable = prevLen === 0 && nodes.some((n) => n instanceof Element && (n.tagName === "TABLE" || !!n.querySelector("table")));

    this.mountSlotNodes(index, slot, nodes);
    slot.visibleLen = nextLen;
    slot.repaired = effective;
    slot.fades = fades;
    if (isNewTable && isLive) {
      for (const n of nodes) if (n instanceof HTMLElement) n.classList.add("stream-block-enter");
    } else if (isLive && fades.length > 0) {
      wrapRanges(nodes, fades, now);
    }
  }

  private renderCodeSlot(index: number, slot: MountedSlot, block: StreamBlock, now: number, isLive: boolean): void {
    const repaired = isLive ? repairStreamingTail(block.raw).text : block.raw;

    if (!repaired.trim()) return;
    const parsed = parseCodeFence(repaired);

    if (!parsed) {
      this.renderProseSlot(index, slot, block, repaired, "", now, isLive);

      return;
    }
    const { lang, code } = parsed;
    let codeEl = findCodeElement(slot.nodes);
    let created = false;

    if (!codeEl) {
      created = true;
      const nodes = topNodes(this.opts.render(repaired), this.el);

      if (isLive) for (const n of nodes) if (n instanceof HTMLElement) n.classList.add("stream-block-enter");
      this.mountSlotNodes(index, slot, nodes);
      codeEl = findCodeElement(slot.nodes);
    }
    if (!codeEl) return;

    const prevCode = slot.lastCodeText ?? "";
    const isPureAppend = !created && code.startsWith(prevCode);
    const appended = isPureAppend ? code.slice(prevCode.length) : "";

    if (isPureAppend && appended.length > 0 && !isSelectionTouching(codeEl)) {
      const span = fadeSpan(0);

      span.textContent = appended;
      codeEl.append(span);
    } else if ((created || !isPureAppend) && !isSelectionTouching(codeEl)) {
      codeEl.textContent = code;
    }

    slot.lastCodeText = code;
    slot.repaired = repaired;
    slot.visibleLen = code.length;
    this.scheduleCodeHighlight(slot, codeEl, code, lang, now, !isLive || created || appended.includes("\n"));
  }

  private scheduleCodeHighlight(
    slot: MountedSlot,
    codeEl: HTMLElement,
    code: string,
    lang: string,
    now: number,
    eager: boolean,
  ): void {
    if (!code.length) return;
    if (!eager && slot.lastHighlightAt && now - slot.lastHighlightAt < HIGHLIGHT_INTERVAL) return;
    slot.lastHighlightAt = now;
    const key = `stream:${this.id}:${slot.index}`;
    const immediate = getCodeHighlighter().request(key, code, lang, (res) => {
      if (!codeEl.isConnected || isSelectionTouching(codeEl)) return;
      const latest = slot.lastCodeText ?? "";

      if (latest === res.code) {
        slot.lastHighlightHtml = res.html;
        codeEl.innerHTML = res.html;
      } else if (latest.startsWith(res.code)) {
        slot.lastHighlightHtml = res.html;
        codeEl.innerHTML = `${res.html}<span>${escHtml(latest.slice(res.code.length))}</span>`;
      }
    });

    if (immediate !== null && !isSelectionTouching(codeEl)) {
      slot.lastHighlightHtml = immediate;
      codeEl.innerHTML = immediate;
    }
  }

  private renderCardSlot(index: number, slot: MountedSlot, block: StreamBlock, now: number, final: boolean): void {
    const closeTags = (block.raw.match(/>/g) ?? []).length;
    const tagChanged = closeTags !== (slot.lastCardCloseTags ?? -1);

    if (!final && !block.frozen && !tagChanged && slot.lastStructuralAt && now - slot.lastStructuralAt < CARD_INTERVAL) return;
    slot.lastCardCloseTags = closeTags;
    slot.lastStructuralAt = now;

    const html = this.opts.render(block.raw);
    const existingCard = slot.nodes.find((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains("gen-card"));

    if (existingCard && existingCard.parentNode === this.el) {
      this.mountSlotNodes(index, slot, patchCardNodes(existingCard, html));
    } else {
      const nodes = topNodes(html, this.el);

      this.mountSlotNodes(index, slot, nodes);
    }
    slot.repaired = block.raw;
    slot.visibleLen = slot.nodes.reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
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
    highlightStaticCodeBlocks(el);
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
