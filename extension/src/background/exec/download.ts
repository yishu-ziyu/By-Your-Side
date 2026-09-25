/**
 * CAP-02A：下载元数据 / 取消 / 删除登记。
 * 文件由 Chrome 存进用户的下载文件夹；path 只在 chrome.downloads 报完成后给出。
 * 无法关联当前任务的 downloadId 安全失败。
 *
 * Adapted in part from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (MIT).
 * Copyright (c) 2026 CitroLabs — see extension/src/background/page-events.ts for full notice.
 */
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import {
  cancelDownloadRecord,
  deleteDownloadRecord,
  getDownloadRecord,
} from "../page-events.js";

export async function downloadStat(
  params: ToolContract["download_stat"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["download_stat"]["data"]> {
  const download = getDownloadRecord(params.downloadId);

  const stat: ToolContract["download_stat"]["data"] = {
    downloadId: download.downloadId,
    tabId: download.tabId,
    url: download.url,
    suggestedFilename: download.suggestedFilename,
    path: download.completed ? download.path ?? null : null,
    failure: download.failure,
    completed: download.completed,
    cancelled: download.cancelled,
  };

  if (download.completed && download.bytes !== undefined) stat.bytes = download.bytes;

  if (download.danger) stat.danger = download.danger;

  return stat;
}

export async function downloadCancel(
  params: ToolContract["download_cancel"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["download_cancel"]["data"]> {
  const download = await cancelDownloadRecord(params.downloadId);

  return { cancelled: download.cancelled, completed: download.completed, downloadId: download.downloadId, failure: download.failure };
}

export async function downloadDelete(
  params: ToolContract["download_delete"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["download_delete"]["data"]> {
  deleteDownloadRecord(params.downloadId);

  return { deleted: true, downloadId: params.downloadId };
}
