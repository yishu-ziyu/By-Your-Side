import type { PageElementSource } from '../../../shared/protocol.js';

const documentToken = crypto.randomUUID();

export const documentIdentity = () => ({ document: documentToken, url: location.href });

const targets = new Map<string, HTMLElement>();

const ids = new WeakMap<HTMLElement, string>();

export const normalizeSourceText = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Read original nodes, not our translation sheet or editable fields. */
export function sourceText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const pieces: string[] = [];
  let node: Node | null;
  let size = 0;

  while ((node = walker.nextNode())) {
    const parent = node.parentElement;

    if (parent?.closest('[data-bys-translation],[data-bys-pending],script,style,input,textarea,[contenteditable]')) continue;

    if (parent?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && getComputedStyle(parent).visibility !== 'hidden') { const text = node.textContent ?? ''; pieces.push(text); size += text.length; }

    if (size > 8000) return '';
  }

  return normalizeSourceText(pieces.join(' '));
}

function elementText(element: HTMLElement, kind: PageElementSource['kind']): string {
  if (!sourceText(element)) return '';

  const text = kind === 'table' ? Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element)
    .map(row => Array.from(row.querySelectorAll<HTMLElement>('th,td')).filter(cell => cell.closest('tr') === row).map(cell => sourceText(cell)).join(' | ')).join('\n') : sourceText(element);

  return text.length <= 8000 ? text : '';
}

export function registerSource(element: HTMLElement, kind: PageElementSource['kind'] = 'section'): PageElementSource | null {
  const text = elementText(element, kind);

  if (!text) return null;
  let id = ids.get(element);

  if (!id) { id = crypto.randomUUID(); ids.set(element, id); }

  targets.set(id, element);

  if (targets.size > 1000) {
    for (const [key, target] of targets) if (!target.isConnected) targets.delete(key);

    if (targets.size > 1000) targets.delete(targets.keys().next().value!);
  }

  return { document: documentToken, id, url: location.href, title: (element.getAttribute('aria-label') ?? element.querySelector('caption,h1,h2,h3')?.textContent ?? document.title).trim().slice(0, 160), text, kind };
}

export function resolveSource(source: PageElementSource): HTMLElement | null {
  if (source.document !== documentToken || source.url !== location.href) return null;

  if (source.kind === 'selection') {
    // 选段跨几段时没有一个够小的块可比：留住当时的选区本身（DOM 改动会随之更新），文字没变才认。
    const range = selections.get(source.id);
    const start = range?.startContainer;
    const element = start instanceof HTMLElement ? start : start?.parentElement;

    return range && element?.isConnected && normalizeSourceText(range.toString()) === source.text ? element : null;
  }

  const element = targets.get(source.id);

  return element?.isConnected && elementText(element, source.kind) === source.text ? element : null;
}

const selections = new Map<string, Range>();

/** 用户选中的一段文字：材料只是这段文字，标题取所在段落的标题或页面标题。 */
export function registerSelection(range: Range): PageElementSource | null {
  const text = normalizeSourceText(range.toString());
  const start = range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement;

  if (!text || text.length > 8000 || !start || start.closest('[data-bys-translation],[data-bys-pending],input,textarea,[contenteditable]')) return null;
  const id = crypto.randomUUID();
  selections.set(id, range.cloneRange());

  if (selections.size > 32) selections.delete(selections.keys().next().value!);
  const heading = start.closest('section,article')?.querySelector('h1,h2,h3')?.textContent;

  return { document: documentToken, id, url: location.href, title: (heading ?? document.title).trim().slice(0, 160), text, kind: 'selection' };
}

export function findUniqueSource(query: string): PageElementSource | null {
  const comparable = (text: string) => normalizeSourceText(text).replace(/[,，]/g, '').replace('％', '%').replace(/^\+/, '');
  const numbers = (text: string) => (text.match(/[+−-]?\d[\d,]*(?:\.\d+)?(?:%|％|M|亿|万|元)?/g) ?? []).map(comparable);
  const needle = comparable(query);

  if (!needle || needle.length > 200) return null;
  const elements = Array.from(document.querySelectorAll<HTMLElement>('tr,p,li,pre,blockquote,h1,h2,h3'));

  if (elements.length > 5000) return null;
  const matches = elements.filter(element => comparable(element.textContent ?? '').includes(needle) && element.checkVisibility() && numbers(sourceText(element)).includes(needle));
  const leaves = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));

  return leaves.length === 1 ? registerSource(leaves[0]!) : null;
}
