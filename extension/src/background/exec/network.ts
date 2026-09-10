/**
 * `network` 工具：读当前工作标签页的被动请求记录（CDP Network 域环形缓冲）。
 * 只读，不改页面；attach 失败（如用户开着 DevTools）不伪造数据。
 * 依据 docs/evals/20260911-network.md。
 */
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { formatNetworkReport, selectNetworkEntries, type NetworkQuery } from "../../../../shared/network.js";
import { ensureAttached } from "../debugger.js";
import { clearNetworkRing, enableNetworkCapture, networkRingFor } from "../network-log.js";
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
}

export async function network(params: NetworkParams, sessionId: string = LEAD_SESSION_ID): Promise<NetworkResult> {
  const tab = await resolveReadableTab(params.tabId, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");

  // 尽量从现在起有记录；attach 失败不影响读已有缓冲。
  try {
    await ensureAttached(tab.id);
    await enableNetworkCapture(tab.id);
  } catch {
    /* DevTools 占用或页面受限：已有记录照常返回 */
  }

  if (params.clear === true) {
    const cleared = clearNetworkRing(tab.id);
    return {
      text: `Network buffer cleared (${cleared} request${cleared === 1 ? "" : "s"} dropped). Do the action you want to observe, then call network again.`,
      tabId: tab.id,
      total: 0,
      matched: 0,
      shown: 0,
      dropped: 0,
    };
  }

  const ring = networkRingFor(tab.id) ?? { entries: [], dropped: 0 };
  const query: NetworkQuery = { urlContains: params.urlContains, types: params.types, limit: params.limit };
  const { shown, matched } = selectNetworkEntries(ring.entries, query);
  const text = formatNetworkReport(shown, {
    total: ring.entries.length,
    matched,
    dropped: ring.dropped,
    types: params.types,
    urlContains: params.urlContains,
  });
  return { text, tabId: tab.id, total: ring.entries.length, matched, shown: shown.length, dropped: ring.dropped };
}
