export const FLOAT_CARD_KEY = "float_card";

export const FLOAT_CARD_WHERE = "float_card_where";

export const FLOAT_CARD_TO_PANEL = "float_card_to_panel";

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
