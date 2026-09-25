/**
 * CAP-02A page event arm / wait / consume ledger (pure state).
 *
 * Portions of the per-tab download arming approach are adapted from
 * citrolabs/ego-lite
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
 *
 * Downloads: Page.downloadWillBegin ties a download to the armed tab; the file itself
 * is written by Chrome into the user's download folder and its outcome comes only from
 * chrome.downloads (joined by URL). CDP progress is never taken as completion.
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
  /** Download-only: the ledger record lives in PageEventLedger.downloads. */
  downloadId?: string;
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

export type ChromeDownloadState = "in_progress" | "complete" | "interrupted";

export interface DownloadRecord {
  downloadId: string;
  token: string;
  tabId: number;
  guid: string;
  url: string;
  suggestedFilename: string;
  /** chrome.downloads id; set once the CDP begin event and the chrome.downloads item are joined by URL. */
  chromeId?: number;
  /** Absolute path Chrome wrote (chrome.downloads filename); only trusted once completed. */
  path?: string;
  bytes?: number;
  /** chrome.downloads danger other than safe/accepted: Chrome holds the file until the user keeps it. */
  danger?: string;
  /** chrome.downloads error code (e.g. NETWORK_FAILED, USER_CANCELED) once interrupted. */
  failure: string | null;
  /** True only after chrome.downloads reported state "complete". */
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
    const downloadId = mintDownloadId(ledger);
    arm.status = "matched";
    arm.matchedAt = now;
    arm.downloadId = downloadId;

    const download: DownloadRecord = {
      downloadId,
      token: arm.token,
      tabId: arm.tabId,
      guid: input.guid,
      url: input.url,
      suggestedFilename: input.suggestedFilename,
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

/**
 * Join a chrome.downloads item to the tab-attributed record with the same URL.
 * Only records that are not yet joined or finished qualify; the oldest wins.
 */
export function bindChromeDownload(
  ledger: PageEventLedger,
  input: { chromeId: number; url: string; finalUrl?: string },
): DownloadRecord | undefined {
  for (const download of ledger.downloads.values()) if (download.chromeId === input.chromeId) return download;

  for (const download of ledger.downloads.values()) {
    if (download.chromeId !== undefined || download.deleted) continue;

    if (download.url !== input.url && download.url !== input.finalUrl) continue;
    download.chromeId = input.chromeId;

    return download;
  }

  return undefined;
}

/** Apply a chrome.downloads state. Completion needs state "complete"; nothing else counts. */
export function applyChromeDownload(
  ledger: PageEventLedger,
  input: { chromeId: number; state?: ChromeDownloadState; error?: string; filename?: string; bytes?: number; danger?: string },
): DownloadRecord | undefined {
  for (const download of ledger.downloads.values()) {
    if (download.chromeId !== input.chromeId) continue;

    if (download.deleted || download.completed || download.failure) return download;

    if (input.filename) download.path = input.filename;

    if (typeof input.bytes === "number" && input.bytes >= 0) download.bytes = input.bytes;

    if (input.danger !== undefined) download.danger = input.danger === "safe" || input.danger === "accepted" ? undefined : input.danger;

    if (input.state === "complete") {
      download.completed = true;
      download.danger = undefined;
    } else if (input.state === "interrupted") {
      download.failure = input.error || "INTERRUPTED";
      download.cancelled = input.error === "USER_CANCELED";
    }

    return download;
  }

  return undefined;
}

export function downloadSettled(download: DownloadRecord): boolean {
  return download.completed || download.failure !== null || download.deleted;
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

export function armPayload(arm: ArmedPageEvent, downloads?: PageEventLedger["downloads"]): Record<string, unknown> {
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
    const download = arm.downloadId ? downloads?.get(arm.downloadId) : undefined;

    return {
      ...base,
      downloadId: arm.downloadId,
      url: download?.url,
      suggestedFilename: download?.suggestedFilename,
      path: download?.completed ? download.path : undefined,
      bytes: download?.completed ? download.bytes : undefined,
      danger: download?.danger,
      failure: download?.failure ?? null,
      completed: Boolean(download?.completed),
    };
  }

  return {
    ...base,
    chooserId: arm.chooserId,
    backendNodeId: arm.backendNodeId,
    multiple: Boolean(arm.multiple),
  };
}
