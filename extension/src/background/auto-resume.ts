/**
 * 后台（offscreen）重启后自动接着做：安全的中断任务替用户发一次「继续原任务」。
 * 安全条件见 canAutoResume；另外原标签页必须还开着。每个 runId 最多自动接续一次，
 * 记在 chrome.storage.session（service worker 重启也不丢）：再次中断就照旧等用户点。
 * 页面是否仍是原页面由宿主按 urlHash 核对，不符时拒绝，任务仍停在「任务中断了」。
 */
import type { ClientMessage } from "../../../shared/protocol.js";
import { canAutoResume, type TaskView } from "../../../shared/task-view.js";

const STORE_KEY = "autoResumedRuns";

const claimed = new Set<string>();

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

export async function autoResumeIfSafe(view: TaskView, send: (msg: ClientMessage) => boolean): Promise<void> {
  if (!canAutoResume(view) || !view.runId || !view.page || claimed.has(view.runId)) return;
  const runId = view.runId;
  claimed.add(runId);
  const saved: { [STORE_KEY]?: unknown } = await chrome.storage.session.get(STORE_KEY).catch(() => ({}));
  const list = saved[STORE_KEY];
  const stored = Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];

  if (stored.includes(runId)) return;
  const context = await taskPageContext(view.conversationId, view);

  if (!context) return;
  await chrome.storage.session.set({ [STORE_KEY]: [...stored, runId].slice(-50) });
  send({
    type: "task_action",
    conversationId: view.conversationId,
    request: {
      requestId: crypto.randomUUID(),
      conversationId: view.conversationId,
      source: "text",
      action: "resume",
      expectedRunId: runId,
      expectedControlVersion: view.controlVersion,
      text: "继续原任务",
      context,
    },
  });
}
