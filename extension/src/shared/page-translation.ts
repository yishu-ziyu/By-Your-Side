import type { TranslationCommand, TranslationReceipt, TranslationMode, TranslationFont, TranslationPageResult } from '../../../shared/page-translation.js';

export function translationInPage(command: TranslationCommand): TranslationPageResult {
  let mutated = false;
  let applied = 0;

  try {
  type Segment = {id: string; node: Text; original: string; translation?: string};

  type FontOverride = {element: HTMLElement; value: string; priority: string; hadStyle: boolean; applied: string};

  type Block = {pendingMark?: HTMLElement; families?: FontOverride[]; hadStyles?: Map<HTMLElement, boolean>; id: string; element: HTMLElement; segments: Segment[]; output?: HTMLElement; font?: {value: string; priority: string; hadStyle: boolean; applied: string}};

  type ParagraphAuthority = {
    body: HTMLElement; root: Element; ordinals: Set<number>;
    candidates?: Map<Element, HTMLParagraphElement[]>;
  };

  type Scope = { url: string; targets: Map<HTMLElement, Array<{ node: Text; original: string }>>; authority?: ParagraphAuthority };

  type State = {
    scope?: Scope;
    token: string; url: string; language: string; mode: TranslationMode; fontSize: number | null; fontFamily: TranslationFont;
    next: number; blocks: Map<HTMLElement, Block>; observer: MutationObserver;
    restore: () => void; markTimer?: ReturnType<typeof setTimeout>;
  };

  const documentUrl = () => { const url = new URL(location.href); url.hash = '';

 return url.href; };

  const world = globalThis as typeof globalThis & {__bysTranslation?: State};
  let state = world.__bysTranslation;

  const readParagraphs = (root: HTMLElement = document.body) => {
    const excluded = 'script,style,noscript,textarea,input,select,button,pre,code,svg,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-bys-translation],[hidden],[aria-hidden="true"],[id^="__sideagent"],[id^="sideagent-"]';
    const groups = new Map<HTMLElement, Text[]>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;

    while ((node = walker.nextNode())) {
      const text = node as Text, parent = text.parentElement;

      if (!parent || !text.data.length || parent.closest(excluded)) continue;
      const element = (parent.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption,dt,dd,div,section,article,main') ?? parent) as HTMLElement;

      if (parent.getClientRects().length === 0 || getComputedStyle(parent).visibility === 'hidden') continue;
      const list = groups.get(element) ?? []; list.push(text); groups.set(element, list);
    }

    for (const [element, nodes] of groups) if (!nodes.some(node => /\p{L}/u.test(node.data))) groups.delete(element);

    return groups;
  };

  const tooLarge = (nodes: Text[]) => nodes.length > 64 || nodes.reduce((n, s) => n + s.length, 0) > 12000;

  const fromViewport = (el: HTMLElement) => { const r = el.getBoundingClientRect();

 return r.bottom >= 0 && r.top < innerHeight ? 0 : Math.abs(r.top); };

  if (command.action === 'peek') {
    const found: TranslationReceipt['blocks'] = [];

    if (state && state.url === documentUrl()) {
      const done = [...state.blocks.values()].filter(b => b.segments.every(s => s.translation !== undefined)).length;

      return {document: state.token, language: state.language, mode: state.mode, fontSize: state.fontSize, fontFamily: state.fontFamily, translated: done, remaining: state.blocks.size - done, unsupported: 0, blocks: []};
    }

    if (!state) {
      const paragraphs = [...readParagraphs()].filter(([, nodes]) => !tooLarge(nodes)).sort(([a], [b]) => fromViewport(a) - fromViewport(b));

      for (const [, nodes] of paragraphs.slice(0, command.maxBlocks ?? 8)) {
        const id = String(found.length + 1);
        found.push({id, segments: nodes.map((node, i) => ({id: `${id}:${i}`, text: node.data}))});
      }
    }

    return {document: '', language: command.language ?? '简体中文', mode: 'bilingual', fontSize: null, fontFamily: 'original', translated: 0, remaining: found.length, unsupported: 0, blocks: found};
  }

  const stale = state && state.url !== documentUrl();
  const constrained = command.scope?.paragraphs !== undefined;
  const restoreStale = () => { if (state && stale) { mutated = true; state.restore(); delete world.__bysTranslation; state = undefined; } };
  const checkDocument = () => {
    if (!constrained) restoreStale();
    if (command.document && (stale || command.document !== state?.token)) throw new Error('网页已变化，这批译文未写入。请在当前页面重新翻译。');
  };
  checkDocument();
  const songti = '"Songti SC", "STSong", "SimSun", serif';

  const restoreFamily = (block: Block) => {
    for (const saved of block.families ?? []) {
      if (saved.element.style.fontFamily !== saved.applied) continue;
      mutated = true;

      if (saved.value) saved.element.style.setProperty('font-family', saved.value, saved.priority);
      else saved.element.style.removeProperty('font-family');
      const style = saved.element.getAttribute('style');

      if (!saved.hadStyle && style !== null && !style.trim()) saved.element.removeAttribute('style');
    }

    block.families = undefined;
    block.hadStyles = undefined;
  };

  const restoreFont = (block: Block) => {
    if (!block.font) { restoreFamily(block);

 return; }

    const currentStyle = block.element.getAttribute('style');

    if (block.element.style.fontSize === block.font.applied) {
      mutated = true;

      if (!block.font.hadStyle && currentStyle !== null && block.element.style.length === 1) block.element.removeAttribute('style');
      else block.element.style.setProperty('font-size', block.font.value, block.font.priority);
    }

    block.font = undefined;
    restoreFamily(block);
  };

  const unmark = (block: Block) => { if (block.pendingMark) { mutated = true; block.pendingMark.remove(); block.pendingMark = undefined; } };

  const undo = (block: Block) => {
    unmark(block);

    if (block.output || block.segments.some(s => s.translation !== undefined && s.node.data === s.translation)) mutated = true;

    for (const s of block.segments) if (s.translation !== undefined && s.node.data === s.translation) s.node.data = s.original;
    block.output?.remove();
    block.output = undefined;
    restoreFont(block);
  };

  const clear = () => { if (state?.blocks.size) mutated = true; state?.restore(); delete world.__bysTranslation; };

  const dropManual = () => { for (const el of document.querySelectorAll('[data-bys-translation="manual"]')) { el.remove(); mutated = true; } };

  if (command.action === 'restore') {
    clear(); dropManual();

    return {document: '', language: '', mode: 'bilingual', fontSize: null, fontFamily: 'original', translated: 0, remaining: 0, unsupported: 0, blocks: []};
  }

  if (command.action === 'settle') {
    if (state && (!command.document || command.document === state.token)) {
      clearTimeout(state.markTimer);
      const owned = state;
      const release = () => { for (const b of owned.blocks.values()) { b.pendingMark?.remove(); b.pendingMark = undefined; } };

      if (command.delayMs) owned.markTimer = setTimeout(release, command.delayMs);
      else { for (const b of owned.blocks.values()) unmark(b); }
    }

    return {document: state?.token ?? '', language: state?.language ?? '', mode: state?.mode ?? 'bilingual', fontSize: state?.fontSize ?? null, fontFamily: state?.fontFamily ?? 'original', translated: 0, remaining: 0, unsupported: 0, blocks: []};
  }

  const original = (element: HTMLElement, node: Text, index: number) => {
    const segment = state?.blocks.get(element)?.segments[index];
    return segment?.node === node && node.data === (state?.mode === 'translated' ? segment.translation ?? segment.original : segment.original) ? segment.original : node.data;
  };

  const paragraphRoot = (element: HTMLElement) => {
    if (element.tagName !== 'P' || element.closest('nav,aside,footer,header,[role="navigation"],[role="complementary"],[role="contentinfo"],[role="banner"]')) return;
    const parent = element.parentElement;
    const root = parent?.closest('article,[role="article"]') ?? parent?.closest('main,[role="main"]');
    return root && document.body.contains(root) ? root : undefined;
  };

  const paragraphCandidates = () => {
    const candidates = new Map<Element, HTMLParagraphElement[]>();
    for (const element of document.body.querySelectorAll('p')) {
      const root = paragraphRoot(element);
      if (!root) continue;
      const group = candidates.get(root);
      if (group) group.push(element);
      else candidates.set(root, [element]);
    }
    return candidates;
  };

  const paragraphMismatch = () => new Error('原文段落与授权序号不符，或正文范围不唯一，未写入译文。');

  const verifyParagraphAuthority = (scope: Scope, readNodes: (element: HTMLElement) => Text[] | undefined) => {
    const authority = scope.authority;
    if (!authority) return;
    if (authority.body !== document.body || !authority.root.isConnected) throw paragraphMismatch();
    const candidates = authority.candidates ??= paragraphCandidates();
    const isBodyParagraph = (element: HTMLElement) => element.checkVisibility({opacityProperty: true, visibilityProperty: true}) &&
      readNodes(element)?.some((node, index) => !node.parentElement?.closest('a,[role="link"]') && /[\p{L}\p{N}]/u.test(original(element, node, index)));

    for (const [root, elements] of candidates) {
      if (root !== authority.root && elements.some(isBodyParagraph)) throw paragraphMismatch();
    }

    let ordinal = 0, matched = 0;
    for (const element of candidates.get(authority.root) ?? []) {
      if (!isBodyParagraph(element) || !authority.ordinals.has(++ordinal)) continue;
      if (!scope.targets.has(element)) throw paragraphMismatch();
      if (++matched === authority.ordinals.size) return;
    }
    throw paragraphMismatch();
  };

  const resolveScope = () => {
    if (!command.scope) return undefined;
    if (new URL(command.scope.url).href !== location.href) throw new Error('原文对应的网址已变化，未翻译页面。');
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const groups = readParagraphs();
    const paragraphs = [...groups].map(([element, nodes]) => ({
      element, nodes, text: normalize(nodes.map((node, index) => original(element, node, index)).join('')),
    }));
    const scope: Scope = { url: location.href, targets: new Map() };

    for (const quote of command.scope.quotes) {
      const matches = paragraphs.filter(p => p.text.includes(normalize(quote)));
      if (matches.length !== 1) throw new Error('原文摘录没有唯一对应的段落，请核对原文，未翻译页面。');
      const { element, nodes } = matches[0]!;
      if (tooLarge(nodes) || scope.targets.has(element)) throw new Error('请为每个可翻译的段落提供一条独立摘录，未翻译页面。');
      scope.targets.set(element, nodes.map((node, index) => ({ node, original: original(element, node, index) })));
    }

    if (state && !stale && (
      command.language && command.language !== state.language ||
      command.mode && command.mode !== state.mode ||
      command.fontSize !== undefined && command.fontSize !== state.fontSize ||
      command.fontFamily && command.fontFamily !== state.fontFamily
    )) throw new Error('局部翻译不能改动已有译文的语言或显示方式，请先还原译文。');

    return {scope, groups};
  };

  const prepareScope = () => {
    const resolved = resolveScope();
    if (!resolved) return;
    const {scope, groups} = resolved;
    const ordinals = command.scope?.paragraphs;
    if (!ordinals) return scope;
    const first = scope.targets.keys().next().value;
    const root = first && paragraphRoot(first);
    if (!root) throw paragraphMismatch();
    scope.authority = {body: document.body, root, ordinals: new Set(ordinals)};
    verifyParagraphAuthority(scope, element => groups.get(element));
    restoreStale();
    return scope;
  };
  const scope = prepareScope();
  if (command.action === 'begin' && !scope) dropManual();

  if (command.action === 'begin' && state && command.language && state.language !== command.language) { clear(); state = undefined; }

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
    state.observer = new MutationObserver(records => {
      if (owned.url !== documentUrl()) { owned.restore();

 if (world.__bysTranslation === owned) delete world.__bysTranslation;

 return; }

      const authority = owned.scope?.authority;
      const containsParagraph = (node: Node) => node instanceof Element && (node.matches('p') || !!node.querySelector('p'));
      if (authority && records.some(record => record.type === 'attributes' ||
        [...record.addedNodes, ...record.removedNodes].some(containsParagraph))) authority.candidates = undefined;

      for (const [element, block] of owned.blocks) {
        if (!element.isConnected || block.segments.some(s => !s.node.isConnected || !element.contains(s.node) || s.node.data !== (owned.mode === 'translated' ? s.translation ?? s.original : s.original)) || (owned.mode === 'bilingual' && !!block.output && !block.output.isConnected)) {
          undo(block); owned.blocks.delete(element);
        }
      }
    });
    state.observer.observe(document.body, {subtree: true, childList: true, characterData: true});
  }

  const current = state;

  const bindScope = () => {
    if (!current.scope) return;
    if (current.scope.url !== location.href) throw new Error('原文对应的网址已变化，未写入译文。');
    const groups = new Map<HTMLElement, Text[]>();
    for (const [element, saved] of current.scope.targets) {
      const nodes = readParagraphs(element).get(element);
      if (!nodes || nodes.length !== saved.length || saved.some((s, i) => s.node !== nodes[i] || original(element, s.node, i) !== s.original)) throw new Error('原文段落已变化，未写入译文。');
      groups.set(element, nodes);
    }

    if (command.action !== 'begin') verifyParagraphAuthority(current.scope, element => groups.get(element) ?? readParagraphs(element).get(element));
    return groups;
  };
  const startScope = () => {
    if (command.action !== 'begin') return;
    if (scope || current.scope) current.token = crypto.randomUUID();
    const numbered = Boolean(scope?.authority);
    if (numbered !== Boolean(current.scope?.authority)) {
      current.observer.disconnect();
      current.observer.observe(numbered ? document.documentElement : document.body, {
        subtree: true, childList: true, characterData: true, ...(numbered && {attributeFilter: ['role']}),
      });
    }
    current.scope = scope;
  };
  startScope();
  const scopedGroups = bindScope();
  const inScope = (element: HTMLElement) => current.scope?.targets.has(element) ?? true;

  const hadStyleBeforeTypography = (block: Block, element: HTMLElement) => {
    block.hadStyles ??= new Map();

    if (!block.hadStyles.has(element)) block.hadStyles.set(element, element.hasAttribute('style'));

    return block.hadStyles.get(element)!;
  };

  const render = (block: Block) => {
    mutated = true;

    if (block.segments.every(s => s.translation !== undefined)) unmark(block);
    block.output?.remove(); block.output = undefined;

    for (const segment of block.segments) segment.node.data = current.mode === 'translated' ? segment.translation ?? segment.original : segment.original;

    if (current.mode === 'bilingual') {
      restoreFont(block);

      if (!block.segments.every(s => s.translation !== undefined)) return;
      const output = document.createElement('span');
      output.dataset.bysTranslation = 'true';
      output.lang = current.language === '简体中文' ? 'zh-CN' : current.language;
      output.style.cssText = 'display:block;white-space:pre-wrap;line-height:1.6;margin-block:0.35em 0.65em;overflow-wrap:anywhere;text-align:inherit;';

      if (current.fontFamily === 'songti') output.style.fontFamily = songti;

      if (current.fontSize) output.style.fontSize = `${current.fontSize}px`;

      for (const segment of block.segments) {
        const anchor = segment.node.parentElement?.closest('a');

        if (anchor && anchor !== block.element && /^(https?:|mailto:|tel:)/i.test(anchor.href)) {
          const link = document.createElement('a'); link.href = anchor.href;
          link.target = anchor.target; link.rel = anchor.rel;

          if (current.fontFamily === 'songti') link.style.setProperty('font-family', 'inherit', 'important');
          link.textContent = segment.translation!; output.append(link);
        } else output.append(document.createTextNode(segment.translation!));
      }

      block.element.append(output); block.output = output;
    } else if (current.fontSize) {
      block.font ??= {value: block.element.style.getPropertyValue('font-size'), priority: block.element.style.getPropertyPriority('font-size'), hadStyle: hadStyleBeforeTypography(block, block.element), applied: `${current.fontSize}px`};
      block.element.style.setProperty('font-size', `${current.fontSize}px`);
    }

    if (current.mode === 'translated' && current.fontFamily === 'songti' && !block.families) {
      const elements = new Set([block.element, ...block.segments.map(s => s.node.parentElement!).filter(Boolean)]);
      block.families = [...elements].map(element => ({element, value: element.style.getPropertyValue('font-family'), priority: element.style.getPropertyPriority('font-family'), hadStyle: hadStyleBeforeTypography(block, element), applied: ''}));

      for (const saved of block.families) {
        saved.element.style.setProperty('font-family', songti, 'important');
        saved.applied = saved.element.style.fontFamily;
      }
    }
  };

  const applyDisplay = () => {
    if (scope || (!command.mode && command.fontSize === undefined && command.fontFamily === undefined)) return;
    if (current.scope && [...current.blocks.values()].some(b => !inScope(b.element) && b.segments.some(s => s.translation !== undefined))) {
      const changes = (command.mode !== undefined && command.mode !== current.mode)
        || (command.fontSize !== undefined && command.fontSize !== current.fontSize)
        || (command.fontFamily !== undefined && command.fontFamily !== current.fontFamily);
      if (changes) throw new Error('页面上还有其他范围的译文，无法只切换当前几段的显示方式。');
      return;
    }
    for (const block of current.blocks.values()) restoreFont(block);

    if (command.fontFamily) current.fontFamily = command.fontFamily;

    if (command.mode) current.mode = command.mode;

    if (command.fontSize !== undefined) current.fontSize = command.fontSize;

    for (const block of current.blocks.values()) if (block.segments.every(s => s.translation !== undefined)) render(block);
  };
  applyDisplay();

  if (command.action === 'apply') {
    const translations = new Map(command.translations!.map(t => [t.id, t.text]));
    const affected = [...current.blocks.values()].filter(b => inScope(b.element) && b.segments.some(s => translations.has(s.id)));

    if (translations.size !== command.translations!.length) throw new Error('译文段落标识重复，未写入页面。');
    const unchanged = affected.filter(b => b.element.isConnected && b.segments.every(s => translations.has(s.id) && s.node.isConnected && b.element.contains(s.node) && s.node.data === (current.mode === 'translated' ? s.translation ?? s.original : s.original)));

    for (const block of unchanged) {
      for (const s of block.segments) s.translation = translations.get(s.id)!;
      render(block);
      applied++;
    }
  }

  const groups = scopedGroups ?? readParagraphs();
  let unsupported = 0;

  for (const [element, nodes] of groups) {
    if (!inScope(element)) continue;
    let block = current.blocks.get(element);

    if (block && (block.segments.length !== nodes.length || block.segments.some((s, i) => s.node !== nodes[i] || s.node.data !== (current.mode === 'translated' ? s.translation ?? s.original : s.original)))) {
      undo(block); current.blocks.delete(element); block = undefined;
    }

    if (block) continue;

    if (tooLarge(nodes)) { unsupported++; continue; }

    const id = String(++current.next);
    current.blocks.set(element, {id, element, segments: nodes.map((node, i) => ({id: `${id}:${i}`, node, original: node.data}))});
  }

  for (const [element, block] of current.blocks) if (inScope(element) && !groups.has(element)) { undo(block); current.blocks.delete(element); }

  const eligible = [...current.blocks.values()].filter(b => inScope(b.element));
  const pending = eligible.filter(b => !b.segments.every(s => s.translation !== undefined));
  pending.sort((a, b) => fromViewport(a.element) - fromViewport(b.element));

  if (command.action === 'begin' || command.action === 'collect' || command.action === 'apply') {
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

  const receipt: Omit<TranslationReceipt, 'tabId'> = {document: current.token, language: current.language, mode: current.mode, fontSize: current.fontSize, fontFamily: current.fontFamily,
    translated: eligible.length - pending.length, remaining: pending.length, unsupported, blocks};

  if (command.action === 'apply') receipt.applied = applied;

  return receipt;
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error), executionFact: mutated ? 'unknown' : 'not_executed'};
  }
}
