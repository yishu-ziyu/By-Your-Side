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

/**
 * mark 的 target..through：两个节点围成一个 Range，框住同一行里从起点到终点的全部内容。
 * nodeRect 传 observedNodeRect（滚入视口、校验可见并折算 iframe 偏移）。
 * Serialized into the observed node's realm via CDP. Keep this function self-contained.
 */
export function observedNodeRange(
  this: Node,
  end: Node,
  nodeRect: (this: Node, contentOnly?: boolean) => {x: number; y: number; width: number; height: number},
) {
  if (!end?.isConnected || end.ownerDocument !== this.ownerDocument) throw new Error('through 必须和 target 在同一个页面里；请重新 snapshot');
  nodeRect.call(end, true);
  // 最后滚 target，框的位置以它为准；a 已含 iframe 偏移。
  const a = nodeRect.call(this, true);

  const localRect = (node: Node) => {
    if (node instanceof Element) return node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);

    return range.getBoundingClientRect();
  };

  const start = localRect(this);
  const stop = localRect(end);
  const lineOverlap = Math.min(start.bottom, stop.bottom) - Math.max(start.top, stop.top);

  if (lineOverlap < Math.min(start.height, stop.height) / 2) throw new Error('through 只能圈同一行里相邻的内容；不在同一行时分别标注');
  const forward = Boolean(this.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING);
  const range = document.createRange();
  range.setStartBefore(forward ? this : end);
  range.setEndAfter(forward ? end : this);
  const r = range.getBoundingClientRect();

  if (r.height > Math.max(start.height, stop.height) * 1.6) throw new Error('target 到 through 之间跨了多行；只圈同一行里相邻的内容');

  return {range, rect: {x: r.x + a.x - start.x, y: r.y + a.y - start.y, width: r.width, height: r.height}};
}
