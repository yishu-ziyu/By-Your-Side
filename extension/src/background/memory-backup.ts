import { BACKUP_INSTALL_KEY, BACKUP_LAST_KEY, MEMORY_CHANGED, backupDataUrl, backupFileName, collectBackup } from "../shared/memory-backup.js";

import { BROWSE_DISMISSED_KEY, BROWSE_FOUND_KEY, BROWSE_ON_KEY } from "../shared/browse-habits.js";

const TRIGGER_KEYS = [BROWSE_ON_KEY, BROWSE_FOUND_KEY, BROWSE_DISMISSED_KEY];

/** 连续写入（一轮里记忆、过往任务、习惯计数先后写）合成一次备份。 */
const DEBOUNCE_MS = 5000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> = Promise.resolve();

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; running = running.then(writeBackup, writeBackup); }, DEBOUNCE_MS);
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

async function writeBackup(): Promise<void> {
  const backup = await collectBackup();

  // 刚装好、记忆库还没有任何文档时不写：只有浏览记录的空备份没有用处。
  if (!Object.keys(backup.documents).length) return;
  const filename = backupFileName(await installAt());
  // 备份每次记忆变化都写；不关下载气泡和不删下载历史的话，用户的下载列表会被它刷满。
  const hideUi = typeof chrome.downloads.setUiOptions === "function";

  if (hideUi) await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});

  try {
    const id = await chrome.downloads.download({ url: backupDataUrl(JSON.stringify(backup)), filename, conflictAction: "overwrite", saveAs: false });
    await settled(id);
    const [item] = await chrome.downloads.search({ id }).catch(() => []);

    if (item?.state === "complete") await chrome.storage.local.set({ [BACKUP_LAST_KEY]: { at: backup.savedAt, file: filename } });
    await chrome.downloads.erase({ id }).catch(() => {});
  } finally {
    if (hideUi) await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
  }
}

export function installMemoryBackup(): void {
  if (!chrome.downloads?.download) return;

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null || (message as { type?: unknown }).type !== MEMORY_CHANGED) return;
    schedule();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    // 浏览记录每一步都在变，只在开关、归纳结果、删除名单变时排备份；记录本身随下一次备份带上。
    if (area === "local" && TRIGGER_KEYS.some(key => key in changes)) schedule();
  });
}
