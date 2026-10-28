import { READING_SELECTION_LIMIT } from "../../../shared/reading.js";
/** 选中即问：划词文本裁剪与 session 交接。 */

export const ASK_STORE = "pendingAsk";

const MIN_ASK_CHARS = 2;

const MAX_ASK_CHARS = READING_SELECTION_LIMIT;

export const ASK_MENU_ID = "ask-sideagent";

/** chrome.storage.local 键：选中文字后是否自动弹出「问问这段 / 解释」工具条。 */
export const SELECTION_BAR_KEY = "sideagent_selection_bar";

/** chrome.storage.local 键：划词工具条和阅读卡是否显示朗读。默认关闭，只有明确存了 true 才开启。 */
export const READING_ALOUD_KEY = "reading_aloud";

/** chrome.storage.local 键：用户拖过右下角后记住的阅读卡大小。 */
export const READING_CARD_SIZE_KEY = "reading_card_size";

export interface ReadingCardSize {
  width: number;
  height: number;
}

/** 存进来的尺寸只做形状检查；按当前窗口能放多大由卡片自己再收一次。 */
export function readReadingCardSize(stored: unknown): ReadingCardSize | null {
  if (!stored || typeof stored !== "object") return null;

  const { width, height } = stored as Record<string, unknown>;

  if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 160) return null;

  return { width: Math.round(width), height: Math.round(height) };
}

/** 只有明确存了 false 才算关闭；没存过或存了别的值都算开启。 */
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
