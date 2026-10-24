/** chrome.storage.local 键：网页右边缘平时停着的翻译入口。 */
export const EDGE_ENTRY_KEY = "sideagent_edge_translate_entry";

/** 只有明确存了 false 才算关闭；没存过或存了别的值都算开启。 */
export function isEdgeEntryOff(stored: unknown): stored is false {
  return stored === false;
}
