import { BACKUP_ERROR_KEY, BACKUP_INSTALL_KEY, BACKUP_LAST_KEY, MEMORY_CHANGED, backupDataUrl, backupFileName, clearMemoryBackupDirty, collectBackup, isOwnBackupDownload, markMemoryBackupDirty, memoryBackupDirty, recoverPendingMemoryRestore } from "../shared/memory-backup.js";
import { memoryBackupTiming } from "../../../shared/memory-backup-timing.js";

import { BROWSE_ON_KEY } from "../shared/browse-habits.js";

const TRIGGER_KEYS = [BROWSE_ON_KEY];

/** 连续写入（一轮里记忆、过往任务、习惯计数先后写）合成一次备份。 */
const CHECK_ALARM = "memory-backup-check";
const RETRY_KEY = "memory_backup_retry";
const UI_DISABLED_KEY = "memory_backup_ui_disabled";

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> = Promise.resolve();

function arm(at: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; if (memoryBackupTiming(Date.now(), { kind: "timer" }).kind === "run") enqueue(); }, Math.max(0, at - Date.now()));
}

function enqueue(): void { running = running.then(attemptBackup, attemptBackup); }

function schedule(): void {
  void markMemoryBackupDirty().then(async () => {
    const retry: unknown = (await chrome.storage.local.get(RETRY_KEY))[RETRY_KEY];
    const action = memoryBackupTiming(Date.now(), { kind: "changed" });
    const retryAt = retry && typeof retry === "object" && "at" in retry && typeof retry.at === "number" ? retry.at : 0;
    if (action.kind === "schedule") arm(Math.max(action.at, retryAt));
  }).catch(() => console.error("待备份状态未能保存。"));
}

async function installAt(): Promise<number> {
  const stored = (await chrome.storage.local.get(BACKUP_INSTALL_KEY))[BACKUP_INSTALL_KEY];

  if (typeof stored === "number" && Number.isFinite(stored)) return stored;
  const now = Date.now();
  await chrome.storage.local.set({ [BACKUP_INSTALL_KEY]: now });

  return now;
}

function settled(id: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { chrome.downloads.onChanged.removeListener(onChanged); clearTimeout(limit); resolve(); };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && (delta.state?.current === "complete" || delta.state?.current === "interrupted")) done();
    };
    const limit = setTimeout(done, 15_000);
    chrome.downloads.onChanged.addListener(onChanged);
    void chrome.downloads.search({ id }).then(([item]) => { if (item && item.state !== "in_progress") done(); }, () => {});
  });
}

async function restoreDownloadUi(): Promise<void> {
  if (!(await chrome.storage.local.get(UI_DISABLED_KEY))[UI_DISABLED_KEY]) return;
  await chrome.downloads.setUiOptions({ enabled: true });
  await chrome.storage.local.remove(UI_DISABLED_KEY);
}

async function writeBackup(): Promise<void> {
  const active = (await chrome.downloads.search({ state: "in_progress" })).filter(isOwnBackupDownload);
  for (const item of active) {
    await chrome.downloads.cancel(item.id).catch(() => {});
    await settled(item.id);
    const [current] = await chrome.downloads.search({ id: item.id });
    if (current?.state === "in_progress") throw new Error("上一份备份仍在下载");
  }
  const backup = await collectBackup();
  if (!Object.keys(backup.documents).length && !(await chrome.storage.local.get(BACKUP_LAST_KEY))[BACKUP_LAST_KEY]) return;
  const filename = backupFileName(await installAt());
  // 备份每次记忆变化都写；不关下载气泡和不删下载历史的话，用户的下载列表会被它刷满。
  const hideUi = typeof chrome.downloads.setUiOptions === "function";

  if (hideUi) {
    await chrome.storage.local.set({ [UI_DISABLED_KEY]: true });
    await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
  }

  try {
    const id = await chrome.downloads.download({ url: backupDataUrl(JSON.stringify(backup)), filename, conflictAction: "overwrite", saveAs: false });
    await settled(id);
    let [item] = await chrome.downloads.search({ id }).catch(() => []);
    if (item?.state === "in_progress") {
      await chrome.downloads.cancel(id).catch(() => {});
      await settled(id);
      [item] = await chrome.downloads.search({ id }).catch(() => []);
    }
    if (item?.state !== "complete") throw new Error("下载未完成");
    await chrome.storage.local.set({ [BACKUP_LAST_KEY]: { at: backup.savedAt, file: filename } });
    await chrome.downloads.erase({ id }).catch(() => {});
  } finally {
    if (hideUi) {
      await restoreDownloadUi();
    }
  }
}

async function attemptBackup(): Promise<void> {
  try {
    await restoreDownloadUi();
    await recoverPendingMemoryRestore();
    const token = await memoryBackupDirty();
    if (!token) return;
    const retry: unknown = (await chrome.storage.local.get(RETRY_KEY))[RETRY_KEY];
    if (retry && typeof retry === "object" && "at" in retry && typeof retry.at === "number" && retry.at > Date.now()) { arm(retry.at); return; }
    await writeBackup();
    const cleared = await clearMemoryBackupDirty(token);
    await chrome.storage.local.remove([RETRY_KEY, BACKUP_ERROR_KEY]);
    if (!cleared) { const action = memoryBackupTiming(Date.now(), { kind: "changed" }); if (action.kind === "schedule") arm(action.at); }
  } catch (error) {
    const failure = error instanceof Error && error.message === "记忆备份超过 8 MB，无法保存。"
      ? "记忆备份超过 8 MB，无法保存；现有备份仍保留。"
      : "记忆备份未完成，稍后会重试。";
    const retry: unknown = (await chrome.storage.local.get(RETRY_KEY))[RETRY_KEY];
    const failures = retry && typeof retry === "object" && "failures" in retry && typeof retry.failures === "number" ? retry.failures + 1 : 1;
    const action = memoryBackupTiming(Date.now(), { kind: "failed", failures });
    if (action.kind === "schedule") {
      await chrome.storage.local.set({ [RETRY_KEY]: { at: action.at, failures }, [BACKUP_ERROR_KEY]: failure });
      arm(action.at);
    }
  }
}

export function installMemoryBackup(): void {
  if (!chrome.downloads?.download) return;
  void (async () => {
    await restoreDownloadUi();
    await recoverPendingMemoryRestore();
    if (await memoryBackupDirty()) { const action = memoryBackupTiming(Date.now(), { kind: "changed" }); if (action.kind === "schedule") arm(action.at); }
  })().catch(() => console.error("记忆恢复或备份状态未能检查，稍后重试。"));
  if (chrome.alarms) {
    void chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === CHECK_ALARM) enqueue(); });
  }
  chrome.runtime.onStartup.addListener(() => enqueue());

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null || (message as { type?: unknown }).type !== MEMORY_CHANGED) return;
    schedule();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    // 浏览记录不进备份，只有用户选择的观察开关需要备份。
    if (area === "local" && TRIGGER_KEYS.some(key => key in changes)) schedule();
  });
}
