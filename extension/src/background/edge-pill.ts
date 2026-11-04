import type { TaskView } from '../../../shared/task-view.js';
import { EDGE_PILL_GET, EDGE_PILL_OPEN, EDGE_PILL_SHOW, type EdgePill, type EdgeTask, type EdgeTaskStep } from '../shared/edge-pill.js';

export function installEdgePill(capsuleTab: () => number | null = () => null) {
  const views = new Map<string, TaskView>();
  const seenErrors = new Set<string>();
  let panelOpen = false;
  const errorKey = (view: TaskView) => `${view.conversationId}:${view.runId ?? view.observedAt}`;
  const startedAt = new Map<string, number>();
  const runKey = (view: TaskView) => `${view.conversationId}:${view.runId ?? ''}`;

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

  const STEP_STATE = { satisfied: 'done', blocked: 'failed', unknown: 'unknown' } as const;

  const taskFor = (tabId: number): EdgeTask => {
    const running = [...views.values()].filter(v => v.state === 'running').sort((a, b) => b.observedAt - a.observedAt);
    const view = running.find(v => v.page?.tabId === tabId) ?? running[0];

    if (!view) return null;
    const done = view.results.flatMap((r): EdgeTaskStep[] => r.status === 'pending' ? [] : [{ text: r.description, state: STEP_STATE[r.status] }]);
    const now = view.active.map((a): EdgeTaskStep => ({ text: a.action, state: 'now' }));

    return { goal: view.goal ?? '', startedAt: startedAt.get(runKey(view)) ?? view.observedAt, steps: [...done.slice(-(now.length ? 2 : 3)), ...now.slice(-1)] };
  };

  const send = (tabId: number) => { void chrome.tabs.sendMessage(tabId, { type: EDGE_PILL_SHOW, pill: pillFor(tabId), task: taskFor(tabId), voice: capsuleTab() === tabId }).catch(() => {  }); };

  const publish = () => { void chrome.tabs.query({ active: true }).then(tabs => { for (const tab of tabs) if (tab.id) send(tab.id); }); };

  chrome.tabs.onActivated.addListener(info => send(info.tabId));
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const type = raw?.type;

    if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0) return;

    if (type === EDGE_PILL_GET) respond({ pill: pillFor(sender.tab.id), task: taskFor(sender.tab.id), voice: capsuleTab() === sender.tab.id });

    // WHY: 必须在这次点击的消息里同步打开：等异步之后浏览器就不认是用户动作了。
    if (type === EDGE_PILL_OPEN) void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {  });
  });

  return {
    view(view: TaskView) {
      if (panelOpen && view.state === 'error') seenErrors.add(errorKey(view));
      if (view.state === 'running' && !startedAt.has(runKey(view))) startedAt.set(runKey(view), view.observedAt);
      views.set(view.conversationId, view); publish();
    },
    refresh: publish,
    disconnected() { views.clear(); publish(); },
    panel(open: boolean) {
      if (open) for (const view of views.values()) if (view.state === 'error') seenErrors.add(errorKey(view));
      panelOpen = open; publish();
    },
  };
}
