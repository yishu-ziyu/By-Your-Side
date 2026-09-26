/**
 * CAP-02A：Page / Target 事件订阅与 arm 账本。
 * 独立于 network-log 的 Network.* listener（不建第二套网络监听）。
 *
 * Download arming ties Page.downloadWillBegin to the armed tab, adapted from
 * citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (MIT). The file is
 * written by Chrome into the user's download folder; whether it finished is read
 * only from chrome.downloads (Page.setDownloadBehavior is browser-level and the
 * extension debugger channel rejects it).
 *
 * Copyright (c) 2026 CitroLabs
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  applyChromeDownload,
  armPageEvent,
  armPayload,
  bindChromeDownload,
  cancelArm,
  clearPendingDialog,
  consumeArm,
  consumeBufferedEvents,
  createPageEventLedger,
  disposeSessionArms,
  disposeTabArms,
  downloadSettled,
  findDownload,
  getArm,
  markArmTimedOut,
  markDownloadDeleted,
  matchDownloadBegin,
  matchFileChooser,
  matchPopup,
  pendingDialog,
  requireArm,
  setPendingDialog,
  type ArmedPageEvent,
  type ChromeDownloadState,
  type DownloadRecord,
  type JsDialogType,
  type PageEventKind,
} from "../../../shared/page-event-ledger.js";

const ledger = createPageEventLedger();

const enabled = new Set<number>();

const armTimers = new Map<string, ReturnType<typeof setTimeout>>();

const waiters = new Map<string, Array<{ resolve: (arm: ArmedPageEvent) => void; reject: (err: Error) => void }>>();

const heldArmTokens = new Set<string>();

let listening = false;

let tabsListening = false;

let downloadsListening = false;

/** 下载结束前 wait_event 最多再等多久；只有 chrome.downloads 报 complete 才算下载完成。 */
const DOWNLOAD_SETTLE_MS = 60_000;

/** chrome.downloads 先于 Page.downloadWillBegin 到达时暂存，按 URL 等对方。 */
const unboundChromeDownloads = new Map<number, { url: string; finalUrl?: string; at: number }>();

const UNBOUND_TTL_MS = 30_000;

const downloadWaiters = new Map<string, Array<() => void>>();

type AttachHoldFn = (tabId: number) => void;

let holdAttachFn: AttachHoldFn | null = null;

let releaseAttachHoldFn: AttachHoldFn | null = null;

/** 打破与 debugger.ts 的循环依赖：由 index/exec 在加载后注入。 */
export function bindAttachHolds(hold: AttachHoldFn, release: AttachHoldFn): void {
  holdAttachFn = hold;
  releaseAttachHoldFn = release;
}

function hold(arm: ArmedPageEvent): void {
  if (heldArmTokens.has(arm.token)) return;
  heldArmTokens.add(arm.token);
  holdAttachFn?.(arm.tabId);
}

function release(arm: ArmedPageEvent): void {
  if (heldArmTokens.delete(arm.token)) releaseAttachHoldFn?.(arm.tabId);
}

function listenPageEvents(): void {
  if (listening) return;
  const events = chrome.debugger?.onEvent;

  if (!events?.addListener) return;
  listening = true;
  events.addListener((source, method, params) => {
    if (source.tabId == null) return;

    // 故意不处理 Network.* —— 留给 network-log 唯一监听器。
    if (method.startsWith("Network.")) return;
    void onDebuggerEvent(source.tabId, method, (params ?? {}) as Record<string, unknown>);
  });
}

function listenTabPopups(): void {
  if (tabsListening) return;

  if (!chrome.tabs?.onCreated?.addListener) return;
  tabsListening = true;
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id == null || tab.openerTabId == null) return;

    const matched = matchPopup(ledger, {
      openerTabId: tab.openerTabId,
      popupTabId: tab.id,
      url: tab.url || tab.pendingUrl,
    });

    if (matched) notifyWaiters(matched);
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    disposeTabArms(ledger, tabId, "page destroyed");

    for (const [token, timer] of armTimers) {
      const arm = getArm(ledger, token);

      if (arm?.tabId === tabId) {
        clearTimeout(timer);
        armTimers.delete(token);
        release(arm);
        rejectWaiters(token, new Error("page destroyed"));
      }
    }
  });
}

async function onDebuggerEvent(tabId: number, method: string, params: Record<string, unknown>): Promise<void> {
  if (method === "Page.javascriptDialogOpening") {
    const type = String(params.type ?? "alert") as JsDialogType;

    if (type !== "alert" && type !== "confirm" && type !== "prompt" && type !== "beforeunload") return;
    setPendingDialog(ledger, {
      type,
      message: String(params.message ?? ""),
      tabId,
      defaultPrompt: typeof params.defaultPrompt === "string" ? params.defaultPrompt : undefined,
      openedAt: Date.now(),
    });

    return;
  }

  if (method === "Page.javascriptDialogClosed") {
    clearPendingDialog(ledger, tabId);

    return;
  }

  if (method === "Page.fileChooserOpened") {
    const backendNodeId = Number(params.backendNodeId);

    if (!Number.isFinite(backendNodeId)) return;

    const matched = matchFileChooser(ledger, {
      tabId,
      backendNodeId,
      mode: typeof params.mode === "string" ? params.mode : undefined,
    });

    if (matched) notifyWaiters(matched);

    return;
  }

  if (method === "Page.downloadWillBegin") {
    const guid = params.guid;
    const url = params.url;
    const suggestedFilename = params.suggestedFilename;

    if (typeof guid !== "string" || typeof url !== "string" || typeof suggestedFilename !== "string") return;
    const matched = matchDownloadBegin(ledger, { tabId, guid, url, suggestedFilename });

    if (!matched) return;

    for (const [chromeId, item] of unboundChromeDownloads) {
      if (bindChromeDownload(ledger, { chromeId, url: item.url, finalUrl: item.finalUrl })?.downloadId !== matched.download.downloadId) continue;
      unboundChromeDownloads.delete(chromeId);
      await refreshChromeDownload(chromeId);
      break;
    }

    notifyWaiters(matched.arm);
  }

  // Page.downloadProgress 故意不处理：CDP 把中断也报成 canceled，完成与否只认 chrome.downloads。
}

function listenDownloads(): void {
  if (downloadsListening) return;

  if (!chrome.downloads?.onCreated?.addListener) return;
  downloadsListening = true;
  chrome.downloads.onCreated.addListener((item) => {
    const now = Date.now();

    for (const [id, pending] of unboundChromeDownloads) if (now - pending.at > UNBOUND_TTL_MS) unboundChromeDownloads.delete(id);

    if (bindChromeDownload(ledger, { chromeId: item.id, url: item.url, finalUrl: item.finalUrl })) {
      void refreshChromeDownload(item.id);

      return;
    }

    unboundChromeDownloads.set(item.id, { url: item.url, finalUrl: item.finalUrl, at: now });
  });
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state || delta.error || delta.filename || delta.danger) void refreshChromeDownload(delta.id);
  });
}

/** 按 chrome.downloads 当前记录更新账本；完成时的路径和字节数也从这里读。 */
async function refreshChromeDownload(chromeId: number): Promise<void> {
  const [item] = await chrome.downloads.search({ id: chromeId }).catch(() => []);

  if (!item) return;

  // SAFETY: chrome.downloads.State 只有 in_progress / interrupted / complete 三个值，与 ChromeDownloadState 相同。
  const download = applyChromeDownload(ledger, {
    chromeId,
    state: item.state as ChromeDownloadState,
    error: item.error,
    filename: item.filename || undefined,
    bytes: item.fileSize >= 0 ? item.fileSize : item.bytesReceived,
    danger: item.danger,
  });

  if (download && downloadSettled(download)) notifyDownloadWaiters(download.downloadId);
}

function notifyDownloadWaiters(downloadId: string): void {
  const list = downloadWaiters.get(downloadId);

  if (!list?.length) return;
  downloadWaiters.delete(downloadId);

  for (const done of list) done();
}

/** 等到 chrome.downloads 报完成或中断；超时就原样返回，由调用方如实说「还没下完」。 */
async function waitDownloadSettled(downloadId: string, timeoutMs: number): Promise<void> {
  const download = ledger.downloads.get(downloadId);

  if (!download || downloadSettled(download)) return;

  if (download.chromeId !== undefined) await refreshChromeDownload(download.chromeId);

  if (downloadSettled(download)) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, timeoutMs);

    function finish(): void {
      clearTimeout(timer);
      const list = downloadWaiters.get(downloadId);
      const index = list?.indexOf(finish) ?? -1;

      if (list && index >= 0) list.splice(index, 1);
      resolve();
    }

    const list = downloadWaiters.get(downloadId) ?? [];
    list.push(finish);
    downloadWaiters.set(downloadId, list);
  });
}

function notifyWaiters(arm: ArmedPageEvent): void {
  const list = waiters.get(arm.token);

  if (!list?.length) return;
  waiters.delete(arm.token);

  for (const w of list) w.resolve(arm);
}

function rejectWaiters(token: string, error: Error): void {
  const list = waiters.get(token);

  if (!list?.length) return;
  waiters.delete(token);

  for (const w of list) w.reject(error);
}

function clearArmTimer(token: string): void {
  const timer = armTimers.get(token);

  if (timer) clearTimeout(timer);
  armTimers.delete(token);
}

/** 幂等开启 Page 域；调用方已 attach。不碰 Network。 */
export async function enablePageEventCapture(tabId: number, _opts?: { mode?: "fresh" | "late" }): Promise<void> {
  listenPageEvents();
  listenTabPopups();
  listenDownloads();

  if (enabled.has(tabId)) return;
  enabled.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  } catch {
    enabled.delete(tabId);
  }
}

export function notePageEventsDetached(tabId: number): void {
  enabled.delete(tabId);
  disposeTabArms(ledger, tabId, "CAPTURE_INCOMPLETE: debugger detached; arm a new event after observing again");

  for (const arm of ledger.arms.values()) {
    if (arm.tabId !== tabId) continue;
    clearArmTimer(arm.token);
    release(arm);
    rejectWaiters(arm.token, new Error("CAPTURE_INCOMPLETE: debugger detached"));
  }
}

export function pageEventLedger() {
  return ledger;
}

export async function armEventForTab(input: {
  tabId: number;
  sessionKey: string;
  type: PageEventKind;
  timeoutMs?: number;
}): Promise<ArmedPageEvent> {
  // 没有 downloads 权限就收不到完成与否，不能接下载。
  if (input.type === "download" && !chrome.downloads?.onCreated) {
    throw new Error("DOWNLOAD_API_UNAVAILABLE: chrome.downloads is not available; page downloads cannot be confirmed.");
  }

  await enablePageEventCapture(input.tabId);

  const arm = armPageEvent(ledger, {
    kind: input.type,
    tabId: input.tabId,
    sessionKey: input.sessionKey,
    timeoutMs: input.timeoutMs,
  });

  hold(arm);

  try {
    if (input.type === "filechooser") {
      await chrome.debugger.sendCommand({ tabId: input.tabId }, "Page.setInterceptFileChooserDialog", {
        enabled: true,
      });
    }

    armTimers.set(
      arm.token,
      setTimeout(() => {
        const current = getArm(ledger, arm.token);

        if (!current || (current.status !== "armed" && current.status !== "matched")) return;

        if (current.status === "matched") cancelArm(ledger, arm.token, "event token expired before consumption");
        else markArmTimedOut(ledger, arm.token);
        void resetArmSideEffects(current).finally(() => {
          release(current);
          rejectWaiters(arm.token, new Error(current.disposedReason ?? "event timed out"));
        });
      }, arm.timeoutMs),
    );

    return arm;
  } catch (error) {
    cancelArm(ledger, arm.token, "event setup failed");
    clearArmTimer(arm.token);
    release(arm);
    throw error;
  }
}

async function resetArmSideEffects(arm: ArmedPageEvent): Promise<void> {
  clearArmTimer(arm.token);

  try {
    if (arm.kind === "filechooser") {
      await chrome.debugger.sendCommand({ tabId: arm.tabId }, "Page.setInterceptFileChooserDialog", {
        enabled: false,
      });
    }
  } catch {
    /* detach / 页面已毁 */
  }
}

export async function waitArmedEvent(token: string, timeoutMs?: number): Promise<ReturnType<typeof armPayload>> {
  const arm = requireArm(ledger, token);

  if (arm.status === "matched") {
    const consumed = consumeArm(ledger, token);
    await resetArmSideEffects(consumed);
    release(consumed);

    if (consumed.downloadId) await waitDownloadSettled(consumed.downloadId, downloadSettleMs(timeoutMs));

    return armPayload(consumed, ledger.downloads);
  }

  if (arm.status !== "armed") {
    throw new Error(`INVALID_ARGUMENT: event token is ${arm.status}`);
  }

  const waitMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(Math.max(Math.floor(timeoutMs), 1), arm.timeoutMs)
    : Math.max(1, arm.timeoutMs - (Date.now() - arm.createdAt));

  const matched = await new Promise<ArmedPageEvent>((resolve, reject) => {
    const list = waiters.get(token) ?? [];
    list.push({ resolve, reject });
    waiters.set(token, list);

    const timer = setTimeout(() => {
      const still = getArm(ledger, token);

      if (still?.status === "armed") {
        markArmTimedOut(ledger, token);
        void resetArmSideEffects(still).finally(() => {
          release(still);
          rejectWaiters(token, new Error(still.disposedReason ?? `wait_event timed out after ${waitMs}ms`));
        });
      }
    }, waitMs);

    const prevReject = reject;
    const prevResolve = resolve;
    const idx = list.length - 1;
    list[idx] = {
      resolve: (a) => {
        clearTimeout(timer);
        prevResolve(a);
      },
      reject: (e) => {
        clearTimeout(timer);
        prevReject(e);
      },
    };
  });

  const consumed = consumeArm(ledger, matched.token);
  await resetArmSideEffects(consumed);
  release(consumed);

  if (consumed.downloadId) await waitDownloadSettled(consumed.downloadId, downloadSettleMs(timeoutMs));

  return armPayload(consumed, ledger.downloads);
}

/** 下载开始后另给一段等完成的时间；调用方给了更长的 timeoutMs 就按它。 */
function downloadSettleMs(timeoutMs?: number): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, DOWNLOAD_SETTLE_MS), 120_000) : DOWNLOAD_SETTLE_MS;
}

export async function disarmArmedEvent(token: string): Promise<ArmedPageEvent> {
  const arm = cancelArm(ledger, token, "disarmed");

  if (!heldArmTokens.has(arm.token)) return arm;
  await resetArmSideEffects(arm);
  release(arm);
  rejectWaiters(token, new Error("event disarmed"));

  return arm;
}

export function readDialogInfo(tabId: number) {
  const dialog = pendingDialog(ledger, tabId);

  if (!dialog) return { dialog: null as null };

  return {
    dialog: {
      type: dialog.type,
      message: dialog.message,
      tabId: dialog.tabId,
      url: dialog.url,
      defaultPrompt: dialog.defaultPrompt,
    },
  };
}

export async function handleJsDialog(
  tabId: number,
  accept: boolean,
  promptText?: string,
): Promise<{ ok: boolean; dialog?: { type: string; message: string; tabId: number; url?: string } }> {
  const dialog = pendingDialog(ledger, tabId);

  if (!dialog) return { ok: false };

  // promptText 只在 accept 且调用方给了值时才带上；缺省时这个键不出现。
  if (accept && promptText !== undefined) {
    await chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept, promptText });
  } else {
    await chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept });
  }

  clearPendingDialog(ledger, tabId);

  return {
    ok: true,
    dialog: { type: dialog.type, message: dialog.message, tabId: dialog.tabId, url: dialog.url },
  };
}

export function consumeTabEvents(tabId: number, clear = true) {
  return {
    tabId,
    events: consumeBufferedEvents(ledger, tabId, clear).map((e) => ({
      kind: e.kind,
      at: e.at,
      payload: e.payload,
    })),
  };
}

export function getDownloadRecord(downloadId: string): DownloadRecord {
  return findDownload(ledger, downloadId);
}

export function getChooserArmById(chooserId: string): ArmedPageEvent {
  for (const arm of ledger.arms.values()) {
    if (arm.chooserId === chooserId) {
      if (arm.kind !== "filechooser") continue;

      if (arm.status !== "matched" && arm.status !== "consumed") {
        throw new Error("INVALID_ARGUMENT: file chooser is not ready");
      }

      return arm;
    }
  }

  throw new Error("INVALID_ARGUMENT: unknown or expired chooserId");
}

export async function cancelDownloadRecord(downloadId: string): Promise<DownloadRecord> {
  const download = findDownload(ledger, downloadId);

  if (downloadSettled(download)) return download;

  if (download.chromeId === undefined) {
    throw new Error("DOWNLOAD_NOT_TRACKED: Chrome downloads has not reported this download yet; nothing was cancelled.");
  }

  await chrome.downloads.cancel(download.chromeId);
  await refreshChromeDownload(download.chromeId);

  return findDownload(ledger, downloadId);
}

export function deleteDownloadRecord(downloadId: string): void {
  findDownload(ledger, downloadId);
  markDownloadDeleted(ledger, downloadId);
}

export function stopSessionPageEvents(sessionKey: string): number {
  const n = disposeSessionArms(ledger, sessionKey, "session stopped");

  for (const [token, arm] of ledger.arms) {
    if (arm.sessionKey !== sessionKey || !heldArmTokens.has(token)) continue;
    clearArmTimer(token);
    release(arm);
    rejectWaiters(token, new Error("session stopped"));
    void resetArmSideEffects(arm);
  }

  return n;
}

