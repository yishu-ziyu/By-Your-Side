/**
 * Overlay host 标识与几何：content script 与单测共用。
 * 扩展 reload 后旧 isolated world 销毁，但 DOM host 留在页面上——启动时按属性清掉。
 */

export const OVERLAY_ATTR = "data-sideagent-overlay";
export const OVERLAY_KIND_CURSOR = "cursor";
export const OVERLAY_KIND_MARKS = "marks";

export const HIGHLIGHT_PAD = 3;
export const MARK_PAD = 6;

export function overlayHostSelector(): string {
  return `[${OVERLAY_ATTR}]`;
}

/** 清掉页面上上一轮 content script 留下的 overlay host。返回移除数量。 */
export function sweepStaleOverlayHosts(root: {
  querySelectorAll: (selectors: string) => ArrayLike<{ remove: () => void }>;
}): number {
  const nodes = root.querySelectorAll(overlayHostSelector());
  const len = nodes.length;
  for (let i = 0; i < len; i++) nodes[i]!.remove();
  return len;
}

export function highlightBounds(
  rect: { x: number; y: number; width: number; height: number },
  pad = HIGHLIGHT_PAD,
): { left: number; top: number; width: number; height: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    left: Math.round(rect.x - pad),
    top: Math.round(rect.y - pad),
    width: Math.round(rect.width + pad * 2),
    height: Math.round(rect.height + pad * 2),
  };
}

/** 视口包围盒 → 文档坐标盒（absolute host 用）。resize/内部滚动后应拿元素最新 getBoundingClientRect 再算。 */
export function viewportRectToDocumentBox(
  rect: { x: number; y: number; width: number; height: number },
  scrollX: number,
  scrollY: number,
  pad = MARK_PAD,
): { x: number; y: number; width: number; height: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.x + scrollX) - pad,
    y: Math.round(rect.y + scrollY) - pad,
    width: Math.round(rect.width) + pad * 2,
    height: Math.round(rect.height) + pad * 2,
  };
}
