/**
 * 光标状态层（background 侧）：把一轮任务的「在等 / 在读 / 完成 / 失败」挂到对应标签页的光标名牌上，
 * 并在它于别的标签页干活、用户看的是当前页时，给当前页右上角挂一个可点胶囊。
 *
 * 分工：文案与呈现属于页面侧（content-cursor.js），这里只决定状态、目标标签页和生命周期。
 * 状态不是执行证据：画不上不改变任务判定，执行结果仍以 tool_result 为准。
 */
import { callDom, ensureCursor } from "./exec/input.js";
import { parseExecutionKey } from "./tab-bindings.js";

export type CursorStatusState = "waiting" | "reading" | "done" | "failed";

type LivingStatus = {
  /** 执行键（会话 + 成员）：跨会话并行时同名成员各记各的 */
  key: string;
  sessionId: string;
  state: CursorStatusState;
  tabId: number | null;
  pillTabId?: number;
};

const living = new Map<string, LivingStatus>();
/** 用户接管或主动停止期间不上状态；下一次 agent 开始工作时解除。 */
const suppressed = new Set<string>();
let watching = false;

function instanceIdFor(key: string): string {
  return parseExecutionKey(key).sessionId;
}

function watchTabChanges(): void {
  if (watching) return;
  watching = true;
  try {
    chrome.tabs.onActivated.addListener(() => {
      void resyncPills();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      void forgetTab(tabId);
    });
  } catch {
    /* 测试环境没有标签页事件 */
  }
}

async function paintStatus(tabId: number, key: string, state: CursorStatusState): Promise<void> {
  try {
    await ensureCursor(tabId);
    await callDom(
      tabId,
      (id: string, s: CursorStatusState) => {
        window.__sideagent?.cursor?.for(id)?.setStatus?.({ state: s });
      },
      [instanceIdFor(key), state],
    );
  } catch {
    /* 页面禁止注入：状态画不上不影响任务本身 */
  }
}

async function paintClear(tabId: number, key: string): Promise<void> {
  try {
    await callDom(
      tabId,
      (id: string) => {
        window.__sideagent?.cursor?.for(id)?.clearStatus?.();
      },
      [instanceIdFor(key)],
    );
  } catch {
    /* 页面关闭或导航中 */
  }
}

async function paintPill(
  tabId: number,
  key: string,
  state: CursorStatusState,
  title: string,
  sessionId: string,
  targetTabId: number | null,
): Promise<void> {
  if (targetTabId == null) return;
  try {
    await ensureCursor(tabId);
    await callDom(
      tabId,
      (id: string, view: { state: CursorStatusState; title: string; sessionId: string; tabId: number }) => {
        window.__sideagent?.cursor?.for(id)?.showCrossPage?.(view);
      },
      [instanceIdFor(key), { state, title, sessionId, tabId: targetTabId }],
    );
  } catch {
    /* 页面禁止注入 */
  }
}

async function hidePill(tabId: number): Promise<void> {
  try {
    await callDom(
      tabId,
      () => {
        window.__sideagent?.cursor?.hideCrossPage?.();
      },
      [],
    );
  } catch {
    /* 页面关闭或导航中 */
  }
}

async function activeTabId(): Promise<number | null> {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active?.id ?? null;
  } catch {
    return null;
  }
}

async function dropPill(entry: LivingStatus): Promise<void> {
  const pillTabId = entry.pillTabId;
  entry.pillTabId = undefined;
  if (pillTabId != null) await hidePill(pillTabId);
}

/** 只在它真的在别的标签页干活时留胶囊；等待/读页面之外的阶段、和页面相同的情况都收起。 */
async function syncPill(entry: LivingStatus): Promise<void> {
  const ambient = entry.state === "waiting" || entry.state === "reading";
  if (entry.tabId == null || !ambient) {
    await dropPill(entry);
    return;
  }
  const active = await activeTabId();
  if (active == null || active === entry.tabId) {
    await dropPill(entry);
    return;
  }
  let title = "另一个页面";
  try {
    title = (await chrome.tabs.get(entry.tabId)).title?.trim() || title;
  } catch {
    /* 页面已被关掉，胶囊仍指向那个标签 */
  }
  const previous = entry.pillTabId;
  entry.pillTabId = active;
  if (previous != null && previous !== active) await hidePill(previous);
  // 目标标签页随胶囊一起下发：点击时不必再查内存状态（service worker 可能已经重启过）
  await paintPill(active, entry.key, entry.state, title, entry.sessionId, entry.tabId);
}

async function resyncPills(): Promise<void> {
  for (const entry of living.values()) await syncPill(entry);
}

async function forgetTab(tabId: number): Promise<void> {
  for (const [key, entry] of [...living]) {
    if (entry.pillTabId === tabId) entry.pillTabId = undefined;
    if (entry.tabId === tabId) living.delete(key);
  }
}

/** 任务状态落到光标名牌；同时同步右上角跨页胶囊。key 是执行键（会话 + 成员）。 */
export async function showCursorStatus(opts: {
  key: string;
  state: CursorStatusState;
  tabId?: number | null;
}): Promise<void> {
  if (suppressed.has(opts.key)) return;
  watchTabChanges();
  const tabId = opts.tabId ?? null;
  const previous = living.get(opts.key);
  const keepPill = previous?.pillTabId != null && previous.pillTabId === tabId ? previous.pillTabId : undefined;
  const entry: LivingStatus = {
    key: opts.key,
    sessionId: instanceIdFor(opts.key),
    state: opts.state,
    tabId,
    pillTabId: keepPill,
  };
  living.set(opts.key, entry);
  if (previous?.pillTabId != null && previous.pillTabId !== tabId) await hidePill(previous.pillTabId);
  if (tabId == null) return;
  await paintStatus(tabId, opts.key, opts.state);
  await syncPill(entry);
}

export async function clearCursorStatus(key: string): Promise<void> {
  const entry = living.get(key);
  if (!entry) return;
  living.delete(key);
  if (entry.pillTabId != null) await hidePill(entry.pillTabId);
  if (entry.tabId != null) await paintClear(entry.tabId, entry.key);
}

/** 只清「暂时性」状态（等待/读页面）。完成由页面自己收，失败要留到下一轮或接管。 */
export async function clearAmbientCursorStatus(key: string): Promise<void> {
  const entry = living.get(key);
  if (!entry || entry.state === "done" || entry.state === "failed") return;
  await clearCursorStatus(key);
}

/** 用户接管或主动停止：立刻收掉状态，并在恢复工作前不再上新状态。 */
export async function suppressCursorStatus(key: string): Promise<void> {
  suppressed.add(key);
  await clearCursorStatus(key);
}

export function resumeCursorStatus(key: string): void {
  suppressed.delete(key);
}

/** 点胶囊：从发消息的标签页反查「它正在干活的那个页面」。 */
export function workingTabBehindPill(senderTabId: number | null | undefined): number | null {
  if (senderTabId == null) return null;
  for (const entry of living.values()) {
    if (entry.pillTabId === senderTabId && entry.tabId != null) return entry.tabId;
  }
  return null;
}

export function resetCursorStatusForTests(): void {
  living.clear();
  suppressed.clear();
}

export function cursorStatusForTests(key: string): LivingStatus | null {
  const entry = living.get(key);
  return entry ? { ...entry } : null;
}
