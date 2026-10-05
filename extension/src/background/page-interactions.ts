import { isPageInteractionMessage, type PageElementSource } from '../../../shared/protocol.js';

export function installPageInteractions(): void {
  const isPanel = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && sender.url?.split('?')[0] === chrome.runtime.getURL('sidepanel.html');
  const offers = new Map<string, { source: PageElementSource; tabId: number; documentId?: string; expires: number }>();
  chrome.tabs.onRemoved.addListener(tabId => { for (const [token, offer] of offers) if (offer.tabId === tabId) offers.delete(token); });
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    if (!isPageInteractionMessage(raw)) return;
    const message = raw;


    if (message?.type === 'FEED_DROPPED_ELEMENT') {
      if (message.action === 'validate') return;

      if (message.action === 'offer' && sender.tab?.id && sender.frameId === 0 && message.source.url === sender.url) {
        offers.set(message.token, { source: message.source, tabId: sender.tab.id, documentId: sender.documentId, expires: Date.now() + 60_000 });

        if (offers.size > 16) offers.delete(offers.keys().next().value!);

        respond({ ok: true });

        return;
      }

      if (message.action !== 'consume' || !isPanel(sender)) return;
      const offer = offers.get(message.token);
      offers.delete(message.token);

      if (!offer || offer.expires < Date.now()) { respond({ ok: false, error: '拖入的材料已过期，请从原页面重新拖拽。' });

        return; }

      void (async () => {
        const tab = await chrome.tabs.get(offer.tabId);

        if (tab.url !== offer.source.url) throw Error('stale page');
        const valid = await chrome.tabs.sendMessage(offer.tabId, { type: message.type, action: 'validate', source: offer.source }, offer.documentId ? { documentId: offer.documentId } : { frameId: 0 });

        if (!valid?.ok) throw Error('stale element');
        respond({ ok: true, source: offer.source, tabId: offer.tabId });
      })().catch(() => respond({ ok: false, error: '原网页或材料已变化，未添加旧材料。' }));

      return true;
    }

    if (message?.type !== 'PINPOINT_DOM_TARGET' || !isPanel(sender)) return;

    if (!Number.isInteger(message.tabId) || message.tabId <= 0) return;

    if (message.action !== 'identity' && message.action !== 'resolve' && message.action !== 'reveal') return;




    void (async () => {
      const tab = await chrome.tabs.get(message.tabId);

      if (tab.url !== (message.action === 'reveal' ? message.source.url : message.url)) throw new Error('来源页面已导航，未定位旧内容。');
      const result = await chrome.tabs.sendMessage(message.tabId, message, { frameId: 0 });

      if (result?.ok && message.action === 'reveal') await chrome.tabs.update(message.tabId, { active: true });
      respond(result);
    })().catch(() => respond({ ok: false, error: '来源页面不可用，请重新核对。' }));

    return true;
  });
}
