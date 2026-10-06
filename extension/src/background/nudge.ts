import { NUDGE_EXCERPT_LIMIT, NUDGE_RECENT_LIMIT, NUDGE_SELECTION_LIMIT, NUDGE_TEXT_LIMIT, type Nudge, type NudgeContext, type NudgeRecentPage, type NudgeResult } from '../../../shared/nudge.js';
import type { ClientMessage } from '../../../shared/protocol.js';
import type { TaskView } from '../../../shared/task-view.js';
import { NUDGE_ACT, NUDGE_COOLDOWN_MS, NUDGE_DISMISS, NUDGE_DRAFT_KEY, NUDGE_KEY, NUDGE_PAGE, NUDGE_SHOW, isNudgeOn, nudgeableUrl, type NudgeCard } from '../shared/nudge.js';

/**
 * 主动建议卡（#52）的后台一半：记下这次会话最近看过的几页，在用户读一页够久又动过手时，
 * 请模型判断一次要不要建议；有建议才让页角出卡，点按钮打开侧栏并把建议的指令填进输入框，由用户自己发送（YIS-74）。
 *
 * 限频（本次浏览器会话，存 chrome.storage.session，不落盘）：同一网址只判断一次；两张卡至少隔 3 分钟；点过 × 的网址不再建议。
 */

type Deps = {
  send: (message: ClientMessage) => boolean;
  selected: () => string;
};

type State = { recent: NudgeRecentPage[]; judged: string[]; dismissed: string[]; lastShownAt: number };

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
  const pending = new Map<string, { tabId: number; url: string; title: string; context: NudgeContext; conversationId: string }>();
  const offers = new Map<number, { id: string; url: string; title: string; prompt: string }>();
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
      state.recent = [...recent, { title, url, excerpt: text.slice(0, NUDGE_EXCERPT_LIMIT) }].slice(-(NUDGE_RECENT_LIMIT + 1));

      if (raw.interacted !== true || state.judged.includes(key) || state.dismissed.includes(key)) return { again: raw.interacted !== true };

      if (Date.now() - state.lastShownAt < NUDGE_COOLDOWN_MS || taskRunningOn(tabId)) return { again: true };
      const requestId = crypto.randomUUID();
      const conversationId = deps.selected();
      const context: NudgeContext = { page: selection ? { title, url, text, selection } : { title, url, text }, recent: recent.reverse() };

      if (!deps.send({ type: 'nudge_request', requestId, conversationId, context })) return { again: true };
      state.judged.push(key);
      pending.set(requestId, { tabId, url, title, context, conversationId });

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
      const source = evidence.url === request.context.page.url ? request.context.page.title : request.context.recent.find(page => page.url === evidence.url)?.title ?? '';
      const card: NudgeCard = { id: requestId, sentence: nudge.sentence, evidence: evidence.text, source, actionLabel: nudge.actionLabel };
      const shown = await chrome.tabs.sendMessage(request.tabId, { type: NUDGE_SHOW, card }, { frameId: 0 }).then(() => true, () => false);

      if (!shown) return;
      state.lastShownAt = Date.now();
      offers.set(request.tabId, { id: requestId, url: request.url, title: request.title, prompt: nudge.prompt });
    });
  };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const type = message?.type;

    if (type !== NUDGE_PAGE && type !== NUDGE_ACT && type !== NUDGE_DISMISS) return;

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
