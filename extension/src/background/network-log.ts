/**
 * CDP Network 事件的被动记录：按标签页环形缓冲 + 有界在途集合。
 * 只在扩展已经 attach 调试器时开启 Network 域；不额外 attach、不注入页面。
 * 展示 ring 的丢弃/clear 不抹掉仍在途请求；detach/晚接入/SW 重启记入捕获完整性。
 * 依据 docs/evals/20260911-network.md 与 FIX-02。
 */
import {
  applyNetworkLifecycle,
  clearNetworkDisplay,
  createNetworkLifecycle,
  idleObservation,
  markCaptureDetached,
  markCaptureEnabled,
  markCaptureGap,
  markCaptureRestart,
  networkEventToUpdate,
  type IdleObservation,
  type NetworkLifecycle,
  type NetworkRing,
} from "../../../shared/network.js";

const MAX_TABS = 20;

const lifecycles = new Map<number, NetworkLifecycle>();

const enabled = new Set<number>();

let listening = false;

function lifeFor(tabId: number): NetworkLifecycle {
  let life = lifecycles.get(tabId);

  if (!life) {
    life = createNetworkLifecycle();
    lifecycles.set(tabId, life);

    while (lifecycles.size > MAX_TABS) lifecycles.delete(lifecycles.keys().next().value!);
  }

  return life;
}

function setLife(tabId: number, life: NetworkLifecycle): void {
  lifecycles.set(tabId, life);
}

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
    if (source.tabId == null) return;
    enabled.delete(source.tabId);
    setLife(source.tabId, markCaptureDetached(lifeFor(source.tabId)));
  });
}

function record(tabId: number, method: string, params: Record<string, unknown>): void {
  const update = networkEventToUpdate(method, params);

  if (!update) return;
  setLife(tabId, applyNetworkLifecycle(lifeFor(tabId), update));
}

export function networkRingFor(tabId: number): NetworkRing | null {
  const life = lifecycles.get(tabId);

  return life ? life.ring : null;
}

export function networkLifecycleFor(tabId: number): NetworkLifecycle | null {
  return lifecycles.get(tabId) ?? null;
}

export function networkIdleFor(tabId: number, idleMs: number = 0, now: number = Date.now()): IdleObservation | null {
  const life = lifecycles.get(tabId);

  if (!life) return null;

  return idleObservation(life, { now, idleMs });
}

/** 清空该标签页的展示缓冲；在途集合保留。返回清掉的展示条数。 */
export function clearNetworkRing(tabId: number): number {
  const life = lifeFor(tabId);
  const cleared = life.ring.entries.length;
  setLife(tabId, clearNetworkDisplay(life));

  return cleared;
}

/**
 * 幂等开启 Network 域；要求调用方已 attach（本函数不 attach）。
 * mode=fresh：导航前接入，可证明完整捕获；mode=late：中途接入，不能把空缓冲当无请求。
 */
export async function enableNetworkCapture(tabId: number, opts?: { mode?: "fresh" | "late" }): Promise<void> {
  listenNetworkEvents();
  const mode = opts?.mode ?? "late";

  if (!enabled.has(tabId)) {
    setLife(tabId, markCaptureEnabled(lifeFor(tabId), { mode }));
  }

  if (enabled.has(tabId)) return;
  enabled.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  } catch {
    enabled.delete(tabId);
    setLife(tabId, markCaptureGap(lifeFor(tabId)));
  }
}

/** 导航前由 debugger 调用：把本次捕获标为 fresh（仍兼容 15s 空闲 detach）。 */
export function armFreshNetworkCapture(tabId: number): void {
  listenNetworkEvents();
  setLife(tabId, markCaptureEnabled(lifeFor(tabId), { mode: "fresh" }));
}

export function noteNetworkCaptureDetached(tabId: number): void {
  enabled.delete(tabId);
  setLife(tabId, markCaptureDetached(lifeFor(tabId)));
}

export function noteNetworkCaptureGap(tabId: number): void {
  setLife(tabId, markCaptureGap(lifeFor(tabId)));
}

/** 测试/SW 重启路径：清空内存态并记 restart。 */
export function resetNetworkCaptureForTests(): void {
  for (const tabId of lifecycles.keys()) {
    setLife(tabId, markCaptureRestart(lifeFor(tabId)));
  }

  lifecycles.clear();
  enabled.clear();
}
