/**
 * `network` 工具：读当前工作标签页的被动请求记录（CDP Network 域环形缓冲）。
 * 只读，不改页面；attach 失败（如用户开着 DevTools）不伪造数据。
 * 回执含在途/捕获完整性，供 waitForNetworkIdle 判定（FIX-02）。
 * 依据 docs/evals/20260911-network.md。
 */
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { formatNetworkReport, selectNetworkEntries, type NetworkQuery } from "../../../../shared/network.js";
import { ensureAttached } from "../debugger.js";
import { clearNetworkRing, enableNetworkCapture, networkIdleFor, networkRingFor } from "../network-log.js";
import { resolveReadableTab } from "../state.js";

export interface NetworkParams {
  tabId?: number;
  urlContains?: string;
  types?: string[] | "all";
  limit?: number;
  clear?: boolean;
}

export interface NetworkResult {
  text: string;
  tabId: number;
  total: number;
  matched: number;
  shown: number;
  dropped: number;
  inFlight: number;
  excludedInFlight: number;
  lastActivityAt: number;
  generation: number;
  integrity: "none" | "ok" | "late" | "detached" | "gap" | "restart";
  attached: boolean;
}

export async function network(params: NetworkParams, sessionId: string = LEAD_SESSION_ID): Promise<NetworkResult> {
  const tab = await resolveReadableTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  // 尽量从现在起有记录；attach 失败不影响读已有缓冲。中途接入标 late，不冒充完整。
  try {
    await ensureAttached(tab.id);
    await enableNetworkCapture(tab.id, { mode: "late" });
  } catch {
    /* DevTools 占用或页面受限：已有记录照常返回 */
  }

  if (params.clear === true) {
    const cleared = clearNetworkRing(tab.id);

    const idle = networkIdleFor(tab.id, 0) ?? {
      inFlight: 0, excludedInFlight: 0, lastActivityAt: 0, generation: 0, integrity: "none" as const, attached: false,
    };

    return {
      text: `Network buffer cleared (${cleared} request${cleared === 1 ? "" : "s"} dropped). In-flight tracking retained (${idle.inFlight} pending). Do the action you want to observe, then call network again.`,
      tabId: tab.id,
      total: 0,
      matched: 0,
      shown: 0,
      dropped: 0,
      inFlight: idle.inFlight,
      excludedInFlight: idle.excludedInFlight,
      lastActivityAt: idle.lastActivityAt,
      generation: idle.generation,
      integrity: idle.integrity,
      attached: idle.attached,
    };
  }

  const ring = networkRingFor(tab.id) ?? { entries: [], dropped: 0 };

  const idle = networkIdleFor(tab.id, 0) ?? {
    inFlight: 0, excludedInFlight: 0, lastActivityAt: 0, generation: 0, integrity: "none" as const, attached: false,
  };

  const query: NetworkQuery = { urlContains: params.urlContains, types: params.types, limit: params.limit };
  const { shown, matched } = selectNetworkEntries(ring.entries, query);

  const text = formatNetworkReport(shown, {
    total: ring.entries.length,
    matched,
    dropped: ring.dropped,
    types: params.types,
    urlContains: params.urlContains,
  });

  return {
    text,
    tabId: tab.id,
    total: ring.entries.length,
    matched,
    shown: shown.length,
    dropped: ring.dropped,
    inFlight: idle.inFlight,
    excludedInFlight: idle.excludedInFlight,
    lastActivityAt: idle.lastActivityAt,
    generation: idle.generation,
    integrity: idle.integrity,
    attached: idle.attached,
  };
}
