import type { TranslationCommand, TranslationReceipt, TranslationMode, TranslationFont, TranslationPageResult } from '../../../shared/page-translation.js';

/** Serialized into Chrome's ISOLATED world. Keep all runtime helpers inside this function. */
export function translationInPage(command: TranslationCommand): TranslationPageResult {
  let mutated = false;
  let applied = 0;

  try {
  type Segment = {id: string; node: Text; original: string; translation?: string};

  type Block = {pendingMark?: HTMLElement; id: string; element: HTMLElement; segments: Segment[]; output?: HTMLElement; outputs?: HTMLElement[]; cleanup?: () => void};

  type State = {
    token: string; url: string; language: string; mode: TranslationMode; fontSize: number | null; fontFamily: TranslationFont;
    next: number; blocks: Map<HTMLElement, Block>; observer: MutationObserver;
    restore: () => void; markTimer?: ReturnType<typeof setTimeout>;
  };

  const documentUrl = () => { const url = new URL(location.href); url.hash = '';

 return url.href; };

  // SAFETY: this private namespace is created only by our scripts in the extension ISOLATED world.
  const world = globalThis as typeof globalThis & {__bysTranslation?: State; __bysMountVellum?: (element: HTMLElement, sheet: HTMLElement) => () => void};
  let state = world.__bysTranslation;

  if (state && state.url !== documentUrl()) { mutated = true; state.restore(); delete world.__bysTranslation; state = undefined; }

  if (command.document && command.document !== state?.token) throw new Error('网页已变化，这批译文未写入。请在当前页面重新翻译。');
  const songti = '"Songti SC", "STSong", "SimSun", serif';

  const unmark = (block: Block) => { if (block.pendingMark) { mutated = true; block.pendingMark.remove(); block.pendingMark = undefined; } };

  const sourceValid = (block: Block) => block.element.isConnected && block.segments.every(s => s.node.isConnected && block.element.contains(s.node) && s.node.data === s.original);

  const removeOutput = (block: Block) => {
    if (block.output || block.outputs?.length) mutated = true;
    block.cleanup?.(); block.cleanup = undefined;
    block.output?.remove(); block.output = undefined;

    for (const output of block.outputs ?? []) output.remove();
    block.outputs = undefined;
  };

  const undo = (block: Block) => {
    unmark(block);

    // Original nodes are never rewritten. In particular, leave a website's new text alone.
    removeOutput(block);
  };

  const clear = () => { if (state?.blocks.size) mutated = true; state?.restore(); delete world.__bysTranslation; };

  if (command.action === 'restore') {
    clear();

    return {document: '', language: '', mode: 'bilingual', fontSize: null, translated: 0, remaining: 0, unsupported: 0, blocks: []};
  }

  if (command.action === 'settle') {
    if (state && (!command.document || command.document === state.token)) {
      clearTimeout(state.markTimer);
      const owned = state;
      const release = () => { for (const b of owned.blocks.values()) { b.pendingMark?.remove(); b.pendingMark = undefined; } };

      // A resumable failure: the model usually calls translate again within seconds; that call cancels this timer, so marks do not flash.
      if (command.delayMs) owned.markTimer = setTimeout(release, command.delayMs);
      else { for (const b of owned.blocks.values()) unmark(b); }
    }

    return {document: state?.token ?? '', language: state?.language ?? '', mode: state?.mode ?? 'bilingual', fontSize: state?.fontSize ?? null, translated: 0, remaining: 0, unsupported: 0, blocks: []};
  }

  if (command.action === 'begin' && state && command.language && state.language !== command.language) { clear(); state = undefined; }

  if ((command.mode ?? state?.mode) === 'translated' && !world.__bysMountVellum) throw new Error('原文覆盖层尚未准备好，这批译文未写入。');

  if (!state) {
    if (command.action !== 'begin') throw new Error('当前页面还没有译文，请先翻译页面。');
    state = {
      token: crypto.randomUUID(), url: documentUrl(), language: command.language ?? '简体中文',
      mode: command.mode ?? 'bilingual', fontSize: command.fontSize ?? null, fontFamily: command.fontFamily ?? 'original', next: 0,
      blocks: new Map(), observer: new MutationObserver(() => {}), restore: () => {},
    };
    const owned = state;
    state.restore = () => { clearTimeout(owned.markTimer); owned.observer.disconnect();

 for (const b of owned.blocks.values()) undo(b); owned.blocks.clear(); };

    world.__bysTranslation = state;
    state.observer = new MutationObserver(() => {
      if (owned.url !== documentUrl()) { owned.restore();

 if (world.__bysTranslation === owned) delete world.__bysTranslation;

 return; }

      for (const [element, block] of owned.blocks) {
        if (!sourceValid(block) || (block.output && !block.output.isConnected) || block.outputs?.some((output, i) => !output.isConnected || !output.parentElement?.contains(block.segments[i]!.node))) {
          undo(block); owned.blocks.delete(element);
        }
      }
    });
    state.observer.observe(document.body, {subtree: true, childList: true, characterData: true});
  }

  const current = state;

  const createOutput = () => {
    const output = document.createElement('span');
    output.dataset.bysTranslation = 'true';
    output.lang = current.language === '简体中文' ? 'zh-CN' : current.language;
    output.style.cssText = 'display:block;white-space:pre-wrap;line-height:1.6;margin-block:0.35em 0.65em;overflow-wrap:anywhere;text-align:inherit;';

    if (current.fontFamily === 'songti') output.style.fontFamily = songti;

    if (current.fontSize) output.style.fontSize = `${current.fontSize}px`;

    return output;
  };

  const render = (block: Block) => {

    if (!sourceValid(block)) { undo(block); current.blocks.delete(block.element);

      return; }

    if (!block.segments.every(s => s.translation !== undefined)) return;
    mutated = true;
    unmark(block);
    removeOutput(block);

    // A mixed container owns only its direct/inline text, not the independent child
    // paragraphs, images or controls between it. Cover each original Text node locally.
    const mixed = block.element.querySelector('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,dt,dd,div,section,article,main,pre,code,img,button,input,textarea,select,iframe,canvas,svg');

    if (current.mode === 'translated' && mixed) {
      const releases: Array<() => void> = [];
      block.outputs = [];
      block.cleanup = () => { for (const release of releases.reverse()) release(); };


      for (const segment of block.segments) {
        const host = document.createElement('span');
        host.dataset.bysVellumHost = 'true';
        host.style.cssText = 'display:inline-block;position:relative;vertical-align:baseline;max-width:100%;white-space:pre-wrap;';
        segment.node.before(host);
        host.append(segment.node);
        const output = createOutput();
        output.textContent = segment.translation!;
        host.append(output);
        block.outputs.push(output);
        let unmount: (() => void) | undefined;
        releases.push(() => {
          unmount?.();
          output.remove();
          // Unwrap the current contents, not a saved copy: preserve website edits,
          // insertions and moves made after translation, even in a detached subtree.
          const parent = host.parentNode;

          if (!parent) return;

          while (host.firstChild) parent.insertBefore(host.firstChild, host);
          host.remove();
        });
        unmount = world.__bysMountVellum!(host, output);
      }

      return;
    }

    const output = createOutput();

    for (const segment of block.segments) {
      const anchor = segment.node.parentElement?.closest('a');

      if (anchor && anchor !== block.element && /^(https?:|mailto:|tel:)/i.test(anchor.href)) {
        const link = document.createElement('a'); link.href = anchor.href;
        link.target = anchor.target; link.rel = anchor.rel;
        // Normal clicks reach the original link, including the website's event handlers.
        // Modified clicks retain the browser's usual open-in-new-tab behavior.

        if (current.mode === 'translated') link.addEventListener('click', event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          event.preventDefault(); event.stopPropagation(); anchor.click();
        });

        if (current.fontFamily === 'songti') link.style.setProperty('font-family', 'inherit', 'important');
        link.textContent = segment.translation!; output.append(link);
      } else output.append(document.createTextNode(segment.translation!));
    }

    block.element.append(output); block.output = output;

    if (current.mode === 'translated') block.cleanup = world.__bysMountVellum!(block.element, output);
  };

  if (command.mode || command.fontSize !== undefined || command.fontFamily !== undefined) {
    if (command.fontFamily) current.fontFamily = command.fontFamily;

    if (command.mode) current.mode = command.mode;

    if (command.fontSize !== undefined) current.fontSize = command.fontSize;

    for (const block of current.blocks.values()) if (block.segments.every(s => s.translation !== undefined)) render(block);
  }

  if (command.action === 'apply') {
    const translations = new Map(command.translations!.map(t => [t.id, t.text]));
    const affected = [...current.blocks.values()].filter(b => b.segments.some(s => translations.has(s.id)));

    if (translations.size !== command.translations!.length) throw new Error('译文段落标识重复，未写入页面。');
    // A live page can replace one paragraph while the model translates. Apply only
    // complete, unchanged paragraphs; collect will pick up new source text next.
    const unchanged = affected.filter(b => sourceValid(b) && b.segments.every(s => translations.has(s.id)));

    for (const block of unchanged) {
      for (const s of block.segments) s.translation = translations.get(s.id)!;
      render(block);
      applied++;
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

    if (block && (block.segments.length !== nodes.length || block.segments.some((s, i) => s.node !== nodes[i] || s.node.data !== s.original))) {
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
    const distance = (el: HTMLElement) => { const r = el.getBoundingClientRect();

 return r.bottom >= 0 && r.top < innerHeight ? 0 : Math.abs(r.top); };

    return distance(a.element) - distance(b.element);
  });

  if (command.action === 'begin' || command.action === 'collect' || command.action === 'apply') {
    // A paragraph waiting for its translation shows a quiet placeholder where the text will land.
    if (command.action !== 'apply') for (const block of pending) {
      if (block.pendingMark?.isConnected) continue;

      if (!document.getElementById('sideagent-translation-style')) {
        const style = document.createElement('style'); style.id = 'sideagent-translation-style';
        style.textContent = '@keyframes sideagent-translation-wait{from{background-position:200% 0}to{background-position:0 0}}@media (prefers-reduced-motion:reduce){[data-bys-translation="pending"]{animation:none!important}}';
        (document.head ?? document.documentElement).append(style);
      }

      const mark = document.createElement('span');
      mark.dataset.bysTranslation = 'pending'; mark.setAttribute('aria-hidden', 'true');
      mark.style.cssText = 'display:block;height:0.6em;width:min(78%,36em);margin-block:0.45em 0.55em;border-radius:999px;background:linear-gradient(90deg,rgba(107,140,199,.22),rgba(107,140,199,.07),rgba(107,140,199,.22));background-size:200% 100%;animation:sideagent-translation-wait 1.4s linear infinite;pointer-events:none;';
      block.element.append(mark); block.pendingMark = mark; mutated = true;
    }

    // If the run dies without settling, marks must not stay forever; the agent itself gives up after 180 s idle.
    clearTimeout(current.markTimer);
    const owned = current;
    current.markTimer = setTimeout(() => {
      for (const b of owned.blocks.values()) { b.pendingMark?.remove(); b.pendingMark = undefined; }
    }, 185_000);
  }

  const blocks: TranslationReceipt['blocks'] = [];
  let chars = 0, segments = 0;

  const busy = new Set(command.exclude ?? []);

  if (command.action === 'collect') for (const block of pending) {
    if (busy.has(block.id)) continue;
    const size = block.segments.reduce((n, s) => n + s.original.length, 0);

    if (blocks.length && (blocks.length >= (command.maxBlocks ?? 8) || chars + size > 3000 || segments + block.segments.length > 24)) break;
    blocks.push({id: block.id, segments: block.segments.map(s => ({id: s.id, text: s.original}))});
    chars += size; segments += block.segments.length;
  }

  const receipt: Omit<TranslationReceipt, 'tabId'> = {document: current.token, language: current.language, mode: current.mode, fontSize: current.fontSize,
    translated: current.blocks.size - pending.length, remaining: pending.length, unsupported, blocks};

  if (command.action === 'apply') receipt.applied = applied;

  return receipt;
  } catch (error) {
    // Chrome omits a thrown injection's result. Return an explicit receipt instead.
    return {error: error instanceof Error ? error.message : String(error), executionFact: mutated ? 'unknown' : 'not_executed'};
  }
}
