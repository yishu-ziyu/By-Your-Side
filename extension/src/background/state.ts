/**
 * 工作标签页状态：按 sessionId 认领（Lead=main，工人各一页）。
 * 模块缓存 + chrome.storage.session 持久化（SW 重启可恢复）。
 */
import { LEAD_SESSION_ID, isLeadSession, normalizeSessionId } from "../../../shared/protocol.js";
import { mayActivateTabInWindow } from "./foreground.js";
import { CLAIM_BLOCKED_ERROR } from "../../../shared/control.js";
import { applyTabBinding, boundTabIds, mayClaimReplacementTab, sessionForTab, type TabBindingMap } from "./tab-bindings.js";

const STORAGE_KEY = "workingTabs";

/** undefined = 尚未从 storage 加载 */
let cached: TabBindingMap | undefined;
const claimBlocked = new Set<string>();

export function setSessionClaimBlocked(sessionId: string, blocked: boolean): void {
  const sid = normalizeSessionId(sessionId);
  if (blocked) claimBlocked.add(sid);
  else claimBlocked.delete(sid);
}

async function loadMap(): Promise<TabBindingMap> {
  if (cached !== undefined) return cached;
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    const v = got[STORAGE_KEY];
    cached = v && typeof v === "object" && !Array.isArray(v) ? (v as TabBindingMap) : {};
  } catch {
    cached = {};
  }
  return cached;
}

async function persist(map: TabBindingMap): Promise<void> {
  cached = map;
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: map });
  } catch {
    /* 存储失败不阻塞主流程 */
  }
}

export async function getWorkingTabId(sessionId: string = LEAD_SESSION_ID): Promise<number | null> {
  const map = await loadMap();
  const id = map[normalizeSessionId(sessionId)];
  return typeof id === "number" ? id : null;
}

export async function getWorkingTabMap(): Promise<TabBindingMap> {
  return { ...(await loadMap()) };
}

export async function setWorkingTab(id: number | null, sessionId: string = LEAD_SESSION_ID): Promise<void> {
  const map = applyTabBinding(await loadMap(), normalizeSessionId(sessionId), id);
  await persist(map);
}

export async function findSessionForTab(tabId: number): Promise<string | undefined> {
  return sessionForTab(await loadMap(), tabId);
}

/**
 * 解析工作标签页：显式 tabId 优先（并认领）→ 已认领且仍存在 → 当前活动页（未被其他 session 占用）并认领。
 */
export async function resolveWorkingTab(
  preferredTabId?: number,
  sessionId: string = LEAD_SESSION_ID,
): Promise<chrome.tabs.Tab> {
  const sid = normalizeSessionId(sessionId);
  const blocked = claimBlocked.has(sid);
  if (preferredTabId != null) {
    if (blocked) {
      const claimed = await getWorkingTabId(sid);
      if (claimed !== preferredTabId) throw new Error(CLAIM_BLOCKED_ERROR);
    }
    const tab = await chrome.tabs.get(preferredTabId);
    if (!blocked) await setWorkingTab(preferredTabId, sid);
    return tab;
  }

  const claimed = await getWorkingTabId(sid);
  if (claimed != null) {
    try {
      return await chrome.tabs.get(claimed);
    } catch {
      await setWorkingTab(null, sid);
    }
  }

  if (!mayClaimReplacementTab({ blocked, boundMissing: true })) {
    throw new Error(CLAIM_BLOCKED_ERROR);
  }

  const map = await loadMap();
  const taken = boundTabIds(map);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id != null && !taken.has(active.id)) {
    await setWorkingTab(active.id, sid);
    return active;
  }
  const all = await chrome.tabs.query({});
  const free = all.find((t) => t.id != null && !taken.has(t.id));
  if (free?.id != null) {
    await setWorkingTab(free.id, sid);
    return free;
  }
  throw new Error("没有可用的活动标签页");
}

/**
 * 仅当该 Chrome 窗口已经在前台时，把工作标签页切到窗口内前台。
 * 绝不 windows.update({focused:true})：那会把 macOS Space 从人正在用的桌面拽回来。
 */
export async function activateTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null) return;
  let focused = false;
  try {
    const win = await chrome.windows.get(tab.windowId);
    focused = win.focused === true;
  } catch {
    return;
  }
  if (!mayActivateTabInWindow(focused)) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    /* 忽略 */
  }
}

/** 工人不抢前台，避免两只光标互相切标签页。 */
export async function maybeActivateTab(tab: chrome.tabs.Tab, sessionId: string = LEAD_SESSION_ID): Promise<void> {
  if (!isLeadSession(sessionId)) return;
  await activateTab(tab);
}

// 工作标签页被（用户或其他途径）关闭时清除认领
chrome.tabs.onRemoved.addListener((tabId) => {
  void loadMap().then((map) => {
    const sid = sessionForTab(map, tabId);
    if (sid) void setWorkingTab(null, sid);
  });
});
