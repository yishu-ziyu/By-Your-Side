import type { TaskView } from "../../../shared/task-view.js";

const TASK_TABS_KEY = "taskTabs";

/**
 * 记下每个任务保留的那页是哪个标签页。后台进程会被 Chrome 回收、内存里的任务视图跟着没了，
 * 而侧栏卡片上替另开那件点「继续」时要用它（见 taskPageContext）。
 */
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

/** 任务自己保留的那页还开着时，按它现在的网址给出页面上下文；宿主再按 urlHash 核对是不是原页面。 */
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

