import type { TaskView } from '../../../shared/task-view.js';
import { EDGE_PILL_GET, EDGE_PILL_OPEN, EDGE_PILL_SHOW, type EdgePill } from '../shared/edge-pill.js';

/**
 * 侧栏关着、任务还在跑（或暂停等你、出错）时，让当前标签页右边缘显示药丸。
 * 只读任务视图，不是第二套任务状态；出错在侧栏打开过之后算看过，不再显示。
 * 按住说话的胶囊在哪一页显示，药丸就在那一页让位：页面上只留一个状态面（docs/evals/20261007-ptt-capsule.md R4）。
 */
export function installEdgePill(capsuleTab: () => number | null = () => null) {
  const views = new Map<string, TaskView>();
  const seenErrors = new Set<string>();
  let panelOpen = false;
  const errorKey = (view: TaskView) => `${view.conversationId}:${view.runId ?? view.observedAt}`;

  const stateOf = (view: TaskView): NonNullable<EdgePill>['state'] | null =>
    view.state === 'running' ? 'running' : view.state === 'paused' ? 'paused' : view.state === 'error' && !seenErrors.has(errorKey(view)) ? 'error' : null;

  const current = (): EdgePill => {
    if (panelOpen) return null;
    const rank = { running: 0, paused: 1, error: 2 } as const;

    const shown = [...views.values()].flatMap(view => { const state = stateOf(view);

      return state ? [{ state, goal: view.goal ?? '', at: view.observedAt }] : []; })
      .sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at)[0];

    return shown ? { state: shown.state, goal: shown.goal } : null;
  };

  const pillFor = (tabId: number) => capsuleTab() === tabId ? null : current();

  const send = (tabId: number) => { void chrome.tabs.sendMessage(tabId, { type: EDGE_PILL_SHOW, pill: pillFor(tabId) }).catch(() => { /* 无内容脚本的页面 */ }); };

  const publish = () => { void chrome.tabs.query({ active: true }).then(tabs => { for (const tab of tabs) if (tab.id) send(tab.id); }); };

  chrome.tabs.onActivated.addListener(info => send(info.tabId));
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const type = raw?.type;

    if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0) return;

    if (type === EDGE_PILL_GET) respond({ pill: pillFor(sender.tab.id) });

    // 必须在这次点击的消息里同步打开：等异步之后浏览器就不认是用户动作了。
    if (type === EDGE_PILL_OPEN) void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => { /* 侧栏已开 */ });
  });

  return {
    view(view: TaskView) {
      if (panelOpen && view.state === 'error') seenErrors.add(errorKey(view));
      views.set(view.conversationId, view); publish();
    },
    /** 胶囊出现或收起：重新决定药丸显示不显示。 */
    refresh: publish,
    /** 和本机 Agent 断开：旧视图不再可信，药丸收起，等重连后的新视图。 */
    disconnected() { views.clear(); publish(); },
    panel(open: boolean) {
      if (open) for (const view of views.values()) if (view.state === 'error') seenErrors.add(errorKey(view));
      panelOpen = open; publish();
    },
  };
}
