import { READING_SELECTION_LIMIT } from "../../../shared/reading.js";
/** 选中即问：划词文本裁剪与 session 交接。 */

export const ASK_STORE = "pendingAsk";
export const MIN_ASK_CHARS = 2;
export const MAX_ASK_CHARS = READING_SELECTION_LIMIT;
export const ASK_MENU_ID = "ask-sideagent";
export const EXPLAIN_PROMPT = "解释这段选中的文字。用读者能懂的话说它在主张什么。不要操作页面。";

export interface PendingAsk {
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
