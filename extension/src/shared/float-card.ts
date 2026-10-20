/** 浮在网页上的会话卡片：开没开、收没收起、看哪个会话、放在哪。存在 storage.local，所有标签页的内容脚本照着同一份显示。 */

export const FLOAT_CARD_KEY = "float_card";

/** 内容脚本问后台自己在哪个窗口（卡片里的会话页要知道去读哪个窗口的网页）。 */
export const FLOAT_CARD_WHERE = "float_card_where";

/** 卡片上的「回到侧栏」：必须在点击的这条消息里同步打开侧栏。 */
export const FLOAT_CARD_TO_PANEL = "float_card_to_panel";

/** right / top 是卡片右上角离视口右边、上边的距离，换了窗口大小也贴着同一边。 */
export interface FloatCardRect { right: number; top: number; width: number; height: number }

export interface FloatCardState {
  open: boolean;
  collapsed: boolean;
  conversation: string;
  rect: FloatCardRect;
}

export const FLOAT_CARD_DEFAULT_RECT: FloatCardRect = { right: 16, top: 72, width: 400, height: 620 };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readRect(raw: unknown): FloatCardRect {
  const r = raw as Partial<FloatCardRect> | null;

  return r && isNum(r.right) && isNum(r.top) && isNum(r.width) && isNum(r.height)
    ? { right: r.right, top: r.top, width: r.width, height: r.height }
    : FLOAT_CARD_DEFAULT_RECT;
}

export function readFloatCard(raw: unknown): FloatCardState | null {
  const s = raw as Partial<FloatCardState> | null;

  if (!s || typeof s !== "object" || typeof s.conversation !== "string") return null;

  return { open: s.open === true, collapsed: s.collapsed === true, conversation: s.conversation, rect: readRect(s.rect) };
}
