/**
 * 光标状态层（background 侧）：把一轮任务的「在等 / 在读 / 完成 / 失败」挂到对应标签页的光标名牌上，
 * 并在它于别的标签页干活、用户看的是当前页时，给当前页右上角挂一个可点胶囊。
 *
 * 分工：文案与呈现属于页面侧（content-cursor.js），这里只决定状态、目标标签页和生命周期。
 * 状态不是执行证据：画不上不改变任务判定，执行结果仍以 tool_result 为准。
 */
import { callDom, ensureCursor } from "./exec/input.js";
import { parseExecutionKey } from "./tab-bindings.js";
import { feedbackIsStale, type FeedbackPillView } from "../shared/feedback-pill.js";
import type { ExecutionFeedback } from "../../../shared/execution-feedback.js";

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
        await callDom(tabId, (id: string, value: CrossPageView) => {
          window.__sideagent?.cursor?.for(id)?.showCrossPage?.(value);
        }, [instanceIdFor(entry.key), { state: entry.state, title, sessionId: entry.sessionId, tabId: targetTabId, members: [...(pillOwners.get(tabId)?.values() ?? [])].filter(v => isCurrentEntry(v.entry) && v.entry.tabId != null).map(v => ({ sessionId: v.entry.sessionId, title: v.title, state: v.entry.state, tabId: v.entry.tabId! })) }]);
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
  // Ending a failed run is not evidence of recovery. A new working state may replace it.
  if (previous?.state === "failed" && opts.state === "done") return;
  const entry: LivingStatus = {
    key: opts.key,
    sessionId: instanceIdFor(opts.key),
    state: opts.state,
    tabId,
  };
  living.set(opts.key, entry);
  if (previous) {
    await dropPill(previous);
    if (previous.tabId != null && previous.tabId !== tabId) await renderStatus(previous.tabId, opts.key);
  }
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

// ── 执行反馈胶囊（V2）───────────────────────────────────────────────
// 简单成功/未知/等待确认的宿主事实：画到用户正在看的那一页；动作回执另有目标页时也画过去。
// 查看/重绘、回避旧结果覆盖、受限页降级由这里的台账与调用方负责。

/** 每个标签页最近一次反馈身份：同一结果不重发，时间更早的结果不得覆盖更新的。 */
const feedbackSeen = new Map<number, { id: string; at: number }>();
const feedbackPaints = new Map<number, Promise<boolean>>();
/** 最近画过反馈的页面（含动作落点页）：新一轮工作开始时一并收掉，不留下旧回执。 */
const feedbackTabs = new Set<number>();

function paintFeedback(tabId: number, view: FeedbackPillView): Promise<boolean> {
  const next = (feedbackPaints.get(tabId) ?? Promise.resolve(false)).then(async () => {
    try {
      await ensureCursor(tabId);
      await callDom(tabId, (pill: FeedbackPillView) => {
        // SAFETY: content-cursor.js 由本扩展注入；showFeedback 是同一契约的可选方法，老版本注入脚本没有它也不影响结果判定。
        (window.__sideagent?.cursor as {showFeedback?: (view: FeedbackPillView) => void} | undefined)?.showFeedback?.(pill);
      }, [view]);
      return true;
    } catch {
      return false;
    }
  });
  feedbackPaints.set(tabId, next);
  void next.finally(() => { if (feedbackPaints.get(tabId) === next) feedbackPaints.delete(tabId); });
  return next;
}

/**
 * 对用户有意义的一次执行反馈：画到当前页与动作目标页。
 * 返回值只回答「用户当前看的那一页是否看到」：可见页受限而别的页画上时仍算没看到，
 * 由调用方用侧栏文字降级；受限页画不上不当作任务失败。
 */
export async function showExecutionFeedback(feedback: ExecutionFeedback): Promise<boolean> {
  const view: FeedbackPillView = {
    id: feedback.id,
    text: feedback.text,
    kind: feedback.kind,
    ...(feedback.facts.detail ? { detail: feedback.facts.detail } : {}),
  };
  const active = await activeTabId();
  const targets = [...new Set([active, feedback.facts.tabId ?? null].filter((id): id is number => typeof id === "number"))];
  let shownOnActive = false;
  let shownAny = false;
  for (const tabId of targets) {
    const seen = feedbackSeen.get(tabId);
    if (seen && (seen.id === feedback.id || feedbackIsStale(seen.at, feedback.createdAt))) continue;
    feedbackSeen.set(tabId, { id: feedback.id, at: feedback.createdAt });
    const painted = await paintFeedback(tabId, view);
    if (!painted) continue;
    shownAny = true;
    feedbackTabs.add(tabId);
    if (active == null || tabId === active) shownOnActive = true;
  }
  return active == null ? shownAny : shownOnActive;
}

/** 新的一轮真实工作开始：上一轮的旧回执失效，收掉可见胶囊（不等于失败）。 */
export async function retireExecutionFeedback(explicitTabId?: number | null): Promise<void> {
  const tabIds = [...new Set([await activeTabId(), explicitTabId ?? null, ...feedbackTabs].filter((id): id is number => typeof id === "number"))];
  feedbackTabs.clear();
  for (const tabId of tabIds) {
    feedbackSeen.delete(tabId);
    try {
      await ensureCursor(tabId);
      await callDom(tabId, () => { (window.__sideagent?.cursor as {hideFeedback?: () => void} | undefined)?.hideFeedback?.(); }, []);
    } catch { /* 受限页没有胶囊可收。 */ }
  }
}
