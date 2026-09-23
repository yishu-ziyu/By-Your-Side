/**
 * CAP-02A：Page / Target 事件订阅与 arm 账本。
 * 独立于 network-log 的 Network.* listener（不建第二套网络监听）。
 *
 * Download arming uses Page.setDownloadBehavior on the page session only
 * (never Browser-level global download directory), adapted from
 * citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (MIT).
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
  applyDownloadProgress,
  armPageEvent,
  armPayload,
  cancelArm,
  clearPendingDialog,
  consumeArm,
  consumeBufferedEvents,
  createPageEventLedger,
  disposeSessionArms,
  disposeTabArms,
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

    for (const [token, timer] of [...armTimers]) {
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

    if (matched) notifyWaiters(matched.arm);

    return;
  }

  if (method === "Page.downloadProgress") {
    const guid = params.guid;
    const state = params.state;

    if (typeof guid !== "string") return;

    if (state !== "completed" && state !== "canceled" && state !== "inProgress") return;
    // 临时文件落在宿主 downloadPath；扩展 SW 无 Node fs，由 agent 侧轮询目录。
    applyDownloadProgress(ledger, { guid, state });
  }
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
  downloadPath?: string;
}): Promise<ArmedPageEvent> {
  await enablePageEventCapture(input.tabId);

  const arm = armPageEvent(ledger, {
    kind: input.type,
    tabId: input.tabId,
    sessionKey: input.sessionKey,
    timeoutMs: input.timeoutMs,
    downloadPath: input.downloadPath,
  });

  hold(arm);

  try {
    if (input.type === "download") {
      // Never drop the authorized output path and pretend the same download
      // contract still holds. Unsupported browser-level configuration is a gap.
      try {
        await chrome.debugger.sendCommand({ tabId: input.tabId }, "Page.setDownloadBehavior", {
          behavior: "allow",
          ...(input.downloadPath ? { downloadPath: input.downloadPath } : {}),
          eventsEnabled: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`DOWNLOAD_ARM_CDP: Page.setDownloadBehavior failed (${message.slice(0, 160)}). Arm not active.`);
      }
    }

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
    if (arm.kind === "download") {
      await chrome.debugger.sendCommand({ tabId: arm.tabId }, "Page.setDownloadBehavior", {
        behavior: "default",
      });
    }

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

    return armPayload(consumed);
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

  return armPayload(consumed);
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
  await chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", {
    accept,
    ...(accept && promptText !== undefined ? { promptText } : {}),
  });
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

  if (download.completed || download.cancelled) return download;

  try {
    await chrome.debugger.sendCommand({ tabId: download.tabId }, "Browser.cancelDownload", {
      guid: download.guid,
    });
  } catch (error) {
    if (!download.completed) throw error;
  }

  applyDownloadProgress(ledger, { guid: download.guid, state: "canceled" });

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

