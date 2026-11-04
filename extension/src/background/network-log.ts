import {
  applyNetworkLifecycle,
  clearNetworkDisplay,
  createNetworkLifecycle,
  idleObservation,
  markCaptureDetached,
  markCaptureEnabled,
  markCaptureGap,
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

function listenNetworkEvents(): void {
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

export function networkIdleFor(tabId: number, idleMs: number = 0, now: number = Date.now()): IdleObservation | null {
  const life = lifecycles.get(tabId);

  if (!life) return null;

  return idleObservation(life, { now, idleMs });
}

export function clearNetworkRing(tabId: number): number {
  const life = lifeFor(tabId);
  const cleared = life.ring.entries.length;
  setLife(tabId, clearNetworkDisplay(life));

  return cleared;
}

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

export function noteNetworkCaptureDetached(tabId: number): void {
  enabled.delete(tabId);
  setLife(tabId, markCaptureDetached(lifeFor(tabId)));
}
