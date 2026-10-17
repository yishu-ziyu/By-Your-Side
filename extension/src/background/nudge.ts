import { isPanelUrl } from './target-window.js';
import { NUDGE_EXCERPT_LIMIT, NUDGE_RECENT_LIMIT, NUDGE_SELECTION_LIMIT, NUDGE_TEXT_LIMIT, type Nudge, type NudgeContext, type NudgeRecentPage, type NudgeResult } from '../../../shared/nudge.js';
import type { ClientMessage, PageContext } from '../../../shared/protocol.js';
import type { TaskView } from '../../../shared/task-view.js';
import { NUDGE_ACT, NUDGE_UNDO, NUDGE_COOLDOWN_MS, NUDGE_DISMISS, NUDGE_DRAFT_KEY, NUDGE_KEY, NUDGE_PAGE, NUDGE_PANEL_KEY, NUDGE_PANEL_TTL_MS, NUDGE_SHOW, isNudgeOn, nudgeableUrl, type NudgeCard, type StoredNudgeOffer, type NudgePanelReply } from '../shared/nudge.js';
import { readNudgeLinks } from './nudge-links.js';
import { installNudgePreparation, storedNudgeOffer } from './nudge-preparation.js';

type Deps = {
  send: (message: ClientMessage) => boolean;
  selected: () => string;
  panelOpen: (windowId: number, tabId: number) => Promise<boolean>;
  act: (conversationId: string, text: string, card: NudgeCard, context?: PageContext) => Promise<boolean>;
};

const CARD_REPLY = '回复只用三句短话：一、在做什么或做成了什么；二、一个具体细节，证明你理解了这件事；三、接下来会怎样，或没做成时的退路。用了存的账号或卡，写明是哪一个。没做成就直说原因，不要说做成了。';
type SeenPage = NudgeRecentPage & { seenAt?: number };
type State = { recent: SeenPage[]; judged: string[]; dismissed: string[]; lastShownAt: number };
const STATE_KEY = 'nudgeState';
const MAX_URLS = 500;
interface PageReport { title?: unknown; text?: unknown; selection?: unknown; interacted?: unknown }
const isString = (v: unknown): v is string => typeof v === 'string';
const pageKey = (url: string) => url.split('#')[0]!;

async function loadState(): Promise<State> {
  const value: unknown = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
  if (!value || typeof value !== 'object') return { recent: [], judged: [], dismissed: [], lastShownAt: 0 };
  const recent = 'recent' in value && Array.isArray(value.recent) ? value.recent.filter((p): p is SeenPage =>
    !!p && typeof p === 'object' && typeof p.title === 'string' && typeof p.url === 'string' && typeof p.excerpt === 'string'
    && (p.seenAt === undefined || typeof p.seenAt === 'number')) : [];
  return { recent,
    judged: 'judged' in value && Array.isArray(value.judged) ? value.judged.filter(isString) : [],
    dismissed: 'dismissed' in value && Array.isArray(value.dismissed) ? value.dismissed.filter(isString) : [],
    lastShownAt: 'lastShownAt' in value && typeof value.lastShownAt === 'number' ? value.lastShownAt : 0 };
}
const saveState = (state: State) => chrome.storage.session.set({ [STATE_KEY]: { ...state, judged: state.judged.slice(-MAX_URLS), dismissed: state.dismissed.slice(-MAX_URLS) } });

export function installNudge(deps: Deps) {
  const views = new Map<string, TaskView>();
  const pending = new Map<string, { tabId: number; url: string; title: string; context: NudgeContext; conversationId: string; seen: SeenPage[]; requestedAt: number; documentId?: string }>();
  const offers = new Map<number, StoredNudgeOffer>();
  const acting = new Set<string>();
  const validations = new Map<string, (valid: boolean | null) => void>();
  const preparation = installNudgePreparation();
  let queue: Promise<unknown> = Promise.resolve();

  const withState = <T>(fn: (state: State) => T | Promise<T>): Promise<T> => {
    const next = queue.then(async () => { const state = await loadState(); const out = await fn(state); await saveState(state); return out; });
    queue = next.catch(() => {});
    return next;
  };
  const occupied = (view: TaskView | undefined) => !!view && ['running', 'paused'].includes(view.state);
  const taskRunningOn = (tabId: number) => [...views.values()].some(view => view.state === 'running' && (!view.page || view.page.tabId === tabId));
  const enabled = async () => isNudgeOn((await chrome.storage.local.get(NUDGE_KEY))[NUDGE_KEY]);

  const validateMemory = (offer: StoredNudgeOffer): Promise<boolean | null> => {
    const memory = offer.card.preparation?.memory;
    if (!memory) return Promise.resolve(true);
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { validations.delete(requestId); resolve(null); }, 5_000);
      const done = (valid: boolean | null) => { clearTimeout(timer); validations.delete(requestId); resolve(valid); };
      validations.set(requestId, done);
      if (!deps.send({ type: 'nudge_validate', conversationId: offer.conversationId, requestId, memory: { id: memory.id, version: memory.version }, url: offer.url })) done(null);
    });
  };

  const onPage = async (raw: PageReport, tabId: number, url: string): Promise<{ again: boolean }> => {
    if (!await enabled()) return { again: false };
    const title = isString(raw.title) ? raw.title.slice(0, 500) : '';
    const text = isString(raw.text) ? raw.text.slice(0, NUDGE_TEXT_LIMIT) : '';
    const selection = isString(raw.selection) && raw.selection.trim() ? raw.selection.slice(0, NUDGE_SELECTION_LIMIT) : undefined;
    const key = pageKey(url);
    return withState(async state => {
      const recent = state.recent.filter(page => pageKey(page.url) !== key).slice(-NUDGE_RECENT_LIMIT);
      state.recent = [...recent, { title, url, excerpt: text.slice(0, NUDGE_EXCERPT_LIMIT), seenAt: Date.now() }].slice(-(NUDGE_RECENT_LIMIT + 1));
      if (raw.interacted !== true || state.judged.includes(key) || state.dismissed.includes(key)) return { again: raw.interacted !== true };
      if (Date.now() - state.lastShownAt < NUDGE_COOLDOWN_MS || taskRunningOn(tabId)) return { again: true };
      const page = await readNudgeLinks(tabId);
      if (page && pageKey(page.url) !== key) return { again: false };
      const requestId = crypto.randomUUID();
      const conversationId = deps.selected();
      const seen = recent.reverse();
      const context: NudgeContext = { page: { title, url, text, ...(selection ? { selection } : {}), ...(page ? { links: page.links } : {}) },
        recent: seen.map(page => ({ title: page.title, url: page.url, excerpt: page.excerpt })) };
      if (!deps.send({ type: 'nudge_request', requestId, conversationId, context })) return { again: true };
      state.judged.push(key);
      pending.set(requestId, { tabId, url, title, context, conversationId, seen, requestedAt: Date.now(), ...(page ? { documentId: page.documentId } : {}) });
      return { again: false };
    });
  };

  const show = (requestId: string, nudge: Nudge) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    void withState(async state => {
      const tab = await chrome.tabs.get(request.tabId).catch(() => null);
      const key = pageKey(request.url);
      if (!tab?.active || !tab.url || pageKey(tab.pendingUrl ?? tab.url) !== key || !await enabled()
        || state.dismissed.includes(key) || Date.now() - state.lastShownAt < NUDGE_COOLDOWN_MS || taskRunningOn(request.tabId)) return;
      if (await preparation.busy()) return;
      const evidence = nudge.evidence[0]!;
      const current = evidence.url === request.context.page.url;
      const earlier = request.seen.find(page => page.url === evidence.url);
      const card: NudgeCard = {
        id: requestId, sentence: nudge.sentence, evidence: evidence.text, source: current ? request.context.page.title : earlier?.title ?? '',
        actionLabel: nudge.actionLabel, url: evidence.url, ...(nudge.party ? { party: nudge.party } : {}),
        ...(!current && earlier?.seenAt ? { seenAt: earlier.seenAt } : {}), ...(nudge.preparation ? { preparation: nudge.preparation } : {}),
      };
      const offer: StoredNudgeOffer = { conversationId: request.conversationId, card, at: Date.now(), requestedAt: request.requestedAt,
        prompt: nudge.prompt, url: request.url, tabId: request.tabId, ...(request.documentId ? { documentId: request.documentId } : {}) };
      const panelOpen = await deps.panelOpen(tab.windowId, request.tabId);
      if (panelOpen || card.preparation) await chrome.storage.session.set({ [NUDGE_PANEL_KEY]: offer });
      if (!panelOpen) {
        // 习惯原文只留在扩展里；页角连模型可能转述习惯的句子也不带。
        const { preparation: _privatePreparation, ...pageCard } = card;
        if (card.preparation) pageCard.sentence = '这个项目的阅读入口';
        const shown = await chrome.tabs.sendMessage(request.tabId, { type: NUDGE_SHOW, card: pageCard }, { frameId: 0 }).then(() => true, () => false);
        if (!shown) return;
        offers.set(request.tabId, offer);
      }
      state.lastShownAt = Date.now();
    }).catch(() => {});
  };

  const pageCurrent = async (offer: StoredNudgeOffer) => {
    const tab = await chrome.tabs.get(offer.tabId).catch(() => null);
    if (!tab?.active || !tab.url || pageKey(tab.pendingUrl ?? tab.url) !== pageKey(offer.url)) return false;
    if (offer.documentId) {
      const page = await readNudgeLinks(offer.tabId);
      if (!page || page.documentId !== offer.documentId || pageKey(page.url) !== pageKey(offer.url)) return false;
    }
    return true;
  };

  const consume = async (offer: StoredNudgeOffer, keep: boolean) => {
    if ((await storedNudgeOffer())?.card.id === offer.card.id) await chrome.storage.session.remove(NUDGE_PANEL_KEY);
    if (!keep) await preparation.dismiss(offer.card.id);
    if (offers.get(offer.tabId)?.card.id === offer.card.id) offers.delete(offer.tabId);
    await withState(state => { state.dismissed.push(pageKey(offer.url)); });
  };

  const onPanel = async (type: string, id: unknown): Promise<NudgePanelReply> => {
    const clickedAt = Date.now();
    const active = await storedNudgeOffer();
    const offer = active?.card.id === id ? active : typeof id === 'string' ? await preparation.receipt(id) : null;
    if (!offer || offer.card.id !== id || acting.has(offer.card.id)) return { ok: false, reason: 'gone' };
    acting.add(offer.card.id);
    try {
      if (type === NUDGE_UNDO) return await preparation.undo(offer.card.id) ? { ok: true } : { ok: false, reason: 'gone' };
      if (type === NUDGE_DISMISS) { await consume(offer, false); return { ok: true }; }
      if (offer.result || await preparation.receipt(offer.card.id)) return { ok: false, reason: 'gone' };
      if (views.get(offer.conversationId)?.state === 'running') return { ok: false, reason: 'busy' };
      if (offer.card.preparation) {
        if (occupied(views.get(offer.conversationId)) || taskRunningOn(offer.tabId)) return { ok: false, reason: 'busy' };
        if (Date.now() - offer.at >= NUDGE_PANEL_TTL_MS || !await enabled() || !await pageCurrent(offer)) {
          await consume(offer, false); return { ok: false, reason: 'stale' };
        }
        const valid = await validateMemory(offer);
        if (valid === null) return { ok: false, reason: 'offline' };
        if (!valid) { await consume(offer, false); return { ok: false, reason: 'stale' }; }
        await preparation.open(offer, async () => {
          if (occupied(views.get(offer.conversationId)) || taskRunningOn(offer.tabId)) return '助手正在做别的事，准备已停止。';
          if (!await enabled()) return '主动建议已关闭，准备已停止。';
          const currentMemory = await validateMemory(offer);
          if (currentMemory !== true) return currentMemory === false ? '这条习惯已更改或停用，准备已停止。' : '助手连接中断，准备已停止。';
          return await pageCurrent(offer) ? null : '你已经换了页面，准备已停止。';
        }, clickedAt);
        await consume(offer, true);
        return { ok: true };
      }
      const tab = await chrome.tabs.get(offer.tabId).catch(() => null);
      const context: PageContext | undefined = tab?.url ? { tabId: offer.tabId, title: tab.title ?? '', url: tab.url } : undefined;
      const said = offer.card.actionLabel + offer.card.sentence + (offer.card.party ? '（' + offer.card.party + '）' : '');
      if (!await deps.act(offer.conversationId, said + '\n' + offer.prompt + '\n\n' + CARD_REPLY, offer.card, context)) return { ok: false, reason: 'offline' };
      await consume(offer, false);
      return { ok: true };
    } finally { acting.delete(offer.card.id); }
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const type = message?.type;
    if (![NUDGE_PAGE, NUDGE_ACT, NUDGE_DISMISS, NUDGE_UNDO].includes(type)) return;
    if (sender.id === chrome.runtime.id && (isPanelUrl(sender.url) || (!sender.tab && sender.url?.startsWith(chrome.runtime.getURL('')))) && type !== NUDGE_PAGE) {
      void onPanel(type, message?.id).then(respond, () => respond({ ok: false, reason: 'offline' }));
      return true;
    }
    if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0 || !nudgeableUrl(sender.url) || type === NUDGE_UNDO) return;
    const tabId = sender.tab.id;
    if (type === NUDGE_PAGE) {
      void onPage(message, tabId, sender.url!).then(respond, () => respond({ again: false }));
      return true;
    }
    const offer = offers.get(tabId);
    if (!offer || offer.card.id !== message?.id) return;
    if (type === NUDGE_ACT) {
      // 必须在点击消息里同步打开，等异步校验以后 Chrome 就不认是用户动作。
      void chrome.sidePanel.open({ tabId }).catch(() => {});
      if (offer.card.preparation) {
        void onPanel(type, offer.card.id).then(respond, () => respond({ ok: false, reason: 'offline' }));
        return true;
      }
      void (async () => {
        await chrome.storage.session.set({ [NUDGE_DRAFT_KEY]: offer.prompt });
        await consume(offer, false);
      })().catch(() => {});
    } else void consume(offer, false).catch(() => {});
  });

  chrome.tabs.onRemoved.addListener(tabId => offers.delete(tabId));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[NUDGE_KEY] && !isNudgeOn(changes[NUDGE_KEY].newValue)) {
      offers.clear();
      void storedNudgeOffer().then(async offer => {
        if (offer) await consume(offer, acting.has(offer.card.id) || !!await preparation.receipt(offer.card.id));
      }).catch(() => {});
    }
  });

  return {
    receive(result: NudgeResult) {
      if (result.type === 'nudge_validation') { validations.get(result.requestId)?.(result.valid); return; }
      if (result.nudge) show(result.requestId, result.nudge);
      else pending.delete(result.requestId);
    },
    async memoryChanged() {
      const offer = await storedNudgeOffer();
      if (!offer?.card.preparation || offer.result || acting.has(offer.card.id) || await preparation.receipt(offer.card.id)) return;
      if (await validateMemory(offer) === false && (await storedNudgeOffer())?.card.id === offer.card.id) await consume(offer, false);
    },
    view(view: TaskView) { views.set(view.conversationId, view); },
    disconnected() { views.clear(); pending.clear(); for (const resolve of validations.values()) resolve(null); },
  };
}
