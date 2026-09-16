import type { TranslationCommand, TranslationReceipt, TranslationMode } from '../../../shared/page-translation.js';

/** Serialized into Chrome's ISOLATED world. Keep all runtime helpers inside this function. */
export function translationInPage(command: TranslationCommand): Omit<TranslationReceipt, 'tabId'> {
  type Segment = {id: string; node: Text; original: string; translation?: string};
  type Block = {id: string; element: HTMLElement; segments: Segment[]; output?: HTMLElement; font?: {value: string; priority: string; hadStyle: boolean; applied: string}};
  type State = {
    token: string; url: string; language: string; mode: TranslationMode; fontSize: number | null;
    next: number; blocks: Map<HTMLElement, Block>; observer: MutationObserver;
    restore: () => void;
  };
  const documentUrl = () => { const url = new URL(location.href); url.hash = ''; return url.href; };
  const world = globalThis as typeof globalThis & {__bysTranslation?: State};
  let state = world.__bysTranslation;
  if (state && state.url !== documentUrl()) { state.restore(); delete world.__bysTranslation; state = undefined; }
  if (command.document && command.document !== state?.token) throw new Error('网页已变化，这批译文未写入。请在当前页面重新翻译。');
  const restoreFont = (block: Block) => {
    if (!block.font) return;
    const currentStyle = block.element.getAttribute('style');
    if (block.element.style.fontSize === block.font.applied) {
      if (!block.font.hadStyle && currentStyle !== null && block.element.style.length === 1) block.element.removeAttribute('style');
      else block.element.style.setProperty('font-size', block.font.value, block.font.priority);
    }
    block.font = undefined;
  };
  const undo = (block: Block) => {
    for (const s of block.segments) if (s.translation !== undefined && s.node.data === s.translation) s.node.data = s.original;
    block.output?.remove();
    block.output = undefined;
    restoreFont(block);
  };
  const clear = () => { state?.restore(); delete world.__bysTranslation; };
  if (command.action === 'restore') {
    clear();
    return {document: '', language: '', mode: 'bilingual', fontSize: null, translated: 0, remaining: 0, unsupported: 0, blocks: []};
  }
  if (command.action === 'begin' && state && command.language && state.language !== command.language) { clear(); state = undefined; }
  if (!state) {
    if (command.action !== 'begin') throw new Error('当前页面还没有译文，请先翻译页面。');
    state = {
      token: crypto.randomUUID(), url: documentUrl(), language: command.language ?? '简体中文',
      mode: command.mode ?? 'bilingual', fontSize: command.fontSize ?? null, next: 0,
      blocks: new Map(), observer: new MutationObserver(() => {}), restore: () => {},
    };
    const owned = state;
    state.restore = () => { owned.observer.disconnect(); for (const b of owned.blocks.values()) undo(b); owned.blocks.clear(); };
    world.__bysTranslation = state;
    state.observer = new MutationObserver(() => {
      if (owned.url !== documentUrl()) { owned.restore(); if (world.__bysTranslation === owned) delete world.__bysTranslation; return; }
      for (const [element, block] of owned.blocks) {
        if (!element.isConnected || block.segments.some(s => !s.node.isConnected || !element.contains(s.node) || s.node.data !== (owned.mode === 'translated' ? s.translation ?? s.original : s.original))) {
          undo(block); owned.blocks.delete(element);
        }
      }
    });
    state.observer.observe(document.body, {subtree: true, childList: true, characterData: true});
  }
  const current = state;
  const render = (block: Block) => {
    // Keep original nodes and listeners; translated-only changes their text, not innerHTML.
    block.output?.remove(); block.output = undefined;
    for (const segment of block.segments) segment.node.data = current.mode === 'translated' ? segment.translation ?? segment.original : segment.original;
    if (current.mode === 'bilingual') {
      restoreFont(block);
      if (!block.segments.every(s => s.translation !== undefined)) return;
      const output = document.createElement('span');
      output.dataset.bysTranslation = 'true';
      output.lang = current.language === '简体中文' ? 'zh-CN' : current.language;
      output.style.cssText = 'display:block;white-space:pre-wrap;line-height:1.6;margin-block:0.35em 0.65em;overflow-wrap:anywhere;text-align:inherit;';
      if (current.fontSize) output.style.fontSize = `${current.fontSize}px`;
      for (const segment of block.segments) {
        const anchor = segment.node.parentElement?.closest('a');
        if (anchor && anchor !== block.element && /^(https?:|mailto:|tel:)/i.test(anchor.href)) {
          const link = document.createElement('a'); link.href = anchor.href;
          link.textContent = segment.translation!; output.append(link);
        } else output.append(document.createTextNode(segment.translation!));
      }
      block.element.append(output); block.output = output;
    } else if (current.fontSize) {
      block.font ??= {value: block.element.style.getPropertyValue('font-size'), priority: block.element.style.getPropertyPriority('font-size'), hadStyle: block.element.hasAttribute('style'), applied: `${current.fontSize}px`};
      block.element.style.setProperty('font-size', `${current.fontSize}px`);
    }
  };
  if (command.mode || command.fontSize !== undefined) {
    // Restore the prior font before replacing the desired size.
    for (const block of current.blocks.values()) restoreFont(block);
    if (command.mode) current.mode = command.mode;
    if (command.fontSize !== undefined) current.fontSize = command.fontSize;
    for (const block of current.blocks.values()) if (block.segments.every(s => s.translation !== undefined)) render(block);
  }
  if (command.action === 'apply') {
    const translations = new Map(command.translations!.map(t => [t.id, t.text]));
    const affected = [...current.blocks.values()].filter(b => b.segments.some(s => translations.has(s.id)));
    // Validate the complete batch before touching any text. Page changes never get overwritten.
    if (translations.size !== command.translations!.length || affected.reduce((n, b) => n + b.segments.length, 0) !== translations.size || affected.some(b => b.segments.some(s => !translations.has(s.id) || !s.node.isConnected || s.node.data !== (current.mode === 'translated' ? s.translation ?? s.original : s.original)))) throw new Error('原文已变化，这批译文未写入；可以继续翻译。');
    for (const block of affected) {
      for (const s of block.segments) s.translation = translations.get(s.id)!;
      render(block);
    }
  }

  // Text nodes are grouped by paragraph, including inline links/emphasis as one context.
  const excluded = 'script,style,noscript,textarea,input,select,button,pre,code,svg,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-bys-translation],[hidden],[aria-hidden="true"],[id^="__sideagent"],[id^="sideagent-"]';
  const groups = new Map<HTMLElement, Text[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text, parent = text.parentElement;
    if (!parent || !text.data.length || parent.closest(excluded)) continue;
    const element = (parent.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,dt,dd,div,section,article,main') ?? parent) as HTMLElement;
    if (parent.getClientRects().length === 0 || getComputedStyle(parent).visibility === 'hidden') continue;
    const list = groups.get(element) ?? []; list.push(text); groups.set(element, list);
  }
  let unsupported = 0;
  for (const [element, nodes] of groups) {
    if (!nodes.some(node => node.data.trim())) { groups.delete(element); continue; }
    let block = current.blocks.get(element);
    if (block && (block.segments.length !== nodes.length || block.segments.some((s, i) => s.node !== nodes[i] || s.node.data !== (current.mode === 'translated' ? s.translation ?? s.original : s.original)))) {
      undo(block); current.blocks.delete(element); block = undefined;
    }
    if (block) continue;
    if (nodes.length > 64 || nodes.reduce((n, s) => n + s.length, 0) > 12000) { unsupported++; continue; }
    const id = String(++current.next);
    current.blocks.set(element, {id, element, segments: nodes.map((node, i) => ({id: `${id}:${i}`, node, original: node.data}))});
  }
  for (const [element, block] of current.blocks) if (!groups.has(element)) { undo(block); current.blocks.delete(element); }
  const pending = [...current.blocks.values()].filter(b => !b.segments.every(s => s.translation !== undefined));
  // Read the user's visible paragraphs first; do not scroll the page to translate it.
  pending.sort((a, b) => {
    const distance = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.bottom >= 0 && r.top < innerHeight ? 0 : Math.abs(r.top); };
    return distance(a.element) - distance(b.element);
  });
  const blocks: TranslationReceipt['blocks'] = [];
  let chars = 0, segments = 0;
  if (command.action === 'collect') for (const block of pending) {
    const size = block.segments.reduce((n, s) => n + s.original.length, 0);
    if (blocks.length && (blocks.length >= 8 || chars + size > 3000 || segments + block.segments.length > 24)) break;
    blocks.push({id: block.id, segments: block.segments.map(s => ({id: s.id, text: s.original}))});
    chars += size; segments += block.segments.length;
  }
  return {document: current.token, language: current.language, mode: current.mode, fontSize: current.fontSize,
    translated: current.blocks.size - pending.length, remaining: pending.length, unsupported, blocks};
}
