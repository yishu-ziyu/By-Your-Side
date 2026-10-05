/** Shift+悬停链接预览卡（#48）：后台与内容脚本、设置页共用的消息与开关。 */

/** 页面 → 后台：取这条链接的标题和几行要点。 */
export const LINK_PREVIEW_GET = 'LINK_PREVIEW_GET';

export type LinkPreview = { ok: true; title: string; lines: string[] } | { ok: false };

/** chrome.storage.local 键：Shift+悬停链接时是否显示预览卡。 */
export const LINK_PREVIEW_KEY = 'sideagent_link_preview';

/** 只有明确存了 false 才算关闭；没存过算开启。 */
export function isLinkPreviewOff(stored: unknown): stored is false {
  return stored === false;
}

/** 只预览普通网页链接：chrome://、扩展页、javascript: 等一律不触发。 */
export function previewableUrl(raw: string): string | null {
  if (raw.length > 2048) return null;

  try {
    const url = new URL(raw);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';

    return url.toString();
  } catch {
    return null;
  }
}
