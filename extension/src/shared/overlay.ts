export const OVERLAY_ATTR = "data-sideagent-overlay";

export const OVERLAY_KIND_CURSOR = "cursor";

export const OVERLAY_KIND_MARKS = "marks";

export const OVERLAY_KIND_EDGE_TAB = "edge-tab";

export const OVERLAY_KIND_PTT_CAPSULE = "ptt-capsule";

export const OVERLAY_KIND_SEND_CONFIRM = "send-confirm";

export const OVERLAY_KIND_PAY_STOP = "pay-stop";

export const OVERLAY_KIND_FLOAT_CARD = "float-card";

export const HIGHLIGHT_PAD = 3;

export const MARK_PAD = 6;

export function overlayHostSelector(): string {
  return `[${OVERLAY_ATTR}]`;
}

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
