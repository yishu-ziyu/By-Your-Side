import { NUDGE_EXCERPT_LIMIT, NUDGE_RECENT_LIMIT, NUDGE_SELECTION_LIMIT, NUDGE_TEXT_LIMIT, type Nudge, type NudgeContext, type NudgeRecentPage, type NudgeResult } from '../../../shared/nudge.js';
import type { ClientMessage, PageContext } from '../../../shared/protocol.js';
import type { TaskView } from '../../../shared/task-view.js';
import { NUDGE_ACT, NUDGE_COOLDOWN_MS, NUDGE_DISMISS, NUDGE_DRAFT_KEY, NUDGE_KEY, NUDGE_PAGE, NUDGE_PANEL_KEY, NUDGE_SHOW, isNudgeOn, nudgeableUrl, type NudgeCard, type NudgePanelOffer } from '../shared/nudge.js';

/**
 * 主动建议卡（#52）的后台一半：记下这次会话最近看过的几页，在用户读一页够久又动过手时，
 * 请模型判断一次要不要建议；有建议才出卡，点按钮打开侧栏并把建议的指令填进输入框，由用户自己发送（YIS-74）。
 * 侧栏开着时卡放进侧栏对话流（YIS-106），不开时出在页角。
 *
 * 限频（本次浏览器会话，存 chrome.storage.session，不落盘）：同一网址只判断一次；两张卡至少隔 3 分钟；点过 × 的网址不再建议。
 */

type Deps = {
  send: (message: ClientMessage) => boolean;
  selected: () => string;
  panelOpen: () => boolean;
  /** 按了侧栏卡的动词：把话交给这张卡所属的会话，返回是否送出。 */
  act: (conversationId: string, text: string, card: NudgeCard, context?: PageContext) => Promise<boolean>;
};

/**
 * 按动词就做（YIS-106 R2）：回复固定三句，接在卡下面原位说清。
 * 写进交给助手的话里，不另开通道；侧栏这一轮画成卡，不显示这段原文。
 */
const CARD_REPLY = '回复只用三句短话：一、在做什么或做成了什么；二、一个具体细节，证明你理解了这件事；三、接下来会怎样，或没做成时的退路。用了存的账号或卡，写明是哪一个。没做成就直说原因，不要说做成了。';

/** seenAt 只给出处行写「多久前」，不发给模型。 */
type SeenPage = NudgeRecentPage & { seenAt?: number };

type State = { recent: SeenPage[]; judged: string[]; dismissed: string[]; lastShownAt: number };

const STATE_KEY = 'nudgeState';

const MAX_URLS = 500;

/** 页面脚本报来的原始字段：到这里还没核对类型。 */
interface PageReport { title?: unknown; text?: unknown; selection?: unknown; interacted?: unknown }

const isString = (v: unknown): v is string => typeof v === 'string';

const pageKey = (url: string) => url.split('#')[0]!;

async function loadState(): Promise<State> {
  // SAFETY: nudgeState 只由 saveState 写入，形状就是 State；每个字段读取时都带默认值，缺字段或旧数据也安全。
  const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as Partial<State> | undefined;

  return { recent: stored?.recent ?? [], judged: stored?.judged ?? [], dismissed: stored?.dismissed ?? [], lastShownAt: stored?.lastShownAt ?? 0 };
}

const saveState = (state: State) => chrome.storage.session.set({ [STATE_KEY]: { ...state, judged: state.judged.slice(-MAX_URLS), dismissed: state.dismissed.slice(-MAX_URLS) } });

export function installNudge(deps: Deps) {
  const views = new Map<string, TaskView>();
  const pending = new Map<string, { tabId: number; url: string; title: string; context: NudgeContext; conversationId: string; seen: SeenPage[] }>();
  const offers = new Map<number, { id: string; url: string; title: string; prompt: string }>();
  // 侧栏里同时只留一张卡；新卡顶掉旧卡。
  let panelOffer: { id: string; url: string; prompt: string; tabId: number; conversationId: string; card: NudgeCard } | null = null;
  // 状态读写串行：两个标签同时报到时不互相覆盖。
  let queue: Promise<unknown> = Promise.resolve();

  const withState = <T>(fn: (state: State) => T | Promise<T>): Promise<T> => {
    const next = queue.then(async () => { const state = await loadState(); const out = await fn(state); await saveState(state);

      return out; });

    queue = next.catch(() => {});

    return next;
  };

  const taskRunningOn = (tabId: number) => [...views.values()].some(view => view.state === 'running' && (!view.page || view.page.tabId === tabId));

  const onPage = async (raw: PageReport, tabId: number, url: string): Promise<{ again: boolean }> => {
    if (!isNudgeOn((await chrome.storage.local.get(NUDGE_KEY))[NUDGE_KEY])) return { again: false };
    const title = isString(raw.title) ? raw.title.slice(0, 500) : '';
    const text = isString(raw.text) ? raw.text.slice(0, NUDGE_TEXT_LIMIT) : '';
    const selection = isString(raw.selection) && raw.selection.trim() ? raw.selection.slice(0, NUDGE_SELECTION_LIMIT) : undefined;
    const key = pageKey(url);

    return withState(state => {
      // 先取「之前看过的」，再把这一页记进去。
      const recent = state.recent.filter(page => pageKey(page.url) !== key).slice(-NUDGE_RECENT_LIMIT);
      state.recent = [...recent, { title, url, excerpt: text.slice(0, NUDGE_EXCERPT_LIMIT), seenAt: Date.now() }].slice(-(NUDGE_RECENT_LIMIT + 1));

      if (raw.interacted !== true || state.judged.includes(key) || state.dismissed.includes(key)) return { again: raw.interacted !== true };

      if (Date.now() - state.lastShownAt < NUDGE_COOLDOWN_MS || taskRunningOn(tabId)) return { again: true };
      const requestId = crypto.randomUUID();
      const conversationId = deps.selected();
      const seen = recent.reverse();
      const context: NudgeContext = { page: selection ? { title, url, text, selection } : { title, url, text }, recent: seen.map(page => ({ title: page.title, url: page.url, excerpt: page.excerpt })) };

      if (!deps.send({ type: 'nudge_request', requestId, conversationId, context })) return { again: true };
      state.judged.push(key);
      pending.set(requestId, { tabId, url, title, context, conversationId, seen });

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

      // 判断回来时用户可能已经走开：换了页、切了标签、点过 ×、任务开跑，就不出卡。
      if (!tab?.active || !tab.url || pageKey(tab.url) !== key || state.dismissed.includes(key) || Date.now() - state.lastShownAt < NUDGE_COOLDOWN_MS || taskRunningOn(request.tabId)) return;
      const evidence = nudge.evidence[0]!;
      const current = evidence.url === request.context.page.url;
      const earlier = request.seen.find(page => page.url === evidence.url);
      const source = current ? request.context.page.title : earlier?.title ?? '';
      const card: NudgeCard = {
        id: requestId, sentence: nudge.sentence, evidence: evidence.text, source, actionLabel: nudge.actionLabel, url: evidence.url,
        ...(nudge.party ? { party: nudge.party } : {}),
        ...(!current && earlier?.seenAt ? { seenAt: earlier.seenAt } : {}),
      };

      if (deps.panelOpen()) {
        const offer: NudgePanelOffer = { conversationId: request.conversationId, card };

        await chrome.storage.session.set({ [NUDGE_PANEL_KEY]: offer });
        panelOffer = { id: requestId, url: request.url, prompt: nudge.prompt, tabId: request.tabId, conversationId: request.conversationId, card };
      } else {
        const shown = await chrome.tabs.sendMessage(request.tabId, { type: NUDGE_SHOW, card }, { frameId: 0 }).then(() => true, () => false);

        if (!shown) return;
        offers.set(request.tabId, { id: requestId, url: request.url, title: request.title, prompt: nudge.prompt });
      }
      state.lastShownAt = Date.now();
    });
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const type = message?.type;

    if (type !== NUDGE_PAGE && type !== NUDGE_ACT && type !== NUDGE_DISMISS) return;

    if (sender.id === chrome.runtime.id && !sender.tab && sender.url?.startsWith(chrome.runtime.getURL('')) && type !== NUDGE_PAGE) {
      void onPanel(type, message?.id).then(respond, () => respond({ ok: false }));

      return true;
    }

    if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0 || !nudgeableUrl(sender.url)) return;
    const tabId = sender.tab.id;

    if (type === NUDGE_PAGE) {
      void onPage(message, tabId, sender.url!).then(respond, () => respond({ again: false }));

      return true;
    }

    const offer = offers.get(tabId);

    if (!offer || offer.id !== message?.id) return;
    offers.delete(tabId);
    void withState(state => { state.dismissed.push(pageKey(offer.url)); });

    if (type === NUDGE_ACT) {
      // 必须在这次点击的消息里同步打开：等异步之后浏览器就不认是用户动作了。
      void chrome.sidePanel.open({ tabId }).catch(() => { /* 侧栏已开 */ });
      void chrome.storage.session.set({ [NUDGE_DRAFT_KEY]: offer.prompt });
    }
  });

  // 侧栏卡：点 × 收起；按动词就把事交给助手，不再问（用户 10-07 决定）。两种都让这一页本次不再建议。
  // 没送出去（助手没连上）时卡留着，可以再按。
  const onPanel = async (type: string, id: unknown): Promise<{ ok: boolean }> => {
    if (!panelOffer || panelOffer.id !== id) return { ok: false };
    const offer = panelOffer;

    if (type === NUDGE_ACT) {
      const tab = await chrome.tabs.get(offer.tabId).catch(() => null);
      const context: PageContext | undefined = tab?.id && tab.url ? { tabId: tab.id, title: tab.title ?? '', url: tab.url } : undefined;

      // 第一行是卡上那句话：会话标题和记录里读到的是这件事，不是给助手的长指令。
      const said = `${offer.card.actionLabel}${offer.card.sentence}${offer.card.party ? `（${offer.card.party}）` : ''}`;

      if (!await deps.act(offer.conversationId, `${said}\n${offer.prompt}\n\n${CARD_REPLY}`, offer.card, context)) return { ok: false };
    }

    if (panelOffer === offer) panelOffer = null;
    await chrome.storage.session.remove(NUDGE_PANEL_KEY);
    void withState(state => { state.dismissed.push(pageKey(offer.url)); });

    return { ok: true };
  };

  chrome.tabs.onRemoved.addListener(tabId => offers.delete(tabId));

  return {
    receive(result: NudgeResult) {
      if (result.nudge) show(result.requestId, result.nudge);
      else pending.delete(result.requestId);
    },
    view(view: TaskView) { views.set(view.conversationId, view); },
    disconnected() { views.clear(); pending.clear(); },
  };
}
