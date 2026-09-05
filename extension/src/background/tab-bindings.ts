/**
 * sessionId → tabId 绑定的纯函数（无 chrome API），供 state.ts 与单测共用。
 */
import { LEAD_SESSION_ID } from "../../../shared/protocol.js";

export type TabBindingMap = Record<string, number>;

export function applyTabBinding(map: TabBindingMap, sessionId: string, tabId: number | null): TabBindingMap {
  const sid = sessionId || LEAD_SESSION_ID;
  const next: TabBindingMap = { ...map };
  if (tabId == null) delete next[sid];
  else next[sid] = tabId;
  return next;
}

export function sessionForTab(map: TabBindingMap, tabId: number): string | undefined {
  for (const [sid, tid] of Object.entries(map)) {
    if (tid === tabId) return sid;
  }
  return undefined;
}

export function boundTabIds(map: TabBindingMap): Set<number> {
  return new Set(Object.values(map));
}

/** paused_tab_closed 等硬闸门下，丢绑定页也不得认领活动页或空闲页。 */
export function mayClaimReplacementTab(opts: { blocked: boolean; boundMissing: boolean }): boolean {
  if (opts.blocked) return false;
  return opts.boundMissing;
}
