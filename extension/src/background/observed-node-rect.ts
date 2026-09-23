/**
 * Chromium 私有的 scrollIntoViewIfNeeded 没有 lib.dom 类型；这里只声明本函数真正会传的
 * 两个对齐参数，语义与标准 scrollIntoView 的 block/inline 一致。
 */
type ScrollAlignOptions = { block?: string; inline?: string };

/** Serialized into the observed node's realm via CDP. Keep this function self-contained. */
export function observedNodeRect(this: Node, contentOnly = false) {
  if (!this.isConnected) throw new Error('节点已离开文档，请重新 snapshot');
  const el = this.nodeType === 3 ? this.parentElement : this as Element;

  if (!el || typeof el.scrollIntoView !== 'function') throw new Error('节点没有可见元素');

  if (contentOnly && this.nodeType !== 3 && (el === document.body || el === document.documentElement)) {
    throw new Error('请定位具体内容元素，不能用整页作为标注目标');
  }

  const scrollable = el as Element & {scrollIntoViewIfNeeded?: (options: ScrollAlignOptions) => void};

  if (typeof scrollable.scrollIntoViewIfNeeded === 'function') scrollable.scrollIntoViewIfNeeded({block:'center',inline:'center'});
  else el.scrollIntoView({block:'center',inline:'center'});
  let r: DOMRect;

  if (this.nodeType === 3) {
    const range = document.createRange();
    range.selectNodeContents(this);
    r = range.getBoundingClientRect();
  } else r = el.getBoundingClientRect();

  if (r.width === 0 || r.height === 0) throw new Error('元素不可见（零尺寸）');
  let x = r.x;
  let y = r.y;
  let win: Window | null = el.ownerDocument.defaultView;

  while (win && win !== win.top) {
    const frame = win.frameElement as Element | null;

    if (!frame) break;
    const fr = frame.getBoundingClientRect();
    x += fr.x;
    y += fr.y;
    win = win.parent;
  }

  return {x,y,width:r.width,height:r.height};
}
