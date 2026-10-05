import { isPageElementSource, type ClientMessage, type MarginaliaMode, type ViewportSectionUpdate } from '../../../shared/protocol.js';
import type { ReadingEvent } from '../../../shared/reading.js';
import type { BgToPanel } from '../relay.js';

type Track = { documentId?: string; mode: MarginaliaMode; url: string; update?: ViewportSectionUpdate; timer?: ReturnType<typeof setTimeout>; request?: { id: string; thread: string; conversation: string }; text: string; state: ReadingEvent['state']; cache: Map<string, string> };

type Dependencies = { send: (message: ClientMessage) => boolean; selected: () => string; publish: (message: BgToPanel) => void };

export function installMarginalia(deps: Dependencies) {
  const tracks = new Map<number, Track>();
  const key = (update: ViewportSectionUpdate) => `${update.source.document}:${update.source.id}:${update.source.text}`;

  const cancel = (track: Track) => {
    clearTimeout(track.timer);

    if (track.request) deps.send({ type: 'reading_cancel', threadId: track.request.thread, requestId: track.request.id, conversationId: track.request.conversation });
    track.request = undefined;
  };

  const publish = (track: Track) => {
    if (track.update && track.mode === 'ai') deps.publish({ kind: 'marginalia', update: track.update, state: track.state, text: track.text });
  };

  const explain = (track: Track) => {
    if (!track.update || track.mode !== 'ai' || track.update.source.url !== track.url) return;
    const update = track.update;
    const cached = track.cache.get(key(update));

    if (cached) { track.text = cached; track.state = 'done'; publish(track);

      return; }

    const source = update.source;
    const request = { id: crypto.randomUUID(), thread: crypto.randomUUID(), conversation: deps.selected() };
    track.request = request;
    track.state = 'pending'; track.text = ''; publish(track);

    if (!deps.send({ type: 'reading_request', requestId: request.id, conversationId: request.conversation, transcript: {
      threadId: request.thread,
      source: { text: source.text, surrounding: '', truncated: false, tabId: update.tabId, title: source.title, url: source.url },
      turns: [{ question: '边注解释：用一至两句话解释当前段落，尽量不超过60个汉字。区分原文事实与推测；不要操作网页。', answer: '', state: 'pending' }],
    } })) {
      track.request = undefined; track.state = 'error'; track.text = '未连接到模型，切换模式可重试。'; publish(track);
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'VIEWPORT_ACTIVE_SECTION') return;
    const panel = sender.id === chrome.runtime.id && sender.url?.split('?')[0] === chrome.runtime.getURL('sidepanel.html');

    if (message.action === 'track' && panel && Number.isInteger(message.tabId) && ['off', 'source', 'ai'].includes(message.mode)) {
      const previous = tracks.get(message.tabId);

      if (previous) cancel(previous);
      const next: Track | undefined = message.mode === 'off' ? undefined : { mode: message.mode, url: '', text: '', state: 'pending', cache: new Map() };

      if (next) tracks.set(message.tabId, next); else tracks.delete(message.tabId);
      void chrome.tabs.get(message.tabId).then(tab => {
        if (tracks.get(message.tabId) !== next) return;

        if (next) next.url = tab.url ?? '';

        return chrome.tabs.sendMessage(message.tabId, { type: message.type, action: 'track', enabled: !!next }, { frameId: 0 });
      }).then(() => respond({ ok: true }), () => respond({ ok: false, error: '当前页面无法启用边注。' }));

      return true;
    }

    if (!sender.tab?.id || sender.frameId !== 0) return;
    const tabId = sender.tab.id;
    const track = tracks.get(tabId);

    if (message.action === 'ready') {
      if (track && sender.url === track.url) void chrome.tabs.sendMessage(tabId, { type: message.type, action: 'track', enabled: true }, { frameId: 0 }).catch(() => {});

      return;
    }

    if (!track) return;

    if (message.action === 'clear' && track.documentId && sender.documentId !== track.documentId) return;

    if (message.action === 'clear') { cancel(track); track.update = undefined; deps.publish({ kind: 'page_section', update: null, tabId });

      return; }

    if (message.action !== 'update' || !isPageElementSource(message.source) || message.source.url !== sender.url || message.source.url !== track.url || !Number.isFinite(message.position) || message.position < 0 || message.position > 1 || !Number.isInteger(message.index) || !Number.isFinite(message.viewportHeight) || message.viewportHeight <= 0 || message.viewportHeight > 20000) return;
    const update: ViewportSectionUpdate = { source: message.source, position: message.position, viewportHeight: message.viewportHeight, index: message.index, tabId };
    const changed = !track.update || key(track.update) !== key(update);
    track.update = update; track.documentId = sender.documentId;
    deps.publish({ kind: 'page_section', update, tabId });

    if (track.mode !== 'ai') return;

    if (changed) { cancel(track); track.text = ''; track.state = 'pending'; track.timer = setTimeout(() => explain(track), 400); }

    publish(track);
  });

  chrome.tabs.onRemoved.addListener(tabId => { const track = tracks.get(tabId);

    if (track) cancel(track); tracks.delete(tabId); });

  return {
    stopAll() {
      for (const [tabId, track] of tracks) {
        cancel(track);
        void chrome.tabs.sendMessage(tabId, { type: 'VIEWPORT_ACTIVE_SECTION', action: 'track', enabled: false }, { frameId: 0 }).catch(() => {});
      }

      tracks.clear();
    },
    receive(event: ReadingEvent) {
      for (const track of tracks.values()) {
        if (track.request?.id !== event.requestId || track.request.thread !== event.threadId || !track.update) continue;
        track.state = event.state;
        track.text = event.error ?? event.text;

        if (event.state === 'done') {
          track.cache.set(key(track.update), event.text);

          if (track.cache.size > 32) track.cache.delete(track.cache.keys().next().value!);
        }

        publish(track);

        if (['done', 'error', 'stopped'].includes(event.state)) track.request = undefined;
      }
    },
  };
}
