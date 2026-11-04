import { activeTargetTabs } from "./target-window.js";
import { DEFAULT_CONVERSATION_ID, LEAD_SESSION_ID, isLeadSession, WORKING_TABS_STORAGE_KEY } from "../../../shared/protocol.js";
import { CLAIM_BLOCKED_ERROR, FOREIGN_TAB_ERROR } from "../../../shared/control.js";
import {
  applyTabBinding,
  bindExclusiveResource,
  mayAccessResource,
  mayClaimReplacementTab,
  parseExecutionKey,
  resourceForTab,
  sessionsForTab,
  type TabBindingMap,
  type TabResource,
  type TabResourceMap,
} from "./tab-bindings.js";

export { executionKey, parseExecutionKey } from "./tab-bindings.js";

const STORAGE_KEY = WORKING_TABS_STORAGE_KEY;

const RESOURCE_STORAGE_KEY = "tabResources";

let cached: TabBindingMap | undefined;

let cachedResources: TabResourceMap | undefined;

const claimBlocked = new Set<string>();

const closedWorkingTabs = new Map<string, number>();

const tabTransfers = new Map<number, string>();

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

export function beginTabTransfer(tabId: number, claimKey: string): () => void {
  const owner = keyOf(claimKey);
  const current = tabTransfers.get(tabId);

  if (current !== undefined) throw Object.assign(
    new Error("这个页面正在给另一个会话，稍后再试"),
    {executionFact: "not_executed" as const},
  );
  tabTransfers.set(tabId, owner);

  return () => { if (tabTransfers.get(tabId) === owner) tabTransfers.delete(tabId); };
}

function assertTabNotTransferring(tabId: number, key: string): void {
  const owner = tabTransfers.get(tabId);

  if (owner !== undefined && owner !== keyOf(key)) throw new Error("这个页面正在给另一个会话，操作未执行");
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
    if (resources) {
      await chrome.storage.session.set({ [STORAGE_KEY]: map, [RESOURCE_STORAGE_KEY]: resources });
    } else {
      await chrome.storage.session.set({ [STORAGE_KEY]: map });
    }
  } catch {  }
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

export async function resolveReadableTab(tabId: number | undefined, key: string): Promise<chrome.tabs.Tab> {
  if (!isLeadSession(parseExecutionKey(key).sessionId)) return resolveWorkingTab(tabId, key);
  const id = tabId ?? await getWorkingTabId(key);

  if (id != null) return chrome.tabs.get(id);
  const [active] = await activeTargetTabs();

  if (!active?.id) throw new Error("没有可读取的页面");

  return active;
}

export async function claimGlobalTab(tabId: number, key: string, expectedConversationId: string | null): Promise<void> {
  if (!isLeadSession(parseExecutionKey(key).sessionId)) throw new Error("只有主助手可以接手页面");
  assertTabNotTransferring(tabId, key);
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
    } catch {  }
  }

  return undefined;
}

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
  } catch {  }
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
      if (groupId != null) {
        groupId = await tabsApi.group({ tabIds: tabId, groupId });
      } else {
        groupId = await tabsApi.group({ tabIds: tabId });
      }
    } catch (error) {
      if (groupId == null) throw error;
      groupByConversation.delete(conversationId);
      groupId = await tabsApi.group({ tabIds: tabId });
    }

    groupByConversation.set(conversationId, groupId);
    await chrome.tabGroups.update(groupId, { title: groupTitle(conversationId), color: groupColor(conversationId), collapsed: false });
  } catch {  }
}

export async function resolveTabForRead(tabId: number | undefined, key: string): Promise<chrome.tabs.Tab> {
  if (isLeadSession(parseExecutionKey(key).sessionId) || tabId == null) return resolveReadableTab(tabId, key);
  const normalized = keyOf(key);
  assertTabNotTransferring(tabId, normalized);
  assertResourceAccess(await effectiveResource(tabId), normalized);

  return chrome.tabs.get(tabId);
}

function assertResourceAccess(resource: TabResource | undefined, key: string): void {
  if (resource) assertTabNotTransferring(resource.tabId, key);

  if (mayAccessResource(resource, key)) return;
  const who = parseExecutionKey(key);

  const blocked = (message: string) => Object.assign(new Error(message), { executionFact: "not_executed" as const });

  if (resource?.conversationId !== who.conversationId) throw blocked(isLeadSession(who.sessionId) ? `${FOREIGN_TAB_ERROR}，请调用 take_tab 协调接手后操作` : "标签页属于其他会话，未分配给当前 worker");

  if (isLeadSession(who.sessionId)) throw blocked("该页由同会话 worker 使用；请用 take_tab 接管后操作");
  throw blocked("标签页未向当前成员共享，请由父 Agent 分配页面");
}

export async function reclaimWorkerTabs(leadKey: string, workerKey: string): Promise<number[]> {
  const lead = parseExecutionKey(leadKey);

  if (!isLeadSession(lead.sessionId) || parseExecutionKey(workerKey).conversationId !== lead.conversationId) throw new Error("不能把页面交给另一个会话");

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
      assertTabNotTransferring(id, normalized);
      const existing = resourceForTab(resources, id) ?? inferredResource(map, id);
      assertResourceAccess(existing, normalized);
      map = applyTabBinding(map, normalized, id);

      if (!existing) resources = bindExclusiveResource(resources, id, normalized);
    } else map = applyTabBinding(map, normalized, null);
    await persist(map, resources);
  });

  if (id != null) await ensureConversationGroup(id, parseExecutionKey(keyOf(key)).conversationId);
}

export async function guardToolAccess(name: string, key: string, explicitTabId?: number): Promise<void> {
  if (name === "worker_tabs" || name === "list_tabs" || name === "get_active_tab") return;

  if (isLeadSession(parseExecutionKey(key).sessionId) && ["snapshot", "page_text", "read_element", "read_elements"].includes(name)) return;
  const normalized = keyOf(key);
  const tabId = explicitTabId ?? await getWorkingTabId(normalized);

  if (tabId == null) return;
  assertTabNotTransferring(tabId, normalized);
  const resource = await effectiveResource(tabId);
  assertResourceAccess(resource, normalized);
}

export async function resolveWorkingTab(preferredTabId?: number, key: string = LEAD_SESSION_ID): Promise<chrome.tabs.Tab> {
  const normalized = keyOf(key);
  const blocked = claimBlocked.has(normalized);

  if (preferredTabId != null) {
    assertTabNotTransferring(preferredTabId, normalized);
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

  const [active] = await activeTargetTabs();

  if (active?.id == null) throw new Error("没有可用的活动标签页，请使用 open_tab 新建页面");
  const activeResource = await effectiveResource(active.id);

  if (activeResource && !mayAccessResource(activeResource, normalized)) {
    try { assertResourceAccess(activeResource, normalized); }
    catch (error) { throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}；也可使用 open_tab 新建页面`), { executionFact: "not_executed" as const }); }
  }

  await setWorkingTab(active.id, normalized);

  return active;
}

export async function assertTargetTabOpen(requestedTabId: number | undefined, key: string): Promise<void> {
  const normalized = keyOf(key);

  await mutateState(async () => {});
  const closedWorking = closedWorkingTabs.get(normalized);
  let gone: number;

  if (requestedTabId !== undefined) {
    if (await chrome.tabs.get(requestedTabId).then(() => true, () => false)) return;
    gone = requestedTabId;
  } else {
    if (closedWorking === undefined) return;

    if (await getWorkingTabId(normalized) != null) {
      closedWorkingTabs.delete(normalized);

      return;
    }

    gone = closedWorking;
  }

  const [active] = await activeTargetTabs().catch(() => []);
  const what = gone === closedWorking ? `工作标签页 ${gone} 已关闭` : `标签页 ${gone} 不存在或已关闭`;

  const message = active?.id != null
    ? `${what}，这次没有执行。用户正在看的是标签页 ${active.id}。要继续，先用 tabs action:"switch" 切到要操作的标签页（或 tabs action:"list" 查看全部）。`
    : `${what}，这次没有执行。要继续，先用 tabs action:"list" 查看全部标签页，再用 tabs action:"switch" 切到要操作的那一页。`;

  throw Object.assign(new Error(message), { executionFact: "not_executed" as const });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabTransfers.delete(tabId);
  void mutateState(async () => {
    const [map, resources] = await Promise.all([loadMap(), loadResources()]);
    let next = map;

    for (const key of sessionsForTab(map, tabId)) {
      closedWorkingTabs.set(key, tabId);
      next = applyTabBinding(next, key, null);
    }
    const nextResources = { ...resources };
    delete nextResources[String(tabId)];
    await persist(next, nextResources);
  });
});
