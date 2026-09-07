/** 执行成员到标签页的稳定绑定。Chrome groupId 只负责展示，不进入持久身份。 */
import { DEFAULT_CONVERSATION_ID, LEAD_SESSION_ID } from "../../../shared/protocol.js";

export type TabBindingMap = Record<string, number>;
export type TabResource = {
  tabId: number;
  conversationId: string;
  mode: "exclusive" | "shared";
  collaborators: string[];
};
export type TabResourceMap = Record<string, TabResource>;

function decodePart(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** 默认会话保留既有 main/worker key；其他会话使用可逆复合 key。 */
export function executionKey(conversationId: string, sessionId: string = LEAD_SESSION_ID): string {
  const cid = conversationId || DEFAULT_CONVERSATION_ID;
  const sid = sessionId || LEAD_SESSION_ID;
  if (cid === DEFAULT_CONVERSATION_ID) return encodeURIComponent(sid);
  return `${encodeURIComponent(cid)}::${encodeURIComponent(sid)}`;
}

export function parseExecutionKey(key: string): { conversationId: string; sessionId: string } {
  const separator = key.indexOf("::");
  if (separator < 0) {
    return { conversationId: DEFAULT_CONVERSATION_ID, sessionId: decodePart(key || LEAD_SESSION_ID) };
  }
  return {
    conversationId: decodePart(key.slice(0, separator)) || DEFAULT_CONVERSATION_ID,
    sessionId: decodePart(key.slice(separator + 2)) || LEAD_SESSION_ID,
  };
}

export function applyTabBinding(map: TabBindingMap, key: string, tabId: number | null): TabBindingMap {
  const normalized = key || LEAD_SESSION_ID;
  const next: TabBindingMap = { ...map };
  if (tabId == null) delete next[normalized];
  else next[normalized] = tabId;
  return next;
}

/** 兼容旧调用；共享页请使用 sessionsForTab。 */
export function sessionForTab(map: TabBindingMap, tabId: number): string | undefined {
  return sessionsForTab(map, tabId)[0];
}

export function sessionsForTab(map: TabBindingMap, tabId: number): string[] {
  return Object.entries(map).filter(([, tid]) => tid === tabId).map(([key]) => key);
}

export function boundTabIds(map: TabBindingMap): Set<number> { return new Set(Object.values(map)); }
export function resourceForTab(map: TabResourceMap, tabId: number): TabResource | undefined { return map[String(tabId)]; }

export function bindExclusiveResource(map: TabResourceMap, tabId: number, key: string): TabResourceMap {
  const { conversationId } = parseExecutionKey(key);
  return { ...map, [String(tabId)]: { tabId, conversationId, mode: "exclusive", collaborators: [key] } };
}

export function shareResource(map: TabResourceMap, tabId: number, ownerKey: string, collaboratorKeys: string[]): TabResourceMap {
  const owner = parseExecutionKey(ownerKey);
  const current = resourceForTab(map, tabId);
  if (current && current.conversationId !== owner.conversationId) throw new Error("标签页属于其他会话，不能跨会话共享");
  const collaborators = [...new Set([ownerKey, ...(current?.collaborators ?? []), ...collaboratorKeys])];
  for (const key of collaborators) {
    if (parseExecutionKey(key).conversationId !== owner.conversationId) throw new Error("标签页只能与同一会话的执行成员共享");
  }
  return { ...map, [String(tabId)]: { tabId, conversationId: owner.conversationId, mode: "shared", collaborators } };
}

export function mayAccessResource(resource: TabResource | undefined, key: string): boolean {
  if (!resource) return true;
  const { conversationId } = parseExecutionKey(key);
  return resource.conversationId === conversationId && resource.collaborators.includes(key);
}

export function mayClaimReplacementTab(opts: { blocked: boolean; boundMissing: boolean }): boolean {
  if (opts.blocked) return false;
  return opts.boundMissing;
}
