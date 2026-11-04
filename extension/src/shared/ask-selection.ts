import { READING_SELECTION_LIMIT } from "../../../shared/reading.js";

export const ASK_STORE = "pendingAsk";

const MIN_ASK_CHARS = 2;

const MAX_ASK_CHARS = READING_SELECTION_LIMIT;

export const ASK_MENU_ID = "ask-sideagent";

export const SELECTION_BAR_KEY = "sideagent_selection_bar";

export const READING_ALOUD_KEY = "reading_aloud";

export const READING_CARD_SIZE_KEY = "reading_card_size";

export interface ReadingCardSize {
  width: number;
  height: number;
}

export function readReadingCardSize(stored: unknown): ReadingCardSize | null {
  if (!stored || typeof stored !== "object") return null;

  const { width, height } = stored as Record<string, unknown>;

  if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 160) return null;

  return { width: Math.round(width), height: Math.round(height) };
}

export function isSelectionBarOff(stored: unknown): stored is false {
  return stored === false;
}

export function isReadingAloudOn(stored: unknown): stored is true {
  return stored === true;
}

export const EXPLAIN_PROMPT = "解释这段选中的文字。第一句用一句话写出结论，不要复述问题，不要写「解释如下」。再用读者能懂的话说它在主张什么。不要操作页面。";

export interface PendingAsk {
  element?: import("../../../shared/protocol.js").PageElementSource;
  conversationId?: string;
  text: string;
  tabId: number;
  title: string;
  url: string;
}

export function clipSelection(raw: string): string | null {
  const text = raw.trim();

  if (text.length < MIN_ASK_CHARS) return null;

  return text.length > MAX_ASK_CHARS ? text.slice(0, MAX_ASK_CHARS) : text;
}

export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  const node = el.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");

  return Boolean(node) || (el instanceof HTMLElement && el.isContentEditable);
}
