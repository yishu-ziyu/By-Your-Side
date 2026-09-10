/**
 * CDP Network 事件的被动记录：按标签页环形缓冲。
 * 只在扩展已经 attach 调试器时开启 Network 域；不额外 attach、不注入页面。
 * 缓冲在内存里，SW 重启即空；分离调试器后已有记录保留。
 * 依据 docs/evals/20260911-network.md。
 */
import {
  networkEventToUpdate,
  patchNetworkEntry,
  restartNetworkEntry,
  type NetworkRing,
} from "../../../shared/network.js";

const MAX_TABS = 20;

const rings = new Map<number, NetworkRing>();
const enabled = new Set<number>();
let listening = false;

export function listenNetworkEvents(): void {
  if (listening) return;
  const events = chrome.debugger?.onEvent;
  if (!events?.addListener) return;
  listening = true;
  events.addListener((source, method, params) => {
    if (source.tabId == null || !method.startsWith("Network.")) return;
    record(source.tabId, method, (params ?? {}) as Record<string, unknown>);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId != null) enabled.delete(source.tabId);
  });
}

function record(tabId: number, method: string, params: Record<string, unknown>): void {
  const update = networkEventToUpdate(method, params);
  if (!update) return;
  const ring = rings.get(tabId) ?? { entries: [], dropped: 0 };
  rings.set(tabId, update.kind === "start" ? restartNetworkEntry(ring, update.entry) : patchNetworkEntry(ring, update.requestId, update.patch));
  while (rings.size > MAX_TABS) rings.delete(rings.keys().next().value!);
}

export function networkRingFor(tabId: number): NetworkRing | null {
  return rings.get(tabId) ?? null;
}

/** 清空该标签页的缓冲，返回清掉的条数。 */
export function clearNetworkRing(tabId: number): number {
  const ring = rings.get(tabId);
  rings.delete(tabId);
  return ring?.entries.length ?? 0;
}

/** 幂等开启 Network 域；要求调用方已 attach（本函数不 attach）。 */
export async function enableNetworkCapture(tabId: number): Promise<void> {
  listenNetworkEvents();
  if (enabled.has(tabId)) return;
  enabled.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  } catch {
    enabled.delete(tabId);
  }
}
