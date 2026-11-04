import { activeTargetTabs } from "./target-window.js";
import { callDom, ensureCursor } from "./exec/page-call.js";
import { parseExecutionKey } from "./tab-bindings.js";
import { feedbackIsStale, type FeedbackPillView } from "../shared/feedback-pill.js";
import type { ExecutionFeedback } from "../../../shared/execution-feedback.js";

export type CursorStatusState = "waiting" | "reading" | "translating" | "done" | "failed";

type LivingStatus = {
  key: string;
  sessionId: string;
  state: CursorStatusState;
  tabId: number | null;
  pillTabId?: number;
};

const living = new Map<string, LivingStatus>();

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
  }
}

const statusPaints = new Map<string, Promise<void>>();

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
    } catch {  }
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
        }, [instanceIdFor(entry.key), { state: entry.state, title, sessionId: entry.sessionId, tabId: targetTabId, members: [...(pillOwners.get(tabId)?.values() ?? [])].flatMap(v => isCurrentEntry(v.entry) && v.entry.tabId != null ? [{ sessionId: v.entry.sessionId, title: v.title, state: v.entry.state, tabId: v.entry.tabId!}] : []) }]);
      } else {
        await callDom(tabId, () => { window.__sideagent?.cursor?.hideCrossPage?.(); }, []);
      }
    } catch {  }
  });

  pillPaints.set(tabId, next);
  void next.finally(() => { if (pillPaints.get(tabId) === next) pillPaints.delete(tabId); });

  return next;
}

async function activeTabId(): Promise<number | null> {
  try {
    const [active] = await activeTargetTabs();

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

function isCurrentEntry(entry: LivingStatus): boolean {
  return living.get(entry.key) === entry;
}

async function syncPill(entry: LivingStatus): Promise<void> {
  const ambient = entry.state === "waiting" || entry.state === "reading" || entry.state === "translating";

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
  }

  const previous = entry.pillTabId;

  if (!isCurrentEntry(entry)) return;

  if (previous != null && previous !== active) await dropPill(entry);

  if (!isCurrentEntry(entry)) return;
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

  for (const [key, entry] of living) {
    if (entry.pillTabId === tabId) entry.pillTabId = undefined;

    if (entry.tabId === tabId) await clearCursorStatus(key);
  }
}

export async function showCursorStatus(opts: {
  key: string;
  state: CursorStatusState;
  tabId?: number | null;
}): Promise<void> {
  if (suppressed.has(opts.key)) return;
  watchTabChanges();
  const tabId = opts.tabId ?? null;
  const previous = living.get(opts.key);

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

export async function clearAmbientCursorStatus(key: string): Promise<void> {
  const entry = living.get(key);

  if (!entry || entry.state === "done" || entry.state === "failed") return;
  await clearCursorStatus(key);
}

export async function suppressCursorStatus(key: string): Promise<void> {
  suppressed.add(key);
  await clearCursorStatus(key);
}

export function resumeCursorStatus(key: string): void {
  suppressed.delete(key);
}

export function workingTabBehindPill(senderTabId: number | null | undefined): number | null {
  if (senderTabId == null) return null;

  return currentPill(senderTabId)?.entry.tabId ?? null;
}

const feedbackSeen = new Map<number, { id: string; at: number }>();

const feedbackPaints = new Map<number, Promise<boolean>>();

const feedbackTabs = new Set<number>();

function paintFeedback(tabId: number, view: FeedbackPillView): Promise<boolean> {
  const next = (feedbackPaints.get(tabId) ?? Promise.resolve(false)).then(async () => {
    try {
      await ensureCursor(tabId);
      await callDom(tabId, (pill: FeedbackPillView) => {
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

export async function showExecutionFeedback(feedback: ExecutionFeedback): Promise<boolean> {
  const view: FeedbackPillView = {
    id: feedback.id,
    text: feedback.text,
    kind: feedback.kind,
  };

  if (feedback.facts.detail) view.detail = feedback.facts.detail;

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

export async function retireExecutionFeedback(explicitTabId?: number | null): Promise<void> {
  const tabIds = [...new Set([await activeTabId(), explicitTabId ?? null, ...feedbackTabs].filter((id): id is number => typeof id === "number"))];
  feedbackTabs.clear();

  for (const tabId of tabIds) {
    feedbackSeen.delete(tabId);

    try {
      await ensureCursor(tabId);
      await callDom(tabId, () => { (window.__sideagent?.cursor as {hideFeedback?: () => void} | undefined)?.hideFeedback?.(); }, []);
    } catch {  }
  }
}
