import { isNudgeLink, type NudgeLink } from '../../../shared/nudge.js';

export async function readNudgeLinks(tabId: number): Promise<{ url: string; links: NudgeLink[]; documentId: string } | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const root = document.querySelector('article.markdown-body') ?? document.querySelector('main') ?? document.body;
      const seen = new Set<string>();
      const links: { title: string; url: string }[] = [];
      let chars = 0;
      const current = new URL(location.href);
      const currentTitle = document.title.trim().slice(0, 120);
      if (currentTitle && ['http:', 'https:'].includes(current.protocol) && !current.username && !current.password && current.href.length <= 2000) {
        links.push({ title: currentTitle, url: current.href });
        seen.add(current.href);
        chars = currentTitle.length + current.href.length;
      }
      for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (links.length === 80) break;
        const title = (anchor.innerText || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title || anchor.hasAttribute('download') || !anchor.getClientRects().length) continue;
        try {
          const url = new URL(anchor.href, location.href);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000 || seen.has(url.href)) continue;
          seen.add(url.href);
          if (chars + title.length + url.href.length > 6000) continue;
          chars += title.length + url.href.length;
          links.push({ title, url: url.href });
        } catch { /* Invalid page links are not entrances. */ }
      }
      return { url: location.href, links };
    },
  }).catch(() => []);
  const value: unknown = results[0]?.result;
  if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string'
    || !('links' in value) || !Array.isArray(value.links) || value.links.length > 80 || !value.links.every(isNudgeLink)) return null;
  const documentId = results[0]?.documentId;
  return typeof documentId === 'string' ? { url: value.url, links: value.links, documentId } : null;
}
