import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";

/**
 * 等待标签页加载完成。resolve(true) = 完成；resolve(false) = 超时。
 * 已 complete 的页面立即返回。
 */
export async function waitForLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return true;
  } catch {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (loaded: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(loaded);
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export async function navigate(
  params: {
    url: string;
    timeout?: number;
  },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ url: string; title: string; note?: string }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const timeoutMs = Math.max(1, params.timeout ?? 30) * 1000;

  const loaded = waitForLoad(tab.id, timeoutMs);
  await chrome.tabs.update(tab.id, { url: params.url });
  const ok = await loaded;

  const after = await chrome.tabs.get(tab.id);
  const data = { url: after.url ?? params.url, title: after.title ?? "" };
  // 超时不算失败：页面可能已部分可用
  return ok ? data : { ...data, note: "load timeout" };
}
