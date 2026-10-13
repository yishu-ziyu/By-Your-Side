/** 执行成员到标签页的稳定绑定。Chrome groupId 只负责展示，不进入持久身份。 */
import { DEFAULT_CONVERSATION_ID, LEAD_SESSION_ID, executionKey } from "../../../shared/protocol.js";

export { executionKey };

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

export function sessionsForTab(map: TabBindingMap, tabId: number): string[] {
  return Object.entries(map).filter(([, tid]) => tid === tabId).map(([key]) => key);
}

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
    if (parseExecutionKey(key).conversationId !== owner.conversationId) throw new Error("标签页只能和同一会话里的助手共享");
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
