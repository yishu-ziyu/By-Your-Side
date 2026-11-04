import { BROWSE_DAY_LIMIT, BROWSE_LINE_LIMIT, type BrowseDay, type BrowseHabitResult } from '../../../shared/browse-habits.js';
import type { ClientMessage } from '../../../shared/protocol.js';
import type { TaskView } from '../../../shared/task-view.js';
import { BROWSE_CONTROL, BROWSE_DISMISSED_KEY, BROWSE_EVENT, BROWSE_FOUND_KEY, BROWSE_INDUCE_AFTER_STEPS, BROWSE_INDUCE_EVERY_MS, BROWSE_LOG_KEY, BROWSE_ON_KEY, isBrowseOn, isBrowseStep, localDay, readBrowseEvents, readBrowseFound, readDismissed, type BrowseEvent, type BrowseStep } from '../shared/browse-habits.js';
import { watchSelfUse } from '../shared/self-use.js';
import { debuggerAttached } from './debugger.js';
import { isPanelUrl } from './target-window.js';
import { nudgeableUrl } from '../shared/nudge.js';

type Deps = { send: (message: ClientMessage) => boolean; selected: () => string };

const MAX_EVENTS = 4000;

const KEEP_MS = BROWSE_DAY_LIMIT * 24 * 60 * 60_000;

type Log = { events: BrowseEvent[]; since: number; lastAt: number };

function line(step: BrowseStep, url: URL, at: number): string {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const where = `${url.hostname}${url.pathname}`.slice(0, 160);

  if (step.kind === 'visit') return `${time} 打开 ${where}${url.search ? url.search.slice(0, 80) : ''} 「${step.title}」`;

  if (step.kind === 'click') return `${time} 在 ${url.hostname} 点「${step.label}」${step.href ? ` → ${step.href.replace(/^https?:\/\//, '').slice(0, 160)}` : ''}`;

  return `${time} 在 ${url.hostname} 的「${step.label}」${step.kind === 'submit' ? '输入并回车' : '填'}「${step.value}」`;
}

export function installBrowseHabits(deps: Deps) {
  const selfUse = watchSelfUse();

  const views = new Map<string, TaskView>();
  const pending = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const withLog = <T>(fn: (log: Log) => T | Promise<T>): Promise<T> => {
    const next = queue.then(async () => {
      const stored: unknown = (await chrome.storage.local.get(BROWSE_LOG_KEY))[BROWSE_LOG_KEY];
      const meta = stored && typeof stored === 'object' ? stored as Partial<Log> : {};
      const log: Log = { events: readBrowseEvents(stored), since: typeof meta.since === 'number' ? meta.since : 0, lastAt: typeof meta.lastAt === 'number' ? meta.lastAt : 0 };
      const out = await fn(log);
      await chrome.storage.local.set({ [BROWSE_LOG_KEY]: log });

      return out;
    });
    queue = next.catch(() => {});

    return next;
  };

  const assistantOn = (tabId: number) => debuggerAttached(tabId) || [...views.values()].some(view => view.state === 'running' && (!view.page || view.page.tabId === tabId));

  const induce = async (log: Log) => {
    const byDay = new Map<string, string[]>();

    const hostsByDay = new Map<string, Set<string>>();

    for (const event of log.events) {
      byDay.set(event.day, [...byDay.get(event.day) ?? [], event.line]);
      hostsByDay.set(event.day, (hostsByDay.get(event.day) ?? new Set()).add(event.host));
    }

    const days: BrowseDay[] = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-BROWSE_DAY_LIMIT)
      .map(([day, lines]) => ({ day, lines: lines.slice(-BROWSE_LINE_LIMIT).map(l => l.slice(0, 400)), hosts: [...hostsByDay.get(day) ?? []].slice(0, 200) }));
    const dismissed = readDismissed((await chrome.storage.local.get(BROWSE_DISMISSED_KEY))[BROWSE_DISMISSED_KEY]).slice(-500);
    const requestId = crypto.randomUUID();

    const conversationId = deps.selected();

    if (!deps.send({ type: 'browse_habit_request', requestId, conversationId, days, dismissed })) return;
    pending.set(requestId, conversationId);
    log.since = 0;
    log.lastAt = Date.now();
  };

  const record = async (step: BrowseStep, tabId: number, rawUrl: string) => {
    if (!isBrowseOn((await chrome.storage.local.get(BROWSE_ON_KEY))[BROWSE_ON_KEY]) || assistantOn(tabId)) return;
    const url = new URL(rawUrl);
    const at = Date.now();

    await withLog(async log => {
      log.events = [...log.events.filter(e => at - e.at < KEEP_MS), { at, day: localDay(at), host: url.hostname, line: line(step, url, at) }].slice(-MAX_EVENTS);
      log.since += 1;

      if (log.since >= BROWSE_INDUCE_AFTER_STEPS && at - log.lastAt >= BROWSE_INDUCE_EVERY_MS) await induce(log);
    });
  };

  const control = (message: { action?: unknown; key?: unknown }) => withLog(async log => {
    pending.clear();

    if (message.action === 'clear') {
      log.events = [];
      log.since = 0;
      await chrome.storage.local.remove(BROWSE_FOUND_KEY);

      return;
    }

    if (message.action !== 'dismiss' || typeof message.key !== 'string') return;
    const key = message.key;
    const stored = await chrome.storage.local.get([BROWSE_DISMISSED_KEY, BROWSE_FOUND_KEY]);
    await chrome.storage.local.set({
      [BROWSE_DISMISSED_KEY]: [...readDismissed(stored[BROWSE_DISMISSED_KEY]).filter(k => k !== key), key].slice(-500),
      [BROWSE_FOUND_KEY]: readBrowseFound(stored[BROWSE_FOUND_KEY]).filter(h => h.key !== key),
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === BROWSE_CONTROL && sender.id === chrome.runtime.id && isPanelUrl(sender.url)) {
      void control(message).then(() => respond({ ok: true }), () => respond({ ok: false }));

      return true;
    }

    if (message?.type !== BROWSE_EVENT || sender.id !== chrome.runtime.id || !sender.tab?.id || sender.tab.incognito || sender.frameId !== 0 || !nudgeableUrl(sender.url) || !isBrowseStep(message.step)) return;
    if (selfUse()) return;
    void record(message.step, sender.tab.id, sender.url!).catch(() => {});
  });

  return {
    view(view: TaskView) { views.set(view.conversationId, view); },
    disconnected() { views.clear(); pending.clear(); },
    async receive(result: BrowseHabitResult) {
      if (!pending.has(result.requestId) || !result.habits.length) return;
      await withLog(async () => {
        const conversationId = pending.get(result.requestId);

        if (!conversationId || !pending.delete(result.requestId)) return;
        const dismissed = readDismissed((await chrome.storage.local.get(BROWSE_DISMISSED_KEY))[BROWSE_DISMISSED_KEY]);
        const kept = result.habits.filter(h => !dismissed.includes(h.key));
        await chrome.storage.local.set({ [BROWSE_FOUND_KEY]: kept });

        for (const habit of kept) if (habit.ready) deps.send({ type: 'browse_habit_ask', requestId: crypto.randomUUID(), conversationId, key: habit.key });
      });
    },
  };
}
