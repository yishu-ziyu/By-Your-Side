/**
 * CAP-02A：下载元数据 / 取消 / 删除登记。
 * 实际文件落在宿主 downloadPath；saveAs/path 轮询由 agent 侧完成（扩展无 Node fs）。
 * 不设 Browser 级全局下载目录；无法关联当前任务的 downloadId 安全失败。
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

function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/")) return `${dir}${name}`;

  return `${dir}/${name}`;
}

export async function downloadStat(
  params: ToolContract["download_stat"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["download_stat"]["data"]> {
  const download = getDownloadRecord(params.downloadId);
  const expected = joinPath(download.downloadPath, download.suggestedFilename);

  return {
    downloadId: download.downloadId,
    tabId: download.tabId,
    url: download.url,
    suggestedFilename: download.suggestedFilename,
    path: download.completed ? (download.tempFile ?? expected) : download.tempFile ?? null,
    failure: download.failure,
    completed: download.completed,
    cancelled: download.cancelled,
    // 额外字段供 agent saveAs 定位临时目录（契约外扩展，序列化进 data 无妨）
    downloadPath: download.downloadPath,
    expectedPath: expected,
  } as ToolContract["download_stat"]["data"] & { downloadPath: string; expectedPath: string };
}

export async function downloadCancel(
  params: ToolContract["download_cancel"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["download_cancel"]["data"]> {
  const download = await cancelDownloadRecord(params.downloadId);

  return { cancelled: true, downloadId: download.downloadId, failure: download.failure };
}

export async function downloadDelete(
  params: ToolContract["download_delete"]["params"],
  _sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["download_delete"]["data"]> {
  deleteDownloadRecord(params.downloadId);

  return { deleted: true, downloadId: params.downloadId };
}
