/**
 * CAP-02A page event arm / wait / consume ledger (pure state).
 *
 * Portions of the download arming / Page.setDownloadBehavior-per-session
 * approach are adapted from citrolabs/ego-lite
 * @ dca7003349c5f7132189ba00547cbbd7ff8e597e (MIT License).
 *
 * Copyright (c) 2026 CitroLabs
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Host generates tokens; models must not mint them. Arms are page/tab scoped so
 * two tabs with the same filename cannot cross-consume.
 */

export type PageEventKind = "popup" | "download" | "filechooser";

export type JsDialogType = "alert" | "confirm" | "prompt" | "beforeunload";

export interface PendingJsDialog {
  type: JsDialogType;
  message: string;
  tabId: number;
  url?: string;
  defaultPrompt?: string;
  openedAt: number;
}

export interface BufferedPageEvent {
  kind: PageEventKind | "dialog";
  tabId: number;
  at: number;
  payload: Record<string, unknown>;
}

export type ArmStatus =
  | "armed"
  | "matched"
  | "consumed"
  | "timed_out"
  | "cancelled"
  | "disposed";

export interface ArmedPageEvent {
  token: string;
  kind: PageEventKind;
  tabId: number;
  sessionKey: string;
  createdAt: number;
  timeoutMs: number;
  status: ArmStatus;
  /** Download-only: absolute temp directory for Page.setDownloadBehavior. */
  downloadPath?: string;
  downloadId?: string;
  downloadGuid?: string;
  downloadUrl?: string;
  suggestedFilename?: string;
  downloadFailure?: string | null;
  downloadTempFile?: string;
  downloadCompleted?: boolean;
  /** File-chooser-only */
  backendNodeId?: number;
  multiple?: boolean;
  chooserId?: string;
  /** Popup-only */
  popupTabId?: number;
  popupUrl?: string;
  popupTargetId?: string;
  matchedAt?: number;
  consumedAt?: number;
  disposedReason?: string;
}

export interface DownloadRecord {
  downloadId: string;
  token: string;
  tabId: number;
  guid: string;
  url: string;
  suggestedFilename: string;
  downloadPath: string;
  tempFile?: string;
  failure: string | null;
  completed: boolean;
  cancelled: boolean;
  deleted: boolean;
  createdAt: number;
}

export interface PageEventLedger {
  arms: Map<string, ArmedPageEvent>;
  downloads: Map<string, DownloadRecord>;
  /** tabId → pending JS dialog (webpage only; never OS permission prompts). */
  dialogs: Map<number, PendingJsDialog>;
  /** Per-tab ring of recently observed protocol events. */
  buffers: Map<number, BufferedPageEvent[]>;
  seq: number;
}

export const DEFAULT_EVENT_TIMEOUT_MS = 10_000;

export const MAX_EVENT_TIMEOUT_MS = 120_000;

export const MAX_BUFFER_PER_TAB = 32;

export const MAX_ARMS = 64;

export function createPageEventLedger(): PageEventLedger {
  return {
    arms: new Map(),
    downloads: new Map(),
    dialogs: new Map(),
    buffers: new Map(),
    seq: 0,
  };
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return DEFAULT_EVENT_TIMEOUT_MS;

  return Math.min(Math.max(Math.floor(ms), 1), MAX_EVENT_TIMEOUT_MS);
}

function mintToken(ledger: PageEventLedger, kind: PageEventKind, tabId: number): string {
  ledger.seq += 1;
  const rand = Math.random().toString(36).slice(2, 10);

  return `evt_${kind}_${tabId}_${ledger.seq}_${rand}`;
}

function mintDownloadId(ledger: PageEventLedger): string {
  ledger.seq += 1;

  return `dl_${ledger.seq}_${Math.random().toString(36).slice(2, 8)}`;
}

function mintChooserId(ledger: PageEventLedger): string {
  ledger.seq += 1;

  return `fc_${ledger.seq}_${Math.random().toString(36).slice(2, 8)}`;
}

function pushBuffer(ledger: PageEventLedger, event: BufferedPageEvent): void {
  const list = ledger.buffers.get(event.tabId) ?? [];
  list.push(event);

  while (list.length > MAX_BUFFER_PER_TAB) list.shift();
  ledger.buffers.set(event.tabId, list);
}

/** Reject model-minted tokens: only host-issued `evt_*` shapes are valid. */
export function isHostEventToken(token: unknown): token is string {
  return typeof token === "string" && /^evt_(popup|download|filechooser)_\d+_\d+_[a-z0-9]+$/i.test(token);
}

export function armPageEvent(
  ledger: PageEventLedger,
  input: {
    kind: PageEventKind;
    tabId: number;
    sessionKey: string;
    timeoutMs?: number;
    downloadPath?: string;
    now?: number;
  },
): ArmedPageEvent {
  if (ledger.arms.size >= MAX_ARMS) {
    throw new Error("INVALID_ARGUMENT: too many armed page events; wait or disarm first");
  }

  for (const arm of ledger.arms.values()) {
    if (
      arm.tabId === input.tabId &&
      arm.kind === input.kind &&
      (arm.status === "armed" || arm.status === "matched")
    ) {
      throw new Error(`INVALID_ARGUMENT: tab ${input.tabId} already has an active ${input.kind} wait`);
    }
  }

  if (input.kind === "download") {
    if (typeof input.downloadPath !== "string" || !input.downloadPath.startsWith("/") || input.downloadPath.includes("\0")) {
      throw new Error("INVALID_ARGUMENT: download arm requires an absolute downloadPath");
    }
  }

  const now = input.now ?? Date.now();

  const arm: ArmedPageEvent = {
    token: mintToken(ledger, input.kind, input.tabId),
    kind: input.kind,
    tabId: input.tabId,
    sessionKey: input.sessionKey,
    createdAt: now,
    timeoutMs: clampTimeout(input.timeoutMs),
    status: "armed",
  };

  if (input.kind === "download") arm.downloadPath = input.downloadPath;

  ledger.arms.set(arm.token, arm);

  return arm;
}

export function getArm(ledger: PageEventLedger, token: string): ArmedPageEvent | undefined {
  return ledger.arms.get(token);
}

export function requireArm(ledger: PageEventLedger, token: unknown): ArmedPageEvent {
  if (!isHostEventToken(token)) {
    throw new Error("INVALID_ARGUMENT: unknown or model-minted event token");
  }

  const arm = ledger.arms.get(token);

  if (!arm) throw new Error("INVALID_ARGUMENT: unknown or expired event token");

  return arm;
}

export function matchPopup(
  ledger: PageEventLedger,
  input: { openerTabId: number; popupTabId: number; url?: string; targetId?: string; now?: number },
): ArmedPageEvent | undefined {
  const now = input.now ?? Date.now();

  for (const arm of ledger.arms.values()) {
    if (arm.kind !== "popup" || arm.status !== "armed" || arm.tabId !== input.openerTabId) continue;
    arm.status = "matched";
    arm.matchedAt = now;
    arm.popupTabId = input.popupTabId;
    arm.popupUrl = input.url;
    arm.popupTargetId = input.targetId;
    pushBuffer(ledger, {
      kind: "popup",
      tabId: arm.tabId,
      at: now,
      payload: {
        token: arm.token,
        popupTabId: input.popupTabId,
        url: input.url,
        targetId: input.targetId,
      },
    });

    return arm;
  }

  return undefined;
}

export function matchDownloadBegin(
  ledger: PageEventLedger,
  input: {
    tabId: number;
    guid: string;
    url: string;
    suggestedFilename: string;
    now?: number;
  },
): { arm: ArmedPageEvent; download: DownloadRecord } | undefined {
  const now = input.now ?? Date.now();

  for (const arm of ledger.arms.values()) {
    if (arm.kind !== "download" || arm.status !== "armed" || arm.tabId !== input.tabId) continue;

    if (!arm.downloadPath) continue;
    const downloadId = mintDownloadId(ledger);
    arm.status = "matched";
    arm.matchedAt = now;
    arm.downloadId = downloadId;
    arm.downloadGuid = input.guid;
    arm.downloadUrl = input.url;
    arm.suggestedFilename = input.suggestedFilename;
    arm.downloadFailure = null;
    arm.downloadCompleted = false;

    const download: DownloadRecord = {
      downloadId,
      token: arm.token,
      tabId: arm.tabId,
      guid: input.guid,
      url: input.url,
      suggestedFilename: input.suggestedFilename,
      downloadPath: arm.downloadPath,
      failure: null,
      completed: false,
      cancelled: false,
      deleted: false,
      createdAt: now,
    };

    ledger.downloads.set(downloadId, download);
    pushBuffer(ledger, {
      kind: "download",
      tabId: arm.tabId,
      at: now,
      payload: {
        token: arm.token,
        downloadId,
        url: input.url,
        suggestedFilename: input.suggestedFilename,
      },
    });

    return { arm, download };
  }

  return undefined;
}

export function applyDownloadProgress(
  ledger: PageEventLedger,
  input: { guid: string; state: "inProgress" | "completed" | "canceled"; tempFile?: string; now?: number },
): DownloadRecord | undefined {
  for (const download of ledger.downloads.values()) {
    if (download.guid !== input.guid) continue;

    if (download.deleted) return download;

    if (input.state === "completed") {
      download.completed = true;
      download.failure = null;

      if (input.tempFile) download.tempFile = input.tempFile;
      const arm = ledger.arms.get(download.token);

      if (arm) {
        arm.downloadCompleted = true;
        arm.downloadFailure = null;

        if (input.tempFile) arm.downloadTempFile = input.tempFile;
      }
    } else if (input.state === "canceled") {
      download.cancelled = true;
      download.failure = "canceled";
      const arm = ledger.arms.get(download.token);

      if (arm) {
        arm.downloadCompleted = false;
        arm.downloadFailure = "canceled";
      }
    }

    return download;
  }

  return undefined;
}

export function matchFileChooser(
  ledger: PageEventLedger,
  input: {
    tabId: number;
    backendNodeId: number;
    mode?: string;
    now?: number;
  },
): ArmedPageEvent | undefined {
  const now = input.now ?? Date.now();

  for (const arm of ledger.arms.values()) {
    if (arm.kind !== "filechooser" || arm.status !== "armed" || arm.tabId !== input.tabId) continue;
    arm.status = "matched";
    arm.matchedAt = now;
    arm.backendNodeId = input.backendNodeId;
    arm.multiple = input.mode === "selectMultiple";
    arm.chooserId = mintChooserId(ledger);
    pushBuffer(ledger, {
      kind: "filechooser",
      tabId: arm.tabId,
      at: now,
      payload: {
        token: arm.token,
        chooserId: arm.chooserId,
        backendNodeId: input.backendNodeId,
        multiple: arm.multiple,
      },
    });

    return arm;
  }

  return undefined;
}

export function setPendingDialog(
  ledger: PageEventLedger,
  dialog: PendingJsDialog,
): void {
  ledger.dialogs.set(dialog.tabId, dialog);
  pushBuffer(ledger, {
    kind: "dialog",
    tabId: dialog.tabId,
    at: dialog.openedAt,
    payload: {
      type: dialog.type,
      message: dialog.message,
      url: dialog.url,
      defaultPrompt: dialog.defaultPrompt,
    },
  });
}

export function clearPendingDialog(ledger: PageEventLedger, tabId: number): PendingJsDialog | undefined {
  const prev = ledger.dialogs.get(tabId);
  ledger.dialogs.delete(tabId);

  return prev;
}

export function pendingDialog(ledger: PageEventLedger, tabId: number): PendingJsDialog | undefined {
  return ledger.dialogs.get(tabId);
}

export function consumeArm(
  ledger: PageEventLedger,
  token: unknown,
  now: number = Date.now(),
): ArmedPageEvent {
  const arm = requireArm(ledger, token);

  if (arm.status === "consumed") {
    throw new Error("INVALID_ARGUMENT: event token already consumed");
  }

  if (arm.status === "timed_out" || arm.status === "cancelled" || arm.status === "disposed") {
    throw new Error(`INVALID_ARGUMENT: event token is ${arm.status}`);
  }

  if (arm.status === "armed") {
    throw new Error("EVENT_PENDING: armed event has not matched yet");
  }

  arm.status = "consumed";
  arm.consumedAt = now;

  return arm;
}

export function markArmTimedOut(ledger: PageEventLedger, token: string, reason?: string): ArmedPageEvent | undefined {
  const arm = ledger.arms.get(token);

  if (!arm || arm.status !== "armed") return arm;
  arm.status = "timed_out";
  arm.disposedReason = reason ?? `page event "${arm.kind}" timed out after ${arm.timeoutMs}ms`;

  return arm;
}

export function cancelArm(ledger: PageEventLedger, token: unknown, reason = "cancelled"): ArmedPageEvent {
  const arm = requireArm(ledger, token);

  if (arm.status === "consumed") return arm;
  arm.status = "cancelled";
  arm.disposedReason = reason;

  return arm;
}

/** Late events after stop: dispose all arms for a session; subsequent matches must fail closed. */
export function disposeSessionArms(
  ledger: PageEventLedger,
  sessionKey: string,
  reason = "session stopped",
): number {
  let n = 0;

  for (const arm of ledger.arms.values()) {
    if (arm.sessionKey !== sessionKey) continue;

    if (arm.status === "armed" || arm.status === "matched") {
      arm.status = "disposed";
      arm.disposedReason = reason;
      n += 1;
    }
  }

  return n;
}

export function disposeTabArms(
  ledger: PageEventLedger,
  tabId: number,
  reason = "page destroyed",
): number {
  let n = 0;

  for (const arm of ledger.arms.values()) {
    if (arm.tabId !== tabId) continue;

    if (arm.status === "armed" || arm.status === "matched") {
      arm.status = "disposed";
      arm.disposedReason = reason;
      n += 1;
    }
  }

  ledger.dialogs.delete(tabId);
  ledger.buffers.delete(tabId);

  return n;
}

export function consumeBufferedEvents(
  ledger: PageEventLedger,
  tabId: number,
  clear = true,
): BufferedPageEvent[] {
  const list = ledger.buffers.get(tabId) ?? [];

  if (clear) ledger.buffers.set(tabId, []);

  return list;
}

export function findDownload(ledger: PageEventLedger, downloadId: unknown): DownloadRecord {
  if (typeof downloadId !== "string" || !downloadId.startsWith("dl_")) {
    throw new Error("INVALID_ARGUMENT: unknown downloadId");
  }

  const download = ledger.downloads.get(downloadId);

  if (!download) throw new Error("INVALID_ARGUMENT: unknown or expired downloadId");

  if (download.deleted) throw new Error("INVALID_ARGUMENT: download artifact was deleted");

  return download;
}

export function markDownloadDeleted(ledger: PageEventLedger, downloadId: string): void {
  const download = ledger.downloads.get(downloadId);

  if (!download) return;
  download.deleted = true;
}

export function armPayload(arm: ArmedPageEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    token: arm.token,
    kind: arm.kind,
    tabId: arm.tabId,
    status: arm.status,
  };

  if (arm.kind === "popup") {
    return {
      ...base,
      popupTabId: arm.popupTabId,
      url: arm.popupUrl,
      targetId: arm.popupTargetId,
      popups: arm.popupTabId != null
        ? [{ label: `tab:${arm.popupTabId}`, targetId: arm.popupTargetId ?? String(arm.popupTabId), tabId: arm.popupTabId }]
        : [],
    };
  }

  if (arm.kind === "download") {
    return {
      ...base,
      downloadId: arm.downloadId,
      url: arm.downloadUrl,
      suggestedFilename: arm.suggestedFilename,
      downloadPath: arm.downloadPath,
      failure: arm.downloadFailure ?? null,
      completed: Boolean(arm.downloadCompleted),
      tempFile: arm.downloadTempFile,
    };
  }

  return {
    ...base,
    chooserId: arm.chooserId,
    backendNodeId: arm.backendNodeId,
    multiple: Boolean(arm.multiple),
  };
}
