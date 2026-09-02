/**
 * chrome.debugger 封装：attach 状态跟踪、空闲 15s 自动 detach
 * （缩短页面顶部"正在调试"黄条的停留时间）。
 */
import { oneLine } from "./util.js";

const PROTOCOL_VERSION = "1.3";
const IDLE_MS = 15_000;

const attached = new Set<number>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleDetach(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void detachAll();
  }, IDLE_MS);
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) {
    scheduleIdleDetach();
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    const msg = oneLine(e);
    if (/another debugger/i.test(msg)) {
      throw new Error("该标签页正被 DevTools 或其他调试器占用");
    }
    if (/already attached/i.test(msg)) {
      // SW 重启后 Chrome 侧仍挂着：视为已 attach
      attached.add(tabId);
      scheduleIdleDetach();
      return;
    }
    throw new Error(msg);
  }
  attached.add(tabId);
  scheduleIdleDetach();
}

export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  await ensureAttached(tabId);
  let result: unknown;
  try {
    result = await chrome.debugger.sendCommand({ tabId }, method, params ?? {});
  } catch (e) {
    throw new Error(oneLine(e));
  }
  scheduleIdleDetach();
  return result as T;
}

export async function detach(tabId: number): Promise<void> {
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* 已分离则忽略 */
  }
}

export async function detachAll(): Promise<void> {
  await Promise.all([...attached].map((id) => detach(id)));
}

// 用户打开 DevTools 或其他原因导致分离时，同步内部状态
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});
