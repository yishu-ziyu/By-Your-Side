import { createElement as icon, MessageCircle, Minus, X } from 'lucide';
import { isReadingTranslation } from '../../../shared/reading.js';
import { sanitizeAnswerHtml } from '../shared/answer-html.js';
import { renderMarkdownHtml } from '../shared/markdown.js';
import type { ReadingRecord } from '../shared/reading-state.js';
import { PAPER_TOKENS } from './ask-styles.js';

export const NOTE_ATTR = 'data-sideagent-note';

export const NOTE_HIGHLIGHT = 'sideagent-note';

const NOTE_WIDTH = 220;

const NOTE_GAP = 40;

const STACK_GAP = 10;

const LABEL_LIMIT = 10;

const INSIDE = new Set(['LI', 'DD', 'DT', 'TD', 'FIGCAPTION']);

const FLOW = new Set(['block', 'flow-root', 'list-item', 'table-cell']);

const NOTE_STYLES = `${PAPER_TOKENS}
* { box-sizing: border-box; }
.note { position: relative; padding-left: 12px; border-left: 2px solid var(--mark); overflow-wrap: anywhere; animation: note-in .3s var(--ease-out) both; }
.note.margin { position: absolute; left: 0; top: 0; width: ${NOTE_WIDTH}px; padding-left: 10px; font: var(--t-ui)/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif; letter-spacing: normal; text-align: start; }
.label { display: block; margin-bottom: 2px; font-weight: 600; }
.text { color: color-mix(in srgb, currentColor 76%, transparent); }
.text > :first-child { margin-top: 0; }
.text > :last-child { margin-bottom: 0; }
.text p { margin: .5em 0; }
.text ul, .text ol { margin: .4em 0; padding-left: 1.4em; }
.text h1, .text h2, .text h3, .text h4 { margin: .5em 0 .2em; font: inherit; font-weight: 600; }
.text hr { display: none; }
.text a { color: inherit; }
.text code { font-family: ui-monospace, SFMono-Regular, monospace; }
.text .fresh { animation: word-in .4s var(--ease-word) both; }
.text.thinking::before { content: ""; display: block; width: 8px; height: 8px; margin: .5em 0; border-radius: 50%; background: var(--mark); animation: thinking 1.25s ease-in-out infinite; }
.text.err { color: var(--warn); }
.acts { display: inline-flex; gap: 2px; opacity: 0; transition: opacity .15s; }
.note:hover .acts, .acts:focus-within { opacity: 1; }
.margin .acts { position: absolute; top: -1px; right: 0; }
.below .text { display: inline; }
.below .text > p:last-child { display: inline; }
.below .text > p:last-child:not(:first-child)::before { content: ""; display: block; height: .5em; }
.below .acts { margin-left: 6px; vertical-align: middle; }
.acts button { all: unset; display: grid; place-items: center; width: 22px; height: 22px; border-radius: var(--r-small); color: color-mix(in srgb, currentColor 55%, transparent); cursor: pointer; }
.acts button:hover { color: currentColor; background: color-mix(in srgb, currentColor 9%, transparent); }
.acts button:focus-visible, .dot:focus-visible { outline: 2px solid var(--mark); outline-offset: 1px; }
.acts svg { width: 13px; height: 13px; stroke-width: 2; }
.dot { all: unset; display: none; width: 10px; height: 10px; border-radius: 50%; background: var(--mark); cursor: pointer; }
.note.folded { width: auto; padding: 0; border: 0; }
.note.folded > :not(.dot) { display: none; }
.note.folded .dot { display: block; }
@keyframes note-in { from { opacity: 0; transform: translateY(-3px); } }
@keyframes word-in { from { opacity: 0; } }
@keyframes thinking { 50% { transform: scale(1.25); } }
@media (prefers-reduced-motion: reduce) { .note, .text .fresh, .text.thinking::before { animation: none; } .acts { transition: none; } }
`;

interface Note {
  threadId: string;
  record: ReadingRecord;
  range: Range;
  block: Element;
  host: HTMLElement;
  box: HTMLElement;
  body: HTMLElement;
  margin: boolean;
  marked: boolean;
  text: string;
  words: number;
  asleep: boolean;
}

interface Options {
  blockOf(range: Range | null): Element | null;
  gutterBlank(block: Element, region: { left: number; right: number; top: number; bottom: number }): boolean;
  fade(root: HTMLElement, shown: number): number;
  wake(record: ReadingRecord, range: Range): void;
}

export function inPageNote(node: Node | null): boolean {
  const root = node?.getRootNode();

  return root instanceof ShadowRoot && root.host.hasAttribute(NOTE_ATTR);
}

export function installPageNotes(options: Options) {
  const notes = new Map<string, Note>();
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightClass = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const listening = new AbortController();
  let frame = 0;

  for (const stale of document.querySelectorAll(`[${NOTE_ATTR}]`)) stale.remove();

  const firstLine = (note: Note): DOMRect => {
    const lines = note.range.startContainer.isConnected ? [...note.range.getClientRects()].filter(line => line.width > 0 && line.height > 0) : [];

    return lines[0] ?? note.block.getBoundingClientRect();
  };

  function anchorFor(range: Range | null): { block: Element; inside: boolean } | null {
    const block = options.blockOf(range);

    if (!block?.isConnected || block.closest(`[${NOTE_ATTR}]`) || (block instanceof HTMLElement && block.isContentEditable)) return null;
    const inside = INSIDE.has(block.tagName);
    const container = inside ? block : block.parentElement;

    if (!container) return null;
    const style = getComputedStyle(container);
    const column = style.display === 'flex' && style.flexDirection.startsWith('column');

    return FLOW.has(style.display) || column ? { block, inside } : null;
  }

  function mark(): void {
    if (!highlights || !HighlightClass) return;
    const ranges = [...notes.values()].filter(note => note.marked && note.host.isConnected && !note.range.collapsed).map(note => note.range);

    if (ranges.length) highlights.set(NOTE_HIGHLIGHT, new HighlightClass(...ranges));
    else highlights.delete(NOTE_HIGHLIGHT);
  }

  function layout(): void {
    frame = 0;
    let floor = -Infinity;
    const placed = [...notes.values()].filter(note => note.margin && !note.asleep && note.host.isConnected).map(note => ({ note, line: firstLine(note) })).sort((a, b) => a.line.top - b.line.top);

    for (const { note, line } of placed) {
      const origin = note.host.getBoundingClientRect();
      const top = Math.max(line.top, floor);
      note.box.style.left = `${note.block.getBoundingClientRect().right + NOTE_GAP - origin.left}px`;
      note.box.style.top = `${top - origin.top}px`;
      floor = top + note.box.offsetHeight + STACK_GAP;
    }
  }

  const relayout = () => { frame ||= requestAnimationFrame(layout); };

  function drop(note: Note): void {
    note.host.remove();
    notes.delete(note.threadId);
    mark();
    relayout();
  }

  function paint(note: Note, record: ReadingRecord): void {
    note.record = record;
    const turn = record.turns.at(-1);

    if (!turn) return;
    const busy = turn.state === 'pending' || turn.state === 'streaming';
    const failed = !busy && !turn.answer.trim();

    if (failed) {
      note.body.textContent = turn.error ?? '没有答上来，点「继续问」再试一次。';
      note.text = '';
    }
    else if (note.text !== turn.answer) {
      note.body.innerHTML = sanitizeAnswerHtml(renderMarkdownHtml(turn.answer), { images: false });

      for (const anchor of note.body.querySelectorAll('a')) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      }

      note.text = turn.answer;
      note.words = busy ? options.fade(note.body, note.words) : 0;
    }

    note.body.classList.toggle('thinking', busy && !turn.answer.trim());
    note.body.classList.toggle('err', failed);
    relayout();
  }

  function create(record: ReadingRecord, range: Range, anchor: { block: Element; inside: boolean }): Note {
    const translation = isReadingTranslation(record.turns[0]?.question ?? '');
    const blockRect = anchor.block.getBoundingClientRect();
    const line = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0) ?? blockRect;
    const right = blockRect.right + NOTE_GAP + NOTE_WIDTH + 8;
    const margin = !translation && right <= innerWidth && options.gutterBlank(anchor.block, { left: blockRect.right + 1, right, top: line.top, bottom: line.top + 120 });
    const host = document.createElement('div');
    host.setAttribute(NOTE_ATTR, margin ? 'margin' : 'below');
    const gap = parseFloat(getComputedStyle(anchor.block).marginBottom) || 0;
    host.style.cssText = `all:initial;display:block;position:relative;font:inherit;color:inherit;text-align:start;${margin ? 'height:0;' : `margin:${anchor.inside ? '6px 0 0' : `${-gap / 2}px 0 ${gap}px`};`}`;
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = NOTE_STYLES;
    const box = document.createElement('div');
    box.className = `note ${margin ? 'margin' : 'below'}`;
    const dot = document.createElement('button');
    dot.className = 'dot';
    dot.type = 'button';
    dot.setAttribute('aria-label', '展开');
    dot.title = '展开';
    const body = document.createElement('div');
    body.className = 'text';
    const acts = document.createElement('span');
    acts.className = 'acts';

    for (const [act, label, glyph] of [['ask', '继续问', MessageCircle], ['fold', '收起', Minus], ['remove', '删除', X]] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.act = act;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.append(icon(glyph));
      acts.append(button);
    }

    box.append(dot);

    if (!translation) {
      const label = document.createElement('b');
      label.className = 'label';
      const text = record.source.text.replace(/\s+/g, ' ');
      label.textContent = text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT)}…` : text;
      box.append(label);
    }

    box.append(body, acts);
    shadow.append(style, box);
    const note: Note = { threadId: record.threadId, record, range, block: anchor.block, host, box, body, margin, marked: !translation, text: '', words: 0, asleep: false };
    shadow.addEventListener('pointerdown', event => { if ((event.target as Element).closest('button')) event.preventDefault(); });
    shadow.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLElement>('button');

      if (!button) return;

      if (button === dot || button.dataset.act === 'fold') {
        box.classList.toggle('folded');
        relayout();
      }
      else if (button.dataset.act === 'remove') drop(note);
      else if (button.dataset.act === 'ask') options.wake(note.record, note.range);
    });

    if (anchor.inside) anchor.block.append(host);
    else anchor.block.after(host);

    return note;
  }

  const refresh = () => {
    for (const note of notes.values()) if (!note.host.isConnected) notes.delete(note.threadId);
    mark();
    relayout();
  };

  addEventListener('resize', refresh, { signal: listening.signal });
  document.addEventListener('click', event => {
    if (!getSelection()?.isCollapsed) return;

    for (const note of notes.values()) {
      if (!note.marked || note.asleep || note.range.collapsed || !note.range.startContainer.isConnected) continue;

      if ([...note.range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) {
        note.box.classList.toggle('folded');
        relayout();
      }
    }
  }, { signal: listening.signal });

  return {
    fits: (range: Range | null) => anchorFor(range) !== null,
    keep(record: ReadingRecord, range: Range | null): boolean {
      let note = notes.get(record.threadId);

      if (note && !note.host.isConnected) {
        notes.delete(record.threadId);
        note = undefined;
      }

      if (!note) {
        const turn = record.turns.at(-1);
        const anchor = range && !range.collapsed ? anchorFor(range) : null;

        if (!range || !anchor || !turn || (turn.state !== 'pending' && turn.state !== 'streaming' && !turn.answer.trim())) return false;
        note = create(record, range.cloneRange(), anchor);
        notes.set(record.threadId, note);
      }

      note.asleep = false;
      note.host.style.display = 'block';
      paint(note, record);
      mark();

      return true;
    },
    reveal(threadId: string): boolean {
      const note = notes.get(threadId);

      if (!note?.host.isConnected || note.asleep) return false;
      note.box.classList.remove('folded');
      relayout();

      return true;
    },
    update(record: ReadingRecord): void {
      const note = notes.get(record.threadId);

      if (note?.host.isConnected) paint(note, record);
    },
    sleep(threadId: string): void {
      const note = notes.get(threadId);

      if (!note) return;
      note.asleep = true;
      note.host.style.display = 'none';
      relayout();
    },
    clear(): void {
      for (const note of [...notes.values()]) drop(note);
    },
    dispose(): void {
      listening.abort();
    },
  };
}
