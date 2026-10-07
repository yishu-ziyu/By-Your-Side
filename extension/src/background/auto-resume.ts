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

export async function autoResumeIfSafe(view: TaskView, send: (msg: ClientMessage) => boolean): Promise<void> {
  if (!canAutoResume(view) || !view.runId || !view.page || claimed.has(view.runId)) return;
  const runId = view.runId;
  claimed.add(runId);
  const saved: { [STORE_KEY]?: unknown } = await chrome.storage.session.get(STORE_KEY).catch(() => ({}));
  const list = saved[STORE_KEY];
  const stored = Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];

  if (stored.includes(runId)) return;
  const tab = await chrome.tabs.get(view.page.tabId).catch(() => null);

  if (!tab?.url) return;
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
      context: { tabId: view.page.tabId, title: tab.title ?? "", url: tab.url },
    },
  });
}
