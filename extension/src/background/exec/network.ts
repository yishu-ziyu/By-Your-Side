import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { formatNetworkReport, pageTimingEntries, selectNetworkEntries, type NetworkEntry, type NetworkQuery } from "../../../../shared/network.js";
import { ensureAttached, sendCommand } from "../debugger.js";
import { clearNetworkRing, enableNetworkCapture, networkIdleFor, networkRingFor } from "../network-log.js";
import { resolveReadableTab } from "../state.js";

interface NetworkParams {
  tabId?: number;
  urlContains?: string;
  types?: string[] | "all";
  limit?: number;
  clear?: boolean;
}

interface NetworkResult {
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

const clearedAt = new Map<number, number>();

export async function network(params: NetworkParams, sessionId: string = LEAD_SESSION_ID): Promise<NetworkResult> {
  const tab = await resolveReadableTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  try {
    await ensureAttached(tab.id);
    await enableNetworkCapture(tab.id, { mode: "late" });
  } catch {
  }

  if (params.clear === true) {
    clearedAt.set(tab.id, Date.now());
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
  const entries = [...await requestsBeforeRecording(tab.id, ring.entries), ...ring.entries];

  const idle = networkIdleFor(tab.id, 0) ?? {
    inFlight: 0, excludedInFlight: 0, lastActivityAt: 0, generation: 0, integrity: "none" as const, attached: false,
  };

  const query: NetworkQuery = { urlContains: params.urlContains, types: params.types, limit: params.limit };
  const { shown, matched } = selectNetworkEntries(entries, query);

  const text = formatNetworkReport(shown, {
    total: entries.length,
    matched,
    dropped: ring.dropped,
    types: params.types,
    urlContains: params.urlContains,
  });

  return {
    text,
    tabId: tab.id,
    total: entries.length,
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

async function requestsBeforeRecording(tabId: number, recorded: readonly NetworkEntry[]): Promise<NetworkEntry[]> {
  const expression = `({ origin: performance.timeOrigin, rows: performance.getEntriesByType("resource").map(e => [e.name, e.initiatorType, e.responseStatus || 0, e.encodedBodySize || 0, e.duration, performance.timeOrigin + e.startTime]) })`;
  const reply = await sendCommand<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", { expression, returnByValue: true }, undefined, 1500).catch(() => undefined);

  return pageTimingEntries(reply?.result?.value, recorded, clearedAt.get(tabId));
}
