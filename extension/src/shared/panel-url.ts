/**
 * 是不是本扩展的会话页（侧栏，或网页浮动卡片里的那份）。会话页设了 use_dynamic_url，
 * runtime.getURL 给的是每次启动都换的动态地址，侧栏自己却是固定地址，所以两种主机名都认，只比路径。
 */
export function isPanelUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "chrome-extension:" && u.pathname === "/sidepanel.html"
      && (u.host === chrome.runtime.id || u.host === new URL(chrome.runtime.getURL("sidepanel.html")).host);
  } catch {
    return false;
  }
}
