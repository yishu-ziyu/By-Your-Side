/**
 * 划词时交给阅读卡的上下文：所在小节标题，加选区前后看得见的正文。
 * 很多网站的正文不放在 p/li 里（div、span 排版，或跨段选中），只认段落标签会拿到空上下文，回答就只能看着选中的几个字猜。
 * 从选区两端沿文档顺序往外取文字节点，取够就停：不读整页，也不靠搜索文字定位（重复的句子会定位错）。
 * 这段也会按源码注入验收探针，必须自包含，不能引用模块作用域。
 */
export function selectionSurrounding(range: Range, text: string, limit: number): string {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  // 草稿、输入框、隐藏内容都不是页面在讲的东西：可编辑区里是用户还没发出的字。
  const skip = (el: Element | null): boolean => !el
    || !!el.closest('input,textarea,select,script,style,noscript,template,nav,[role="navigation"],[contenteditable]:not([contenteditable="false"]),[aria-hidden="true"]')
    || !el.checkVisibility();
  const start = range.startContainer, end = range.endContainer;
  const startEl = start instanceof Element ? start : start.parentElement;

  if (skip(startEl)) return '';

  const rootNode = range.commonAncestorContainer.getRootNode();
  const root = rootNode instanceof Document ? rootNode.body : rootNode;

  if (!root) return '';

  const picked = squash(text);
  const quote = picked.length > limit / 3 ? `${picked.slice(0, Math.floor(limit / 3))}…` : picked;
  const side = Math.floor((limit - quote.length) / 2);
  // 隐藏节点多的页面也不能一直走下去。
  const MAX_NODES = 3000;

  const collect = (forward: boolean): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const edge = forward ? end : start;
    const parts: string[] = [];
    let size = 0;

    if (edge.nodeType === Node.TEXT_NODE) {
      walker.currentNode = edge;
      const own = edge.nodeValue ?? '';
      const piece = forward ? own.slice(range.endOffset) : own.slice(0, range.startOffset);
      if (piece.trim()) { parts.push(piece); size += piece.length; }
    } else {
      // 选区端点落在元素上：从那个位置旁边的子节点开始走。
      walker.currentNode = edge.childNodes[forward ? range.endOffset : range.startOffset - 1] ?? edge;
    }

    let lastParent: Element | null = null;
    for (let n = 0; size < side && n < MAX_NODES; n++) {
      const node = forward ? walker.nextNode() : walker.previousNode();
      if (!node) break;
      const parent = node.parentElement;
      const value = node.nodeValue ?? '';
      if (!value.trim() || skip(parent)) continue;
      // 换了元素就隔一个空格，免得两段字粘在一起。
      parts.push(parent !== lastParent ? ` ${value} ` : value);
      lastParent = parent;
      size += value.length + 2;
    }

    const joined = squash((forward ? parts : parts.reverse()).join(''));

    return forward ? joined.slice(0, side) : joined.slice(Math.max(0, joined.length - side));
  };

  const before = collect(false);
  const after = collect(true);

  // 所在小节：文档顺序上在选区之前、看得见的最后一个标题。
  let heading = '';
  for (const h of (root as ParentNode).querySelectorAll('h1,h2,h3,h4')) {
    if (!(h.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING) && !h.contains(start)) break;
    if (!skip(h)) heading = squash(h.textContent ?? '');
  }
  const head = heading && !before.includes(heading) ? `小节：${heading.slice(0, 120)}\n` : '';

  return (head + squash(`${before} ${quote} ${after}`)).slice(0, limit);
}
