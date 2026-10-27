/**
 * 划词时交给阅读卡的上下文：选中处前后的正文，加上它所在小节的标题。
 * 很多网站的正文不放在 p/li 里（div、span 排版，或跨段选中），只认段落标签会拿到空上下文，回答就只能看着选中的几个字猜。
 * 这段也会按源码注入验收探针，必须自包含，不能引用模块作用域。
 */
export function selectionSurrounding(range: Range, text: string, limit: number): string {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const editable = (el: Element) => !!el.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""]');
  const want = squash(text);
  const node = range.commonAncestorContainer;
  let el: Element | null = node instanceof Element ? node : node.parentElement;

  if (!el || editable(el)) return '';

  // 往上找到正文够多的那一层；到 body 就停在它下面一层，免得每次划词都把整页文字读一遍。
  for (let level = 0; level < 12; level++) {
    const parent: Element | null = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    // 量长度用 textContent：不触发排版，松开鼠标就会调用这里。
    if ((el.textContent ?? '').length >= want.length + limit) break;
    el = parent;
  }

  // 输入框的值本来不在 innerText 里；可编辑区（草稿、评论框）在，要去掉：那是用户还没发出的字，不是页面内容。
  let full = squash((el as HTMLElement).innerText ?? el.textContent ?? '');
  for (const draft of el.querySelectorAll('[contenteditable="true"],[contenteditable=""]')) {
    const typed = squash((draft as HTMLElement).innerText ?? '');
    if (typed) full = full.split(typed).join(' ');
  }
  const at = full.indexOf(want.slice(0, 60));
  const side = Math.max(0, Math.floor((limit - Math.min(want.length, limit / 3)) / 2));
  const start = at < 0 ? 0 : Math.max(0, at - side);
  const end = at < 0 ? limit : Math.min(full.length, at + want.length + side);
  const body = full.slice(start, end);

  // 所在小节：文档顺序上在选区之前的最后一个标题。
  let heading = '';
  for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
    if (h.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING || h.contains(range.startContainer)) heading = squash((h as HTMLElement).innerText ?? h.textContent ?? '');
    else break;
  }
  const head = heading && !body.includes(heading) ? `小节：${heading.slice(0, 120)}\n` : '';

  return (head + body).slice(0, limit);
}
