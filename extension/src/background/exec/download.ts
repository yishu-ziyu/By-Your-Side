/**
 * CAP-02A：下载元数据 / 取消 / 删除登记。
 * 文件由 Chrome 存进用户的下载文件夹；path 只在 chrome.downloads 报完成后给出。
 * 无法关联当前任务的 downloadId 安全失败。
 *
 * Adapted in part from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (MIT).
 * Copyright (c) 2026 CitroLabs — see extension/src/background/page-events.ts for full notice.
 */
import { LEAD_SESSION_ID, type DownloadReceipt, type ToolContract } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";

/** URL 下载不经过 Page.downloadWillBegin，按 Chrome 返回的精确 id 跟踪，避免按 URL 串到另一笔下载。 */
const directDownloads = new Map<string, { chromeId: number; tabId: number; sessionId: string; url: string }>();

class DownloadNotStarted extends Error { readonly executionFact = "not_executed" as const; }

async function directStat(downloadId: string, sessionId: string): Promise<DownloadReceipt | null> {
  const record = directDownloads.get(downloadId);

  if (!record) return null;

  if (record.sessionId !== sessionId) throw new Error("该下载编号不属于当前会话。");
  const [item] = await chrome.downloads.search({ id: record.chromeId });

  if (!item) throw new Error("Chrome 中已找不到这次下载记录。");
  const completed = item.state === "complete";

  const stat: DownloadReceipt = {
    downloadId, tabId: record.tabId, url: record.url,
    suggestedFilename: item.filename.split(/[\\/]/).at(-1) || new URL(record.url).pathname.split("/").at(-1) || "download",
    path: completed ? item.filename : null, failure: item.error ?? null, completed, cancelled: item.error === "USER_CANCELED",
  };

  if (completed) stat.bytes = item.fileSize >= 0 ? item.fileSize : item.bytesReceived;

  if (item.danger !== "safe" && item.danger !== "accepted") stat.danger = item.danger;

  return stat;
}

export async function downloadUrl(params: ToolContract["download_url"]["params"], sessionId = LEAD_SESSION_ID, beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void}): Promise<ToolContract["download_url"]["data"]> {
  let url: URL;

  try { url = new URL(params.url); } catch { throw new DownloadNotStarted("下载地址无效，操作未执行。"); }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DownloadNotStarted("下载链接必须是 HTTP 或 HTTPS 地址，操作未执行。");

  if (params.filename && /[\\/]/.test(params.filename)) throw new DownloadNotStarted("文件名不能包含路径，操作未执行。");
  let tab: chrome.tabs.Tab;

  try { tab = await resolveWorkingTab(params.tabId, sessionId); } catch (error) { throw new DownloadNotStarted(error instanceof Error ? error.message : "无法使用当前页面，下载未执行。"); }

  const options: chrome.downloads.DownloadOptions = { url: url.href, saveAs: false, conflictAction: "uniquify" };

  if (params.filename) options.filename = params.filename;
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  const chromeId = await chrome.downloads.download(options);
  const downloadId = `url-download-${crypto.randomUUID()}`;
  directDownloads.set(downloadId, { chromeId, tabId: tab.id!, sessionId, url: url.href });
  const deadline = Date.now() + Math.min(Math.max(params.timeoutMs ?? 20_000, 1000), 20_000);
  let stat = await directStat(downloadId, sessionId);

  while (stat && !stat.completed && !stat.failure && !stat.danger && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    stat = await directStat(downloadId, sessionId);
  }

  if (!stat) throw new Error("下载已开始，但记录不可用，请在 Chrome 下载列表核查。");

  return stat;
}



