/**
 * 划词时交给阅读卡的上下文：所在小节标题，加选区前后看得见的正文。
 * 很多网站的正文不放在 p/li 里（div、span 排版，或跨段选中），只认段落标签会拿到空上下文，回答就只能看着选中的几个字猜。
 * 从选区两端沿文档顺序往外取文字节点，取够就停：不读整页，也不靠搜索文字定位（重复的句子会定位错）。
 * 只取文章范围内（article/main）看得见的字：草稿、隐藏内容、导航、侧栏里的账户信息都不是页面在讲的东西。
 * 这段也会按源码注入验收探针，必须自包含，不能引用模块作用域。
 */
export function selectionSurrounding(range: Range, text: string, limit: number): string {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const visible = (el: Element): boolean => el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    // display:contents 自己没有盒子，checkVisibility 说看不见，里面的字其实看得见。
    || (getComputedStyle(el).display === 'contents' && !!el.parentElement && visible(el.parentElement));
  const skip = (el: Element | null): boolean => !el
    || !!el.closest('input,textarea,select,script,style,noscript,template,nav,[role="navigation"],[contenteditable]:not([contenteditable="false"]),[aria-hidden="true"]')
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
  // 隐藏节点多的页面也不能一直走下去。
  const MAX_STEPS = 3000;
  const deepest = (n: Node): Node => { let d = n; while (d.lastChild) d = d.lastChild; return d; };
  const clip = (s: string, forward: boolean) => s.length <= side ? s : forward ? s.slice(0, side) : s.slice(s.length - side);

  /** 从选区一端往外走，只收选区外、看得见的文字节点。 */
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
      // 端点落在元素上：offset 是子节点下标。往回走从下标前那个子节点的最深处开始（含它），往后走从它之后开始。
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

  // 所在小节：往回找最近的标题，只念它看得见的字。
  let heading = '';
  const back = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
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

  return (head + squash(`${before} ${quote} ${after}`)).slice(0, limit);
}
