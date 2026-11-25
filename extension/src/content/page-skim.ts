import type { SkimPoint } from "../../../shared/page-phase2.js";
import { PAPER_TOKENS } from "./ask-styles.js";
import { collectTextNodes } from "./page-notes.js";

const SKIM_HOST_ATTR = "data-sideagent-skim";
const SKIM_HIGHLIGHT = "sideagent-skim";
const SKIM_STYLE_ID = "sideagent-skim-highlight-style";
const CARD_WIDTH = 220;
const CARD_GAP = 16;
const EDGE = 12;
const MIN_QUOTE = 4;
const CITATION_MARK = /\[[^\]\n]{1,10}\]/g;
const INSIDE = new Set(["LI", "DD", "DT", "TD", "TH", "FIGCAPTION"]);

const SKIM_STYLES = `${PAPER_TOKENS}
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483640; font: var(--t-meta)/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--ink-fg); -webkit-font-smoothing: antialiased; }
.card { position: fixed; width: max-content; max-width: ${CARD_WIDTH}px; padding: 6px 10px; border-left: 2px solid var(--mark); border-radius: var(--r-small); background: var(--ink); box-shadow: var(--shadow-bar); overflow-wrap: anywhere; pointer-events: auto; }
.clear { position: fixed; top: 14px; right: 16px; padding: 6px 12px; border: 0; border-radius: var(--r-outer); background: var(--ink); color: inherit; font: inherit; box-shadow: var(--shadow-bar); cursor: pointer; pointer-events: auto; }
.clear:hover { background: var(--ink-hover); }
.clear:focus-visible { outline: 2px solid var(--pen); outline-offset: 1px; }
.below { display: block; margin: 6px 0 12px; padding: 1px 0 1px 10px; border-left: 2px solid var(--mark); font: var(--t-meta)/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif; color: color-mix(in srgb, currentColor 76%, transparent); overflow-wrap: anywhere; }
.below + .below { margin-top: -6px; }
`;

interface MountedPoint {
  range: Range;
  block: Element;
  card: HTMLDivElement;
}

interface MatchedPoint {
  point: SkimPoint;
  range: Range;
  block: Element;
}

interface TextIndex {
  compact: string;
  nodes: Text[];
  nodeAt: number[];
  offsetAt: number[];
}

function buildTextIndex(withoutCitations: boolean): TextIndex {
  const nodes: Text[] = [];
  const nodeAt: number[] = [];
  const offsetAt: number[] = [];
  const parts: string[] = [];

  for (const { node } of collectTextNodes(document.body)) {
    if (withoutCitations && node.parentElement?.closest("sup")?.querySelector("a")) continue;
    const data = node.data;
    const at = nodes.push(node) - 1;
    let kept = "";

    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch.trim() === "") continue;
      kept += ch;
      nodeAt.push(at);
      offsetAt.push(i);
    }
    parts.push(kept);
  }

  return { compact: parts.join(""), nodes, nodeAt, offsetAt };
}

function visibleRangeOf(index: TextIndex, needle: string): Range | null {
  if (needle.length < MIN_QUOTE) return null;

  for (let at = index.compact.indexOf(needle); at >= 0; at = index.compact.indexOf(needle, at + 1)) {
    const last = at + needle.length - 1;
    const range = document.createRange();
    range.setStart(index.nodes[index.nodeAt[at]!]!, index.offsetAt[at]!);
    range.setEnd(index.nodes[index.nodeAt[last]!]!, index.offsetAt[last]! + 1);
    if (range.getClientRects().length > 0) return range;
  }

  return null;
}

function blockOf(range: Range): Element {
  const start = range.commonAncestorContainer;
  let el: Element | null = start instanceof Element ? start : start.parentElement;

  while (el && el !== document.body && getComputedStyle(el).display.startsWith("inline")) el = el.parentElement;

  return el ?? document.body;
}

export class PageSkimLayer {
  private host: HTMLDivElement | null = null;
  private notes: HTMLElement[] = [];
  private mounted: MountedPoint[] = [];
  private styleTag: HTMLStyleElement | null = null;

  apply(points: SkimPoint[]): { matched: number; missed: string[] } {
    this.clear();
    const plain = buildTextIndex(false);
    let uncited: TextIndex | null = null;
    const matched: MatchedPoint[] = [];

    for (const point of points) {
      const needle = point.quote.replace(/\s+/g, "");
      const range = visibleRangeOf(plain, needle)
        ?? visibleRangeOf(uncited ??= buildTextIndex(true), needle.replace(CITATION_MARK, ""));
      if (range) matched.push({ point, range, block: blockOf(range) });
    }

    const missed = points.filter((point) => !matched.some((item) => item.point === point)).map((point) => point.id);
    if (matched.length === 0) return { matched: 0, missed };

    this.ensureHighlightStyle();
    if ("highlights" in CSS) {
      CSS.highlights.set(SKIM_HIGHLIGHT, new Highlight(...matched.map((item) => item.range)));
    }

    this.revealFirst(matched);
    const inMargin = this.marginIsFree(matched);
    const host = document.createElement("div");
    host.setAttribute(SKIM_HOST_ATTR, "layer");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = SKIM_STYLES;
    const layer = document.createElement("div");
    layer.className = "layer";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "clear";
    clearBtn.textContent = "清除扫读";
    clearBtn.addEventListener("click", () => this.clear());
    layer.append(clearBtn);

    if (inMargin) {
      for (const { point, range, block } of matched) {
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.skimId = point.id;
        card.textContent = point.note;
        layer.append(card);
        this.mounted.push({ range, block, card });
      }
    } else {
      this.mountBelow(matched);
    }

    shadow.append(style, layer);
    document.documentElement.append(host);
    this.host = host;
    if (inMargin) {
      this.reposition();
      window.addEventListener("scroll", this.reposition, { passive: true, capture: true });
      window.addEventListener("resize", this.reposition, { passive: true });
    }
    return { matched: matched.length, missed };
  }

  clear(): void {
    window.removeEventListener("scroll", this.reposition, { capture: true });
    window.removeEventListener("resize", this.reposition);
    this.mounted = [];
    if ("highlights" in CSS) {
      CSS.highlights.delete(SKIM_HIGHLIGHT);
    }
    for (const note of this.notes) note.remove();
    this.notes = [];
    this.host?.remove();
    this.host = null;
    this.styleTag?.remove();
    this.styleTag = null;
  }

  private revealFirst(matched: MatchedPoint[]): void {
    const tops = matched.map((item) => item.range.getBoundingClientRect());
    if (tops.some((rect) => rect.bottom > 0 && rect.top < window.innerHeight)) return;
    const first = matched[tops.indexOf(tops.reduce((a, b) => (b.top < a.top ? b : a)))];
    first?.block.scrollIntoView({ block: "center" });
  }

  private marginIsFree(matched: MatchedPoint[]): boolean {
    const left = Math.max(...matched.map((item) => item.block.getBoundingClientRect().right)) + CARD_GAP;
    if (left + CARD_WIDTH + EDGE > window.innerWidth) return false;
    const blocks = matched.map((item) => item.block);
    const blank = (x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      return !hit || hit === document.body || hit === document.documentElement || hit.hasAttribute(SKIM_HOST_ATTR) || blocks.some((block) => hit.contains(block));
    };
    const lines = matched
      .map((item) => [...item.range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0))
      .filter((rect): rect is DOMRect => !!rect && rect.top >= 0 && rect.top < window.innerHeight);

    return lines.every((line) => [line.top + 4, line.top + 40].every((y) => y >= window.innerHeight || [left + 8, left + CARD_WIDTH / 2, left + CARD_WIDTH - 8].every((x) => blank(x, y))));
  }

  private mountBelow(matched: MatchedPoint[]): void {
    const byBlock = new Map<Element, SkimPoint[]>();
    for (const { point, block } of matched) byBlock.set(block, [...(byBlock.get(block) ?? []), point]);

    for (const [block, points] of byBlock) {
      const host = document.createElement("div");
      host.setAttribute(SKIM_HOST_ATTR, "note");
      host.style.cssText = "all:initial;display:block;color:inherit;";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = SKIM_STYLES;
      shadow.append(style, ...points.map((point) => {
        const note = document.createElement("div");
        note.className = "below";
        note.dataset.skimId = point.id;
        note.textContent = point.note;
        return note;
      }));
      if (block === document.body || INSIDE.has(block.tagName)) block.append(host);
      else block.after(host);
      this.notes.push(host);
    }
  }

  private reposition = (): void => {
    const lines = this.mounted
      .map((item) => ({ ...item, line: [...item.range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0) }))
      .sort((a, b) => (a.line?.top ?? 0) - (b.line?.top ?? 0));
    let lastBottom = 54;

    for (const { block, card, line } of lines) {
      const visible = !!line && line.bottom >= 0 && line.top <= window.innerHeight;
      card.style.display = visible ? "block" : "none";
      if (!line || !visible) continue;
      const top = Math.max(line.top, lastBottom + 8);
      card.style.top = `${Math.round(top)}px`;
      card.style.left = `${Math.round(Math.min(block.getBoundingClientRect().right + CARD_GAP, window.innerWidth - CARD_WIDTH - EDGE))}px`;
      lastBottom = top + card.offsetHeight;
    }
  };

  private ensureHighlightStyle(): void {
    if (document.getElementById(SKIM_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SKIM_STYLE_ID;
    style.textContent = `::highlight(${SKIM_HIGHLIGHT}) { background-color: rgba(234, 179, 8, 0.24); }`;
    document.head.append(style);
    this.styleTag = style;
  }
}
