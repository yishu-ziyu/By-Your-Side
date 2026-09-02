/**
 * 工作标签页状态：模块变量 + chrome.storage.session 持久化（SW 重启可恢复）。
 */
const STORAGE_KEY = "workingTabId";

/** undefined = 尚未从 storage 加载 */
let cached: number | null | undefined;

async function load(): Promise<number | null> {
  if (cached !== undefined) return cached;
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    const v = got[STORAGE_KEY];
    cached = typeof v === "number" ? v : null;
  } catch {
    cached = null;
  }
  return cached;
}

export async function getWorkingTabId(): Promise<number | null> {
  return load();
}

export async function setWorkingTab(id: number | null): Promise<void> {
  cached = id;
  try {
    if (id === null) await chrome.storage.session.remove(STORAGE_KEY);
    else await chrome.storage.session.set({ [STORAGE_KEY]: id });
  } catch {
    /* 存储失败不阻塞主流程 */
  }
}

/**
 * 解析工作标签页：显式 tabId 优先（并认领）→ 已认领且仍存在 → 当前活动页并认领。
 */
export async function resolveWorkingTab(preferredTabId?: number): Promise<chrome.tabs.Tab> {
  if (preferredTabId != null) {
    const tab = await chrome.tabs.get(preferredTabId);
    await setWorkingTab(preferredTabId);
    return tab;
  }

  const claimed = await load();
  if (claimed != null) {
    try {
      return await chrome.tabs.get(claimed);
    } catch {
      await setWorkingTab(null);
    }
  }

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = active ?? (await chrome.tabs.query({ active: true }))[0];
  if (!tab || tab.id == null) throw new Error("没有可用的活动标签页");
  await setWorkingTab(tab.id);
  return tab;
}

/** 涉及真实输入/截图前，把工作标签页提到前台。 */
export async function activateTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    /* 忽略 */
  }
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* 忽略 */
  }
}

// 工作标签页被（用户或其他途径）关闭时清除认领
chrome.tabs.onRemoved.addListener((tabId) => {
  void load().then((id) => {
    if (id === tabId) void setWorkingTab(null);
  });
});
