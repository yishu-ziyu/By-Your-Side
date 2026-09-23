/**
 * chrome.debugger 封装：attach 状态跟踪、空闲 15s 自动 detach
 * （缩短页面顶部"正在调试"黄条的停留时间）。
 * FIX-02：detach / SW 重启后同步网络捕获完整性；不取消既有 15s 空闲 detach，不永久 attach。
 * CAP-02A：arm 期间 holdAttach 阻止空闲 detach，避免订阅窗口被掐断。
 * CAP-02C：已拥有页面的 OOPIF child/flat session 登记（公共 raw CDP 仍禁止任意 Target.*）。
 */
import { oneLine } from "./util.js";
import { withTimeout } from "./timeout.js";
import { enableNetworkCapture, noteNetworkCaptureDetached } from "./network-log.js";
import { enablePageEventCapture, notePageEventsDetached } from "./page-events.js";

const PROTOCOL_VERSION = "1.3";

const IDLE_MS = 15_000;

const attached = new Set<number>();

const inFlight = new Map<number, Promise<void>>();

/** CAP-02A：>0 时该 tab 不因空闲 detach（arm/wait 窗口）。 */
const attachHolds = new Map<number, number>();

let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** CAP-02C：父 tab → OOPIF child session（仅 flatten auto-attach 发现的已拥有页子目标）。 */
export type ChildFrameSession = {
  parentTabId: number;
  sessionId: string;
  targetId: string;
  /** CDP frame tree 中的 frameId（若可得）。 */
  frameId?: string;
  url?: string;
};

const childSessionsByTab = new Map<number, Map<string, ChildFrameSession>>();

const childSessionsBySession = new Map<string, ChildFrameSession>();

const autoAttachReady = new Set<number>();

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

/** 事件 arm 期间保持 attach；成对 releaseAttachHold。 */
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
}

/** 只读：当前 tab 已登记的 OOPIF child session（无真实 attach 证据则为空）。 */
export function listChildFrameSessions(tabId: number): ChildFrameSession[] {
  return [...(childSessionsByTab.get(tabId)?.values() ?? [])];
}

export function getChildFrameSession(sessionId: string): ChildFrameSession | undefined {
  return childSessionsBySession.get(sessionId);
}

/**
 * 在已拥有 tab 上启用 flatten auto-attach，登记跨进程 iframe 的 child session。
 * 不开放公共 raw CDP 的任意 Target.*；仅宿主为已拥有页面建立内部绑定。
 */
export async function ensureChildFrameSessions(tabId: number): Promise<ChildFrameSession[]> {
  await ensureAttached(tabId);

  if (!autoAttachReady.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      autoAttachReady.add(tabId);
    } catch (e) {
      throw new Error(`OOPIF auto-attach 失败：${oneLine(e)}`);
    }
  }

  return listChildFrameSessions(tabId);
}

/** 向已登记的 child session 发 CDP（须先 ensureChildFrameSessions）。 */
export async function sendCommandOnSession<T = unknown>(
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const child = childSessionsBySession.get(sessionId);

  if (!child) throw new Error(`未知 child session ${sessionId}；请先在已拥有页面上 ensureChildFrameSessions`);

  if (method.startsWith("Target.") && method !== "Target.getTargetInfo") {
    throw new Error(`child session 禁止任意 ${method}；仅宿主内部绑定使用`);
  }

  holdAttach(child.parentTabId);

  try {
    await ensureAttached(child.parentTabId);

    if (childSessionsBySession.get(sessionId) !== child) {
      throw Object.assign(new Error("Child frame session changed before dispatch; observe it again"), { executionFact: "not_executed" });
    }

    try {
      // SAFETY: T 由调用方按它请求的那个 CDP 方法声明；sendCommand 原样回传该方法的结果体。
      return await chrome.debugger.sendCommand({ tabId: child.parentTabId, sessionId }, method, params ?? {}) as T;
    } catch (error) {
      throw Object.assign(new Error(oneLine(error)), { executionFact: "unknown" });
    }
  } finally {
    releaseAttachHold(child.parentTabId);
  }
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

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) {
    scheduleIdleDetach();

    return;
  }

  // 如果已有 in-flight 的 attach Promise，复用它
  const existing = inFlight.get(tabId);

  if (existing) {
    return existing;
  }

  // 创建新的 attach Promise
  const promise = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (e) {
      const msg = oneLine(e);

      if (/another debugger|already attached/i.test(msg)) {
        // Chrome uses the same "another debugger" error after our SW forgets
        // its own live session. A native read succeeds only for our attachment;
        // do not infer ownership from the error text or replay the failed action.
        let ownsSession = false;

        try {
          // SAFETY: Page.getFrameTree 成功时必回 {frameTree:{frame:{id}}}；可选链只防序列化缺口，id 非空即本附件所有。
          const tree = await withTimeout(chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree"),
            1500, "Debugger ownership check timed out") as { frameTree?: { frame?: { id?: string } } };

          ownsSession = !!tree?.frameTree?.frame?.id;
        } catch { /* A foreign debugger or an unresponsive session remains unavailable. */ }

        if (!ownsSession) throw new Error("PERMISSION_DENIED: 该标签页正被 DevTools 或其他调试器占用");
      } else {
        throw new Error(msg);
      }
    }

    attached.add(tabId);
    scheduleIdleDetach();
    // 默认 late：没有记录 ≠ 没有请求。导航产生的 Document 请求会把 integrity 提升为 ok。
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
  checkBeforeDispatch?: () => void,
  timeoutMs?: number,
): Promise<T> {
  // Attachment and command delivery are different facts. Once sent, a missing
  // reply cannot authorize a replay, even when Chromium reports a detach.
  holdAttach(tabId);

  try {
    try {
      checkBeforeDispatch?.();
      await ensureAttached(tabId);
      checkBeforeDispatch?.();
    } catch (error) {
      throw Object.assign(new Error(oneLine(error)), { executionFact: "not_executed" });
    }

    try {
      const pending = chrome.debugger.sendCommand({ tabId }, method, params ?? {});

      // SAFETY: T 由调用方按它请求的那个 CDP 方法声明；这里只是给 ACK 或超时路径补上同一结果类型。
      return await (timeoutMs === undefined ? pending : withTimeout(pending, timeoutMs,
        `CDP ${method} ACK ${timeoutMs}ms timeout; execution unknown; do not replay`)) as T;
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

export async function detach(tabId: number): Promise<void> {
  clearChildSessions(tabId);
  attached.delete(tabId);
  inFlight.delete(tabId);
  noteNetworkCaptureDetached(tabId);
  notePageEventsDetached(tabId);

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* 已分离则忽略 */
  }
}

export async function detachAll(): Promise<void> {
  attachHolds.clear();
  await Promise.all([...attached].map((id) => detach(id)));
}

// 用户打开 DevTools 或其他原因导致分离时，同步内部状态与网络捕获完整性；受限环境静默跳过。
// chrome 不存在时（例如纯 Node 下单测加载本模块）整个登记块跳过：扩展运行时里 chrome 恒存在，行为不变。
if (typeof chrome !== "undefined" && chrome.debugger) {
  chrome.debugger.onDetach?.addListener((source) => {
    if (source.tabId == null) return;
    clearChildSessions(source.tabId);
    attached.delete(source.tabId);
    noteNetworkCaptureDetached(source.tabId);
    notePageEventsDetached(source.tabId);
  });

  // CAP-02C：登记 flatten auto-attach 发现的子目标（仅已 attach 的父 tab）。
  chrome.debugger.onEvent?.addListener((source, method, params) => {
    if (source.tabId == null || !attached.has(source.tabId)) return;

    if (method === "Target.attachedToTarget") {
      // SAFETY: Target.attachedToTarget 的 params 就是 CDP 的 AttachedToTarget 事件体，字段与 targetInfo 对齐。
      noteAttachedToTarget(source.tabId, (params ?? {}) as {
        sessionId?: string;
        targetInfo?: { targetId?: string; type?: string; url?: string };
      });
    } else if (method === "Target.detachedFromTarget") {
      // SAFETY: Target.detachedFromTarget 的 params 必带 sessionId；可选链只防异常事件体。
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;

      if (sessionId) noteDetachedFromTarget(sessionId);
    }
  });
}
