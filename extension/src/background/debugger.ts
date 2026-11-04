import { oneLine } from "./util.js";
import { withTimeout } from "./timeout.js";
import { enableNetworkCapture, noteNetworkCaptureDetached } from "./network-log.js";
import { enablePageEventCapture, notePageEventsDetached } from "./page-events.js";

const PROTOCOL_VERSION = "1.3";

const IDLE_MS = 15_000;

const SETTLED_IDLE_MS = 1_000;

const attached = new Set<number>();

const inFlight = new Map<number, Promise<void>>();

const attachHolds = new Map<number, number>();

let idleTimer: ReturnType<typeof setTimeout> | null = null;

type ChildFrameSession = {
  parentTabId: number;
  sessionId: string;
  targetId: string;
  frameId?: string;
  url?: string;
};

const childSessionsByTab = new Map<number, Map<string, ChildFrameSession>>();

const childSessionsBySession = new Map<string, ChildFrameSession>();

const autoAttachReady = new Set<number>();

const autoAttachPending = new Map<number, Promise<void>>();

function scheduleIdleDetach(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void detachIdle();
  }, IDLE_MS);
}

async function detachIdle(): Promise<void> {
  const targets = [...attached].filter((tabId) => (attachHolds.get(tabId) ?? 0) <= 0);
  await Promise.all(targets.map((id) => detach(id)));

  if (attached.size > 0) scheduleIdleDetach();
}

export function detachSoon(): void {
  if (attached.size === 0) return;

  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void detachIdle();
  }, SETTLED_IDLE_MS);
}

export function holdAttach(tabId: number): void {
  attachHolds.set(tabId, (attachHolds.get(tabId) ?? 0) + 1);
  scheduleIdleDetach();
}

export function releaseAttachHold(tabId: number): void {
  const n = (attachHolds.get(tabId) ?? 0) - 1;

  if (n <= 0) attachHolds.delete(tabId);
  else attachHolds.set(tabId, n);
  scheduleIdleDetach();
}

function clearChildSessions(tabId: number): void {
  const map = childSessionsByTab.get(tabId);

  if (map) for (const session of map.values()) childSessionsBySession.delete(session.sessionId);
  childSessionsByTab.delete(tabId);
  autoAttachReady.delete(tabId);
  autoAttachPending.delete(tabId);
}

export async function childFrameSession(tabId: number, frameId: string): Promise<string> {
  await ensureAttached(tabId);
  if (!autoAttachReady.has(tabId)) {
    let pending = autoAttachPending.get(tabId);
    if (!pending) {
      pending = chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      }).then(() => { autoAttachReady.add(tabId); }).finally(() => { autoAttachPending.delete(tabId); });
      autoAttachPending.set(tabId, pending);
    }
    await pending;
  }
  const lookup = () => [...(childSessionsByTab.get(tabId)?.values() ?? [])].find(child => child.targetId === frameId)?.sessionId;
  const existing = lookup();
  if (existing) return existing;
  return await withTimeout(new Promise<string>(resolve => {
    const listener = (source: chrome.debugger.Debuggee, method: string) => {
      if (source.tabId !== tabId || method !== "Target.attachedToTarget") return;
      const sessionId = lookup();
      if (sessionId) { chrome.debugger.onEvent.removeListener(listener); resolve(sessionId); }
    };
    chrome.debugger.onEvent.addListener(listener);
    const sessionId = lookup();
    if (sessionId) { chrome.debugger.onEvent.removeListener(listener); resolve(sessionId); }
    setTimeout(() => chrome.debugger.onEvent.removeListener(listener), 2000);
  }), 2000, "无法核对内嵌页面");
}

export async function sendChildCommand<T>(tabId: number, sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const child = childSessionsBySession.get(sessionId);
  if (!child || child.parentTabId !== tabId) throw new Error("内嵌页面已变化");
  return await chrome.debugger.sendCommand({ tabId, sessionId }, method, params) as T;
}

function noteAttachedToTarget(parentTabId: number, params: {
  sessionId?: string;
  targetInfo?: { targetId?: string; type?: string; url?: string };
}): void {
  const sessionId = params.sessionId;
  const targetId = params.targetInfo?.targetId;

  if (!sessionId || !targetId) return;

  if (params.targetInfo?.type && params.targetInfo.type !== "iframe" && params.targetInfo.type !== "page") {
    return;
  }

  const entry: ChildFrameSession = {
    parentTabId,
    sessionId,
    targetId,
    url: params.targetInfo?.url,
  };

  let map = childSessionsByTab.get(parentTabId);

  if (!map) {
    map = new Map();
    childSessionsByTab.set(parentTabId, map);
  }

  map.set(sessionId, entry);
  childSessionsBySession.set(sessionId, entry);
}

function noteDetachedFromTarget(sessionId: string): void {
  const child = childSessionsBySession.get(sessionId);

  if (!child) return;
  childSessionsBySession.delete(sessionId);
  childSessionsByTab.get(child.parentTabId)?.delete(sessionId);
}

export function debuggerAttached(tabId: number): boolean {
  return attached.has(tabId) || inFlight.has(tabId);
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) {
    scheduleIdleDetach();

    return;
  }

  const existing = inFlight.get(tabId);

  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (e) {
      const msg = oneLine(e);

      if (/another debugger|already attached/i.test(msg)) {
        let ownsSession = false;

        try {
          const tree = await withTimeout(chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree"),
            1500, "Debugger ownership check timed out") as { frameTree?: { frame?: { id?: string } } };

          ownsSession = !!tree?.frameTree?.frame?.id;
        } catch {  }

        if (!ownsSession) throw new Error("PERMISSION_DENIED: 该标签页正被 DevTools 或其他调试器占用");
      } else {
        throw new Error(msg);
      }
    }

    if (!(await chrome.tabs.get(tabId).then(t => t.active, () => true))) {
      await withTimeout(chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" }), 1500, "lifecycle").catch(() => undefined);
      await withTimeout(chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }), 1500, "focus emulation").catch(() => undefined);
    }
    attached.add(tabId);
    scheduleIdleDetach();
    void enableNetworkCapture(tabId, { mode: "late" });
    void enablePageEventCapture(tabId, { mode: "late" });
  })();

  inFlight.set(tabId, promise);

  try {
    await promise;
  } finally {
    inFlight.delete(tabId);
  }
}

export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  checkBeforeDispatch?: (() => void | Promise<void>) & {checkNow?: () => void; noteEffect?: () => void},
  timeoutMs?: number,
): Promise<T> {
  holdAttach(tabId);

  try {
    try {
      await checkBeforeDispatch?.();
      await ensureAttached(tabId);
      await checkBeforeDispatch?.();
      checkBeforeDispatch?.checkNow?.();
    } catch (error) {
      throw Object.assign(new Error(oneLine(error)), { executionFact: "not_executed" });
    }

    try {
      const pending = chrome.debugger.sendCommand({ tabId }, method, params ?? {});

      if (method.startsWith("Input.") || method === "Runtime.evaluate" || method === "Runtime.callFunctionOn" || method === "DOM.setFileInputFiles" || method === "Page.handleJavaScriptDialog") checkBeforeDispatch?.noteEffect?.();

      return await (timeoutMs === undefined ? pending : withTimeout(pending, timeoutMs,
        `CDP ${method} ACK ${timeoutMs}ms timeout; execution unknown; re-read the page before retrying`)) as T;
    } catch (error) {
      const message = oneLine(error);

      if (/detach|not attached/i.test(message)) {
        attached.delete(tabId);
        inFlight.delete(tabId);
        clearChildSessions(tabId);
        noteNetworkCaptureDetached(tabId);
        notePageEventsDetached(tabId);
      }

      throw Object.assign(new Error(message), { executionFact: "unknown" });
    }
  } finally {
    releaseAttachHold(tabId);
  }
}

async function detach(tabId: number): Promise<void> {
  clearChildSessions(tabId);
  attached.delete(tabId);
  inFlight.delete(tabId);
  noteNetworkCaptureDetached(tabId);
  notePageEventsDetached(tabId);

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
  }
}

if (typeof chrome !== "undefined" && chrome.debugger) {
  chrome.debugger.onDetach?.addListener((source) => {
    if (source.tabId == null) return;
    clearChildSessions(source.tabId);
    attached.delete(source.tabId);
    noteNetworkCaptureDetached(source.tabId);
    notePageEventsDetached(source.tabId);
  });

  chrome.debugger.onEvent?.addListener((source, method, params) => {
    if (source.tabId == null || !attached.has(source.tabId)) return;

    if (method === "Target.attachedToTarget") {
      noteAttachedToTarget(source.tabId, (params ?? {}) as {
        sessionId?: string;
        targetInfo?: { targetId?: string; type?: string; url?: string };
      });
    } else if (method === "Target.detachedFromTarget") {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;

      if (sessionId) noteDetachedFromTarget(sessionId);
    }
  });
}
