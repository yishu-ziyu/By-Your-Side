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
