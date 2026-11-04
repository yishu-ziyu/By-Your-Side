import type { TaskView } from "../../../shared/task-view.js";

const TASK_TABS_KEY = "taskTabs";

export function rememberTaskTab(view: TaskView): void {
  const page = view.page;

  if (!page) return;
  void chrome.storage.session.get(TASK_TABS_KEY).then((saved: { [TASK_TABS_KEY]?: unknown }) => {
    const raw = saved[TASK_TABS_KEY];
    const tabs: Record<string, number> = raw && typeof raw === "object" ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => Number.isSafeInteger(e[1]))) : {};

    if (tabs[view.conversationId] === page.tabId) return;
    delete tabs[view.conversationId];
    tabs[view.conversationId] = page.tabId;

    return chrome.storage.session.set({ [TASK_TABS_KEY]: Object.fromEntries(Object.entries(tabs).slice(-50)) });
  }).catch(() => undefined);
}

export async function taskPageContext(conversationId: string, view?: TaskView): Promise<{ tabId: number; title: string; url: string } | null> {
  let tabId = view?.page?.tabId;

  if (tabId === undefined) {
    const saved: { [TASK_TABS_KEY]?: Record<string, unknown> } = await chrome.storage.session.get(TASK_TABS_KEY).catch(() => ({}));
    const stored = saved[TASK_TABS_KEY]?.[conversationId];
    tabId = Number.isSafeInteger(stored) ? stored as number : undefined;
  }

  if (tabId === undefined) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  return tab?.url ? { tabId, title: tab.title ?? "", url: tab.url } : null;
}

