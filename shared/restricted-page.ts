export const RESTRICTED_PAGE_MESSAGE = '这页浏览器不让我读，请截图贴进来或复制文字。';
export const RESTRICTED_PAGE_FACT = '浏览器不允许读取这一页的内容；打开别的网址、切换标签页不受影响；要这页的内容只能请用户截图或复制文字。';
export class RestrictedPageError extends Error {
  constructor(readonly tabId: number | null, readonly url: string) { super(RESTRICTED_PAGE_FACT); }
}

export function isRestrictedPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'about:' && parsed.pathname === 'blank') return false;
    if (['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'devtools:', 'view-source:', 'about:', 'edge:'].includes(parsed.protocol)) return true;
    return parsed.hostname === 'chromewebstore.google.com' || (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
  } catch { return false; }
}
