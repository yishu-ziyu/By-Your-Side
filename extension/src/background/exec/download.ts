/**
 * Adapted in part from citrolabs/ego-lite (MIT).
 * Copyright (c) 2026 CitroLabs — see ../page-events.ts for the full notice.
 */
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { beginTabTransfer, resolveWorkingTab } from "../state.js";
import { ensureAttached } from "../debugger.js";
import { withTimeout } from "../timeout.js";
import { captureDirectLink } from "../download-capture.js";
import { disarmEvent, waitEvent } from "./page-events.js";
import { armEventForTab } from "../page-events.js";

class DownloadNotStarted extends Error { readonly executionFact = "not_executed" as const; }

export async function downloadUrl(params: ToolContract["download_url"]["params"], sessionId = LEAD_SESSION_ID, beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void}): Promise<ToolContract["download_url"]["data"]> {
  let url: URL;
  try { url = new URL(params.url); } catch { throw new DownloadNotStarted("下载地址无效，操作未执行。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DownloadNotStarted("下载链接必须是 HTTP 或 HTTPS 地址，操作未执行。");
  if (params.filename && /[\\/]/.test(params.filename)) throw new DownloadNotStarted("文件名不能包含路径，操作未执行。");
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  if (tab.id == null) throw new DownloadNotStarted("工作标签页无效，下载未执行。");
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 20_000, 1000), 20_000);
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  // A private background tab keeps failed downloads and redirects away from the user's working document.
  const downloadTab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: tab.windowId });
  if (downloadTab.id == null) throw new DownloadNotStarted("无法准备下载，操作未执行。");
  const release = beginTabTransfer(downloadTab.id, sessionId);
  let token: string | undefined;
  try {
    await ensureAttached(downloadTab.id);
    const arm = await armEventForTab({ tabId: downloadTab.id, type: "download", sessionKey: sessionId, timeoutMs: timeoutMs + 15000 });
    token = arm.token;
    captureDirectLink(downloadTab.id, token, url.href, params.filename);
    beforeDispatch?.checkNow?.();
    // Chrome still downloads the original response and decides its safety; no second GET or local-path access.
    const navigation = await withTimeout(chrome.debugger.sendCommand({ tabId: downloadTab.id }, "Page.navigate", { url: url.href }), timeoutMs + 10_000, "下载响应超时，请先在 Chrome 下载列表核查，不要重复下载。") as { errorText?: string; isDownload?: boolean };
    if (navigation.errorText && !navigation.isDownload && navigation.errorText !== "net::ERR_ABORTED") {
      return { downloadId: token, tabId: tab.id, url: url.href, suggestedFilename: params.filename ?? url.pathname.split("/").at(-1) ?? "download",
        completed: false, cancelled: false, path: null, failure: navigation.errorText };
    }
    const result = await waitEvent({ token, timeoutMs }, sessionId);
    if (!result.download) throw new Error("下载记录不可用，请在 Chrome 下载列表核查。");
    return { ...result.download, tabId: tab.id, path: result.download.path ?? null, cancelled: result.download.failure === "USER_CANCELED" };
  } finally {
    if (token) await disarmEvent({ token }, sessionId).catch(() => {});
    await chrome.tabs.remove(downloadTab.id).catch(() => {});
    release();
  }
}
