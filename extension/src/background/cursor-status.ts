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

const statusPaints = new Map<string, Promise<void>>();

/** A status and its clear share a queue, including the asynchronous injection step. */
function renderStatus(tabId: number, key: string): Promise<void> {
  const id = `${tabId}:${key}`;
  const next = (statusPaints.get(id) ?? Promise.resolve()).then(async () => {
    try {
      if (living.get(key)?.tabId === tabId) await ensureCursor(tabId);
      const entry = living.get(key);
      if (entry?.tabId === tabId) {
        await callDom(tabId, (instanceId: string, state: CursorStatusState) => {
          window.__sideagent?.cursor?.for(instanceId)?.setStatus?.({ state });
        }, [instanceIdFor(key), entry.state]);
      } else {
        await callDom(tabId, (instanceId: string) => {
          window.__sideagent?.cursor?.for(instanceId)?.clearStatus?.();
        }, [instanceIdFor(key)]);
      }
    } catch { /* Closed or restricted page. */ }
  });
  statusPaints.set(id, next);
  void next.finally(() => { if (statusPaints.get(id) === next) statusPaints.delete(id); });
  return next;
}

type PillView = { entry: LivingStatus; title: string };
const pillOwners = new Map<number, Map<string, PillView>>();
const pillPaints = new Map<number, Promise<void>>();

function currentPill(tabId: number): PillView | undefined {
  return [...(pillOwners.get(tabId)?.values() ?? [])].reverse().find(({ entry }) => isCurrentEntry(entry));
}

/** Serialize writes per page, then re-read intent after injection: a late paint cannot undo a clear. */
function renderPill(tabId: number): Promise<void> {
  const next = (pillPaints.get(tabId) ?? Promise.resolve()).then(async () => {
    try {
      if (currentPill(tabId)) await ensureCursor(tabId);
      const view = currentPill(tabId);
      const targetTabId = view?.entry.tabId;
      if (view && targetTabId != null) {
        const { entry, title } = view;
        await callDom(tabId, (id: string, value: { state: CursorStatusState; title: string; sessionId: string; tabId: number }) => {
          window.__sideagent?.cursor?.for(id)?.showCrossPage?.(value);
        }, [instanceIdFor(entry.key), { state: entry.state, title, sessionId: entry.sessionId, tabId: targetTabId }]);
      } else {
        await callDom(tabId, () => { window.__sideagent?.cursor?.hideCrossPage?.(); }, []);
      }
    } catch { /* A closed or restricted page cannot change task success. */ }
  });
  pillPaints.set(tabId, next);
  void next.finally(() => { if (pillPaints.get(tabId) === next) pillPaints.delete(tabId); });
  return next;
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
  if (pillTabId != null) {
    const owners = pillOwners.get(pillTabId);
    if (owners?.get(entry.key)?.entry === entry) owners.delete(entry.key);
    if (owners?.size === 0) pillOwners.delete(pillTabId);
    await renderPill(pillTabId);
  }
}

/**
 * 绘制中间有 await：这期间同一执行键可能被 clear/suppress 掉、或换成新状态的新登记。
 * 只有「仍是当前登记的那一份」才有资格改动页面上的胶囊，否则旧绘制会把已经收掉的
 * 跨页提示重新画回来、或把新状态/别的会话的胶囊盖掉。
 */
function isCurrentEntry(entry: LivingStatus): boolean {
  return living.get(entry.key) === entry;
}

/** 只在它真的在别的标签页干活时留胶囊；等待/读页面之外的阶段、和页面相同的情况都收起。 */
async function syncPill(entry: LivingStatus): Promise<void> {
  const ambient = entry.state === "waiting" || entry.state === "reading";
  if (entry.tabId == null || !ambient) {
    if (isCurrentEntry(entry)) await dropPill(entry);
    return;
  }
  const active = await activeTabId();
  if (!isCurrentEntry(entry)) return;
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
  if (!isCurrentEntry(entry)) return;
  if (previous != null && previous !== active) await dropPill(entry);
  if (!isCurrentEntry(entry)) return;
  // 目标标签页随胶囊一起下发：点击时不必再查内存状态（service worker 可能已经重启过）
  entry.pillTabId = active;
  const owners = pillOwners.get(active) ?? new Map<string, PillView>();
  owners.delete(entry.key);
  owners.set(entry.key, { entry, title });
  pillOwners.set(active, owners);
  await renderPill(active);
}

async function resyncPills(): Promise<void> {
  for (const entry of living.values()) await syncPill(entry);
}

async function forgetTab(tabId: number): Promise<void> {
  pillOwners.delete(tabId);
  for (const [key, entry] of [...living]) {
    if (entry.pillTabId === tabId) entry.pillTabId = undefined;
    if (entry.tabId === tabId) await clearCursorStatus(key);
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
  const entry: LivingStatus = {
    key: opts.key,
    sessionId: instanceIdFor(opts.key),
    state: opts.state,
    tabId,
  };
  living.set(opts.key, entry);
  if (previous) await dropPill(previous);
  if (tabId == null) return;
  if (!isCurrentEntry(entry)) return;
  await renderStatus(tabId, opts.key);
  if (!isCurrentEntry(entry)) return;
  await syncPill(entry);
}

export async function clearCursorStatus(key: string): Promise<void> {
  const entry = living.get(key);
  if (!entry) return;
  living.delete(key);
  await dropPill(entry);
  if (entry.tabId != null) await renderStatus(entry.tabId, entry.key);
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
  return currentPill(senderTabId)?.entry.tabId ?? null;
}

export function resetCursorStatusForTests(): void {
  living.clear();
  suppressed.clear();
  pillOwners.clear();
  pillPaints.clear();
  statusPaints.clear();
}

export function cursorStatusForTests(key: string): LivingStatus | null {
  const entry = living.get(key);
  return entry ? { ...entry } : null;
}
