/** Serialized into the observed node's realm via CDP. Keep this function self-contained. */
export function observedNodeRect(this: Node, contentOnly = false) {
  const node = this;
  if (!node.isConnected) throw new Error('节点已离开文档，请重新 snapshot');
  const el = node.nodeType === 3 ? node.parentElement : node as Element;
  if (!el || typeof el.scrollIntoView !== 'function') throw new Error('节点没有可见元素');
  if (contentOnly && node.nodeType !== 3 && (el === document.body || el === document.documentElement)) {
    throw new Error('请定位具体内容元素，不能用整页作为标注目标');
  }
  const scrollable = el as Element & {scrollIntoViewIfNeeded?: (options: object) => void};
  if (typeof scrollable.scrollIntoViewIfNeeded === 'function') scrollable.scrollIntoViewIfNeeded({block:'center',inline:'center'});
  else el.scrollIntoView({block:'center',inline:'center'});
  let r: DOMRect;
  if (node.nodeType === 3) {
    const range = document.createRange();
    range.selectNodeContents(node);
    r = range.getBoundingClientRect();
  } else r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) throw new Error('元素不可见（零尺寸）');
  return {x:r.x,y:r.y,width:r.width,height:r.height};
}
