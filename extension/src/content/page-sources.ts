import type { PageElementSource } from '../../../shared/protocol.js';

/** 编号（UUID v4 格式）。普通 http 网页不是安全上下文，没有 crypto.randomUUID；crypto.getRandomValues 在那里也可用。 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const documentToken = newId();

export const documentIdentity = () => ({ document: documentToken, url: location.href });

const targets = new Map<string, HTMLElement>();

const ids = new WeakMap<HTMLElement, string>();

const normalizeSourceText = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Read original nodes, not our translation sheet or editable fields. */
function sourceText(element: HTMLElement): string {
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

  if (!id) { id = newId(); ids.set(element, id); }

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
  const id = newId();
  selections.set(id, range.cloneRange());

  if (selections.size > 32) selections.delete(selections.keys().next().value!);
  const heading = start.closest('section,article')?.querySelector('h1,h2,h3')?.textContent;

  return { document: documentToken, id, url: location.href, title: (heading ?? document.title).trim().slice(0, 160), text, kind: 'selection' };
}

export function findUniqueSource(query: string): PageElementSource | null {
  const comparable = (text: string) => normalizeSourceText(text).replace(/[,，]/g, '').replace('％', '%').replace(/−/g, '-').replace(/^\+/, '');
  const numbers = (text: string) => (text.match(/[+−-]?\d[\d,]*(?:\.\d+)?(?:%|％|M|亿|万|元)?/g) ?? []).map(comparable);
  const needle = comparable(query);

  if (!needle || needle.length > 200) return null;
  const elements = Array.from(document.querySelectorAll<HTMLElement>('tr,p,li,pre,blockquote,h1,h2,h3'));

  if (elements.length > 5000) return null;
  const matches = elements.filter(element => comparable(element.textContent ?? '').includes(needle) && element.checkVisibility() && numbers(sourceText(element)).includes(needle));
  const leaves = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));

  // 同一段里写了两遍（“原价 2599，到手价 2599”）也不止一处。
  if (leaves.length) return leaves.length === 1 && numbers(sourceText(leaves[0]!)).filter(n => n === needle).length === 1 ? registerSource(leaves[0]!) : null;

  return uniqueNumberText(needle, numbers);
}

/** 文字节点最多看这么多个：大页面上找不到就算了，不卡住页面。 */
const MAX_TEXT_NODES = 20_000;

/**
 * 段落、列表、表格里没有时，看整页的文字：购物站的价格多半写在普通的 div、span 里。
 * 仍然要整页只有一处写着这个数（含不可见的不算），有两处就不认，不猜是哪一处。
 */
function uniqueNumberText(needle: string, numbers: (text: string) => string[]): PageElementSource | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let found: HTMLElement | null = null;
  let seen = 0;

  for (let node = walker.nextNode(); node; node = walker.nextNode(), seen += 1) {
    // 没看完整页就不能说只有一处。
    if (seen >= MAX_TEXT_NODES) return null;
    const parent = node.parentElement;

    if (!parent || parent.closest('[data-bys-translation],[data-bys-pending],script,style,noscript,input,textarea,[contenteditable]')) continue;
    const hits = numbers(node.textContent ?? '').filter(n => n === needle).length;

    if (!hits || !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;

    // 同一段字里写了两遍、或已经在别处见过，都不止一处。
    if (found || hits > 1) return null;
    found = parent;
  }

  return found ? registerSource(found) : null;
}
