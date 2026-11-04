import { callDom, ensureCursor } from "./exec/page-call.js";
import { parseExecutionKey } from "./tab-bindings.js";

const lit = new Map<string, number>();

const paints = new Map<number, Promise<void>>();

function paint(tabId: number, key: string): Promise<void> {
  const next = (paints.get(tabId) ?? Promise.resolve()).then(async () => {
    try {
      if (lit.get(key) === tabId) await ensureCursor(tabId);
      await callDom(tabId, (id: string, on: boolean) => {
        window.__sideagent?.cursor?.for(id)?.setGlow?.(on);
      }, [parseExecutionKey(key).sessionId, lit.get(key) === tabId]);
    } catch {  }
  });

  paints.set(tabId, next);
  void next.finally(() => { if (paints.get(tabId) === next) paints.delete(tabId); });

  return next;
}

let watching = false;

export function glowPage(key: string, tabId: number | null): Promise<void> {
  if (!watching) {
    watching = true;

    try {
      chrome.tabs.onRemoved.addListener(forgetGlowTab);
      chrome.tabs.onUpdated.addListener((id, info) => {
        if (info.status !== "complete") return;
        for (const [k, litTab] of lit) if (litTab === id) void paint(id, k);
      });
    } catch {  }
  }

  const previous = lit.get(key);

  if (tabId == null) return Promise.resolve();
  lit.set(key, tabId);

  return Promise.all([previous != null && previous !== tabId ? paint(previous, key) : null, paint(tabId, key)]).then(() => {});
}

export function dimPage(key: string): Promise<void> {
  const previous = lit.get(key);

  if (previous == null) return Promise.resolve();
  lit.delete(key);

  return paint(previous, key);
}

function forgetGlowTab(tabId: number): void {
  for (const [key, litTab] of lit) if (litTab === tabId) lit.delete(key);
}

export function litInstances(tabId: number): Set<string> {
  return new Set([...lit].filter(([, litTab]) => litTab === tabId).map(([key]) => parseExecutionKey(key).sessionId));
}
