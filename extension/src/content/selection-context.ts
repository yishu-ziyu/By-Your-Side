export function selectionSurrounding(range: Range, text: string, limit: number): string {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const visible = (el: Element): boolean => el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    || ((style => style.display === 'contents' && style.visibility !== 'hidden' && style.opacity !== '0')(getComputedStyle(el)) && !!el.parentElement && visible(el.parentElement));
  const skip = (el: Element | null): boolean => !el
    || !!el.closest('input,textarea,select,script,style,noscript,template,nav,[role="navigation"],aside,[role="complementary"],[contenteditable]:not([contenteditable="false"]),[aria-hidden="true"]')
    || !visible(el);
  const start = range.startContainer, end = range.endContainer;
  const startEl = start instanceof Element ? start : start.parentElement;

  if (skip(startEl)) return '';

  const doc = start.ownerDocument ?? document;
  const shadow = range.commonAncestorContainer.getRootNode();
  const root: Node | null = startEl?.closest('article,main,[role="main"]') ?? (shadow instanceof ShadowRoot ? shadow : doc.body);

  if (!root) return '';

  const picked = squash(text);
  const quote = picked.length > limit / 3 ? `${picked.slice(0, Math.floor(limit / 3))}…` : picked;
  const side = Math.floor((limit - quote.length) / 2);
  const MAX_STEPS = 3000;
  const deepest = (n: Node): Node => { let d = n; while (d.lastChild) d = d.lastChild; return d; };
  const clip = (s: string, forward: boolean) => s.length <= side ? s : forward ? s.slice(0, side) : s.slice(s.length - side);

  const collect = (forward: boolean): string => {
    const edge = forward ? end : start;
    const offset = forward ? range.endOffset : range.startOffset;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let size = 0;

    const take = (node: Node, value: string) => {
      if (!value.trim() || skip(node.parentElement)) return;
      const piece = clip(value, forward);
      parts.push(` ${piece} `);
      size += piece.length;
    };

    if (edge.nodeType === Node.TEXT_NODE) {
      if (!root.contains(edge)) return '';
      walker.currentNode = edge;
      const own = edge.nodeValue ?? '';
      take(edge, forward ? own.slice(offset) : own.slice(0, offset));
    } else {
      const before = offset > 0 ? deepest(edge.childNodes[offset - 1]!) : edge;
      if (!root.contains(before)) return '';
      walker.currentNode = before;
      if (!forward && before !== edge && before.nodeType === Node.TEXT_NODE) take(before, before.nodeValue ?? '');
    }

    for (let n = 0; size < side && n < MAX_STEPS; n++) {
      const node = forward ? walker.nextNode() : walker.previousNode();
      if (!node) break;
      if (range.intersectsNode(node)) continue;
      take(node, node.nodeValue ?? '');
    }

    return clip(squash((forward ? parts : parts.reverse()).join('')), forward);
  };

  const before = collect(false);
  const after = collect(true);

  let heading = '';
  const back = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  back.currentNode = startEl!;
  for (let n = 0, node: Node | null = startEl; node && n < MAX_STEPS; n++, node = back.previousNode()) {
    const h = node instanceof Element ? node.closest('h1,h2,h3,h4') : null;
    if (!h || skip(h)) continue;
    const words = doc.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    const bits: string[] = [];
    for (let t = words.nextNode(); t; t = words.nextNode()) if (!skip(t.parentElement)) bits.push(t.nodeValue ?? '');
    heading = squash(bits.join(' '));
    if (heading) break;
  }
  const head = heading && !before.includes(heading) ? `小节：${heading.slice(0, 120)}\n` : '';

  return (head + squash(`${before} 【此处选中】${quote}【选中结束】 ${after}`)).slice(0, limit);
}
