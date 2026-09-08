/** 工作标签页和会话页资源；storage.session 让扩展 SW 重启后可恢复。 */
import { DEFAULT_CONVERSATION_ID, LEAD_SESSION_ID, isLeadSession } from "../../../shared/protocol.js";
import { mayActivateTabInWindow } from "./foreground.js";
import { CLAIM_BLOCKED_ERROR } from "../../../shared/control.js";
import {
  applyTabBinding,
  bindExclusiveResource,
  executionKey,
  mayAccessResource,
  mayClaimReplacementTab,
  parseExecutionKey,
  resourceForTab,
  sessionsForTab,
  shareResource,
  type TabBindingMap,
  type TabResource,
  type TabResourceMap,
} from "./tab-bindings.js";

export { executionKey, parseExecutionKey } from "./tab-bindings.js";

const STORAGE_KEY = "workingTabs";
const RESOURCE_STORAGE_KEY = "tabResources";
let cached: TabBindingMap | undefined;
let cachedResources: TabResourceMap | undefined;
const claimBlocked = new Set<string>();
const groupByConversation = new Map<string, number>();
const titleByConversation = new Map<string, string>();
let mutationTail: Promise<void> = Promise.resolve();
let groupingTail: Promise<void> = Promise.resolve();
let visibleConversationId = DEFAULT_CONVERSATION_ID;

function mutateState<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(fn, fn);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function keyOf(value: string): string { return value || LEAD_SESSION_ID; }

/** 只影响前台展示，不参与任何资源路由。 */
export function setVisibleConversationId(conversationId: string): void {
  visibleConversationId = conversationId || DEFAULT_CONVERSATION_ID;
}

export function shouldActivateForKey(key: string): boolean {
  const identity = parseExecutionKey(keyOf(key));
  return isLeadSession(identity.sessionId) && identity.conversationId === visibleConversationId;
}

export function setSessionClaimBlocked(key: string, blocked: boolean): void {
  const normalized = keyOf(key);
  if (blocked) claimBlocked.add(normalized);
  else claimBlocked.delete(normalized);
}

async function loadMap(): Promise<TabBindingMap> {
  if (cached !== undefined) return cached;
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    const value = got[STORAGE_KEY];
    cached = value && typeof value === "object" && !Array.isArray(value) ? value as TabBindingMap : {};
  } catch { cached = {}; }
  return cached;
}

async function loadResources(): Promise<TabResourceMap> {
  if (cachedResources !== undefined) return cachedResources;
  try {
    const got = await chrome.storage.session.get(RESOURCE_STORAGE_KEY);
    const value = got[RESOURCE_STORAGE_KEY];
    cachedResources = value && typeof value === "object" && !Array.isArray(value) ? value as TabResourceMap : {};
  } catch { cachedResources = {}; }
  return cachedResources;
}

async function persist(map: TabBindingMap, resources?: TabResourceMap): Promise<void> {
  cached = map;
  if (resources) cachedResources = resources;
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: map,
      ...(resources ? { [RESOURCE_STORAGE_KEY]: resources } : {}),
    });
  } catch { /* storage failure does not make a browser action fail */ }
}

function inferredResource(map: TabBindingMap, tabId: number): TabResource | undefined {
  const keys = sessionsForTab(map, tabId);
  if (keys.length === 0) return undefined;
  const conversationId = parseExecutionKey(keys[0]!).conversationId;
  return { tabId, conversationId, mode: keys.length > 1 ? "shared" : "exclusive", collaborators: keys };
}

async function effectiveResource(tabId: number): Promise<TabResource | undefined> {
  return resourceForTab(await loadResources(), tabId) ?? inferredResource(await loadMap(), tabId);
}

export async function getWorkingTabId(key: string = LEAD_SESSION_ID): Promise<number | null> {
  const id = (await loadMap())[keyOf(key)];
  return typeof id === "number" ? id : null;
}

/** 主 Agent 可全局只读；读取不认领、不切换、不改变其他成员的工作指针。 */
export async function resolveReadableTab(tabId: number | undefined, key: string): Promise<chrome.tabs.Tab> {
  if (!isLeadSession(parseExecutionKey(key).sessionId)) return resolveWorkingTab(tabId, key);
  const id = tabId ?? await getWorkingTabId(key);
  if (id != null) return chrome.tabs.get(id);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active?.id) throw new Error("没有可读取的页面");
  return active;
}

/** 原成员已停止并排空；用检查时的归属防止并发接手互相覆盖。 */
export async function claimGlobalTab(tabId: number, key: string, expectedConversationId: string | null): Promise<void> {
  if (!isLeadSession(parseExecutionKey(key).sessionId)) throw new Error("只有主 Agent 可以接手页面");
  await mutateState(async () => {
    let map = await loadMap();
    const resources = await loadResources();
    const current = resourceForTab(resources, tabId) ?? inferredResource(map, tabId);
    if ((current?.conversationId ?? null) !== expectedConversationId) throw new Error("页面归属已变化，请重新查看后再接手");
    for (const member of sessionsForTab(map, tabId)) map = applyTabBinding(map, member, null);
    await persist(applyTabBinding(map, key, tabId), bindExclusiveResource(resources, tabId, key));
  });
  await ensureConversationGroup(tabId, parseExecutionKey(key).conversationId);
}

export async function getWorkingTabMap(): Promise<TabBindingMap> { return { ...(await loadMap()) }; }
export async function getTabResource(tabId: number): Promise<TabResource | undefined> { return effectiveResource(tabId); }
export async function findSessionsForTab(tabId: number): Promise<string[]> { return sessionsForTab(await loadMap(), tabId); }
/** @deprecated 共享页会有多个成员；新代码使用 findSessionsForTab。 */
export async function findSessionForTab(tabId: number): Promise<string | undefined> { return (await findSessionsForTab(tabId))[0]; }

function groupTitle(conversationId: string): string {
  return titleByConversation.get(conversationId) ?? (conversationId === DEFAULT_CONVERSATION_ID ? "By Your Side" : "新会话");
}

function groupColor(conversationId: string): NonNullable<chrome.tabGroups.UpdateProperties["color"]> {
  const colors: NonNullable<chrome.tabGroups.UpdateProperties["color"]>[] = ["blue", "green", "purple", "cyan", "orange", "pink", "yellow", "red", "grey"];
  let hash = 0;
  for (let i = 0; i < conversationId.length; i += 1) hash = ((hash * 31) + conversationId.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length]!;
}

async function findConversationGroupId(conversationId: string, excludingTabId?: number): Promise<number | undefined> {
  const remembered = groupByConversation.get(conversationId);
  if (remembered != null) return remembered;
  const resources = await loadResources();
  const tabIds = Object.values(resources)
    .filter((resource) => resource.conversationId === conversationId && resource.tabId !== excludingTabId)
    .map((resource) => resource.tabId);
  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.get(id);
      if (typeof tab.groupId === "number" && tab.groupId >= 0) {
        groupByConversation.set(conversationId, tab.groupId);
        return tab.groupId;
      }
    } catch { /* stale tab */ }
  }
  return undefined;
}

/** 会话标题只控制 Chrome 标签组展示，不进入资源身份。 */
export async function setConversationTitle(conversationId: string, title: string): Promise<void> {
  const cid = conversationId || DEFAULT_CONVERSATION_ID;
  const normalized = title.trim().replace(/\s+/g, " ").slice(0, 48);
  if (normalized) titleByConversation.set(cid, normalized);
  else titleByConversation.delete(cid);
  if (!chrome.tabGroups?.update) return;
  const groupId = await findConversationGroupId(cid);
  if (groupId == null) return;
  try {
    await chrome.tabGroups.update(groupId, { title: groupTitle(cid), color: groupColor(cid), collapsed: false });
  } catch { /* presentation update must not alter ownership */ }
}

async function ensureConversationGroup(tabId: number, conversationId: string): Promise<void> {
  const next = groupingTail.then(() => applyConversationGroup(tabId, conversationId));
  groupingTail = next.catch(() => {});
  await next;
}

async function applyConversationGroup(tabId: number, conversationId: string): Promise<void> {
  const tabsApi = chrome.tabs as typeof chrome.tabs & { group?: (options: { tabIds: number | number[]; groupId?: number }) => Promise<number> };
  if (typeof tabsApi.group !== "function" || !chrome.tabGroups?.update) return;
  try {
    let groupId = groupByConversation.get(conversationId);
    if (groupId == null) groupId = await findConversationGroupId(conversationId, tabId);
    try {
      groupId = await tabsApi.group({ tabIds: tabId, ...(groupId != null ? { groupId } : {}) });
    } catch (error) {
      if (groupId == null) throw error;
      // Chrome destroys a group after its last tab closes; the conversation survives.
      groupByConversation.delete(conversationId);
      groupId = await tabsApi.group({ tabIds: tabId });
    }
    groupByConversation.set(conversationId, groupId);
    await chrome.tabGroups.update(groupId, { title: groupTitle(conversationId), color: groupColor(conversationId), collapsed: false });
  } catch { /* grouping is display-only; stable ownership remains in resources */ }
}

export function assertResourceAccess(resource: TabResource | undefined, key: string): void {
  if (mayAccessResource(resource, key)) return;
  const who = parseExecutionKey(key);
  if (resource?.conversationId !== who.conversationId) throw new Error(isLeadSession(who.sessionId) ? "该页正在由其他会话使用，请调用 take_tab 协调接手后操作" : "标签页属于其他会话，未分配给当前 worker");
  if (isLeadSession(who.sessionId)) throw new Error("该页由同会话 worker 使用；请用 take_tab 接管后操作");
  throw new Error("标签页未向当前成员共享，请由父 Agent 分配页面");
}

/** 调用方已冻结并排空 worker。移交所有历史页面，不改变父 Agent 当前工作指针。 */
export async function reclaimWorkerTabs(leadKey: string, workerKey: string): Promise<number[]> {
  const lead = parseExecutionKey(leadKey);
  if (!isLeadSession(lead.sessionId) || parseExecutionKey(workerKey).conversationId !== lead.conversationId) throw new Error("不能跨会话移交页面");
  return mutateState(async () => {
    let map = await loadMap();
    let resources = { ...await loadResources() };
    for (const tabId of Object.values(map)) {
      if (!resources[String(tabId)]) {
        const inferred = inferredResource(map, tabId);
        if (inferred) resources[String(tabId)] = inferred;
      }
    }
    const tabIds: number[] = [];
    for (const [id, resource] of Object.entries(resources)) {
      if (resource.conversationId !== lead.conversationId || !resource.collaborators.includes(workerKey)) continue;
      const collaborators = [...new Set([leadKey, ...resource.collaborators.filter(k => k !== workerKey)])];
      resources[id] = { ...resource, collaborators, mode: collaborators.length === 1 ? "exclusive" : "shared" };
      tabIds.push(resource.tabId);
    }
    map = applyTabBinding(map, workerKey, null);
    await persist(map, resources);
    return tabIds;
  });
}

export async function setWorkingTab(id: number | null, key: string = LEAD_SESSION_ID): Promise<void> {
  await mutateState(async () => {
    const normalized = keyOf(key);
    let map = await loadMap();
    let resources = await loadResources();
    if (id != null) {
      const existing = resourceForTab(resources, id) ?? inferredResource(map, id);
      assertResourceAccess(existing, normalized);
      map = applyTabBinding(map, normalized, id);
      if (!existing) resources = bindExclusiveResource(resources, id, normalized);
    } else map = applyTabBinding(map, normalized, null);
    // 工作指针离开不等于释放页面。页资源属于 conversation，直到标签关闭或未来显式释放。
    await persist(map, resources);
  });
  if (id != null) await ensureConversationGroup(id, parseExecutionKey(keyOf(key)).conversationId);
}

function collaboratorKey(ownerKey: string, collaborator: string): string {
  const ownerConversationId = parseExecutionKey(ownerKey).conversationId;
  if (collaborator.includes("::")) {
    const parsed = parseExecutionKey(collaborator);
    if (parsed.conversationId !== ownerConversationId) throw new Error("标签页只能与同一会话的执行成员共享");
    return collaborator;
  }
  return executionKey(ownerConversationId, collaborator);
}

export async function shareTab(
  params: { tabId: number; collaborators: string[]; remove?: string[] },
  ownerKey: string = LEAD_SESSION_ID,
): Promise<{ tabId: number; collaborators: string[] }> {
  const tab = await chrome.tabs.get(params.tabId);
  if (tab.id == null) throw new Error("标签页无效");
  const owner = keyOf(ownerKey);
  const additions = params.collaborators.map((member) => collaboratorKey(owner, member));
  const removals = new Set((params.remove ?? []).map((member) => collaboratorKey(owner, member)));
  removals.delete(owner);
  const resource = await mutateState(async () => {
    const current = await effectiveResource(params.tabId);
    assertResourceAccess(current, owner);
    let resources = shareResource(await loadResources(), params.tabId, owner, additions);
    let nextResource = resources[String(params.tabId)]!;
    const collaborators = nextResource.collaborators.filter((key) => !removals.has(key));
    nextResource = {
      ...nextResource,
      mode: collaborators.length === 1 ? "exclusive" : "shared",
      collaborators,
    };
    resources = { ...resources, [String(params.tabId)]: nextResource };
    let map = await loadMap();
    for (const key of nextResource.collaborators) map = applyTabBinding(map, key, params.tabId);
    for (const key of removals) if (map[key] === params.tabId) map = applyTabBinding(map, key, null);
    await persist(map, resources);
    return nextResource;
  });
  await ensureConversationGroup(params.tabId, resource.conversationId);
  return { tabId: params.tabId, collaborators: resource.collaborators.map((key) => parseExecutionKey(key).sessionId) };
}

const SHARED_UNSAFE_TOOLS = new Set(["open_tab", "switch_tab", "close_tab", "navigate", "click", "hover", "fill", "type_text", "press_key", "scroll", "js", "mark", "clear_marks"]);

/** controller 在每个工具执行前调用；共享页写入只能走完整 page_operation。 */
export async function guardToolAccess(name: string, key: string, explicitTabId?: number): Promise<void> {
  if (name === "worker_tabs" || name === "list_tabs" || name === "get_active_tab") return;
  if (isLeadSession(parseExecutionKey(key).sessionId) && ["snapshot", "read_element"].includes(name)) return;
  const normalized = keyOf(key);
  const tabId = explicitTabId ?? await getWorkingTabId(normalized);
  if (tabId == null) return;
  const resource = await effectiveResource(tabId);
  assertResourceAccess(resource, normalized);
  if (resource?.mode === "shared" && SHARED_UNSAFE_TOOLS.has(name)) {
    throw new Error("共享页上的该写操作不安全；请使用 page_operation 完成定位、核对、输入和读回");
  }
}

/** 显式 tabId → 已认领页 → 当前会话可认领的空闲页。 */
export async function resolveWorkingTab(preferredTabId?: number, key: string = LEAD_SESSION_ID): Promise<chrome.tabs.Tab> {
  const normalized = keyOf(key);
  const blocked = claimBlocked.has(normalized);
  if (preferredTabId != null) {
    const resource = await effectiveResource(preferredTabId);
    assertResourceAccess(resource, normalized);
    if (blocked && await getWorkingTabId(normalized) !== preferredTabId) throw new Error(CLAIM_BLOCKED_ERROR);
    const tab = await chrome.tabs.get(preferredTabId);
    if (!blocked) await setWorkingTab(preferredTabId, normalized);
    return tab;
  }

  const claimed = await getWorkingTabId(normalized);
  if (claimed != null) {
    try {
      const resource = await effectiveResource(claimed);
      assertResourceAccess(resource, normalized);
      return await chrome.tabs.get(claimed);
    } catch (error) {
      if (error instanceof Error && /属于其他会话|未向当前成员|同会话 worker/.test(error.message)) throw error;
      await setWorkingTab(null, normalized);
    }
  }
  if (!mayClaimReplacementTab({ blocked, boundMissing: true })) throw new Error(CLAIM_BLOCKED_ERROR);

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id == null) throw new Error("没有可用的活动标签页，请使用 open_tab 新建页面");
  const activeResource = await effectiveResource(active.id);
  if (activeResource && !mayAccessResource(activeResource, normalized)) {
    try { assertResourceAccess(activeResource, normalized); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}；也可使用 open_tab 新建页面`); }
  }
  await setWorkingTab(active.id, normalized);
  return active;
}

export async function activateTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null) return;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!mayActivateTabInWindow(win.focused === true)) return;
    await chrome.tabs.update(tab.id, { active: true });
  } catch { /* tab/window disappeared */ }
}

export async function maybeActivateTab(tab: chrome.tabs.Tab, key: string = LEAD_SESSION_ID): Promise<void> {
  if (!shouldActivateForKey(key)) return;
  await activateTab(tab);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void mutateState(async () => {
    const [map, resources] = await Promise.all([loadMap(), loadResources()]);
    let next = map;
    for (const key of sessionsForTab(map, tabId)) next = applyTabBinding(next, key, null);
    const nextResources = { ...resources };
    delete nextResources[String(tabId)];
    await persist(next, nextResources);
  });
});
