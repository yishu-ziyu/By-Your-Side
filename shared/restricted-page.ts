export const RESTRICTED_PAGE_MESSAGE = '这页浏览器不让我读，请截图贴进来或复制文字。';
export class RestrictedPageError extends Error {
  constructor() { super(`${RESTRICTED_PAGE_MESSAGE} 不要再尝试读取此页。`); }
}

/** Chrome refuses extension page access for these addresses independently of host permissions. */
export function isRestrictedPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'about:' && parsed.pathname === 'blank') return false;
    if (['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'devtools:', 'view-source:', 'about:', 'edge:'].includes(parsed.protocol)) return true;
    return parsed.hostname === 'chromewebstore.google.com' || (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
  } catch { return false; }
}
