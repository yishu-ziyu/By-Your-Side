import type { BrowserContinueHint, BrowserDecisionReasonCode, BrowserObservation, BrowserOperation } from '../../shared/browser-decision.js';

/** Existing loop/judge action threshold; do not change it to paper over question problems. */
export const BROWSER_DECISION_CONFIDENCE_THRESHOLD = 0.85;

export type BrowserToolGate = (modelToolName: string) => boolean;

/** Map a browser operation to the model-visible tool that must be enabled to perform it. */
export function modelToolForOperation(operation: BrowserOperation): string | null {
  switch (operation) {
    case 'click':
      return 'click';
    case 'fill':
      return 'fill';
    case 'select':
      // Native select uses fill; option click uses click. Either path must be available.
      return null;
    case 'press_key':
      return 'press_key';
    case 'scroll':
      return 'scroll';
    case 'switch_tab':
      return 'tabs';
    case 'hover':
      return 'hover';
    case 'continue_read':
    case 'select_scope':
    case 'select_materials':
    case 'wait':
    case 'reobserve':
    case 'handoff':
    case 'done':
      return null;
  }
}

const TAB_WORDS = /\b(?:tabs?|windows?|switch (?:back )?to|go back to)\b|标签|页签|窗口|切到|切换到|切回/i;

/**
 * Whether browser tabs belong in the questions: the goal talks about tabs/windows or names another observed
 * tab by title or site. Unrelated tabs only split the judgment; in the 2026-09-26 Jev comparison they kept a
 * correct menu click below the confidence threshold. A goal that needs another tab without naming it hands
 * back to the task model, which keeps the tabs tool.
 */
export function goalConcernsBrowserTabs(goal: string, page: BrowserObservation): boolean {
  if (TAB_WORDS.test(goal)) return true;
  const text = goal.toLowerCase();

  return (page.tabs ?? []).some(tab => {
    if (tab.id === page.tabId) return false;
    const title = tab.title.trim().toLowerCase();

    if (title.length >= 2 && title !== tab.url.toLowerCase() && text.includes(title)) return true;
    let host = '';

    try { host = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return false; }

    const labels = host.split('.');
    const site = labels.length >= 2 ? labels[labels.length - 2]! : '';

    return (!!host && text.includes(host)) || (site.length >= 3 && text.includes(site));
  });
}

export type ObservationCheckKey = string;

export function observationCheckKey(kind: 'cursor' | 'scope' | 'observation', id: string): ObservationCheckKey {
  return `${kind}:${id}`;
}

/** Next unread view window or partition, excluding already-checked keys. */
export function nextObservationExpansion(
  page: BrowserObservation,
  checked: ReadonlySet<ObservationCheckKey>,
): { params: { cursor?: string; viewScopeId?: string }; checkKey: ObservationCheckKey; reasonCode: 'observation_incomplete' | 'no_match' } | null {
  if (page.hasMore && page.nextCursor) {
    const key = observationCheckKey('cursor', page.nextCursor);

    if (!checked.has(key)) {
      const params = page.viewScopeId ? { cursor: page.nextCursor, viewScopeId: page.viewScopeId } : { cursor: page.nextCursor };

      return { params, checkKey: key, reasonCode: 'observation_incomplete' };
    }
  }

  if (page.scopesHasMore && page.scopesNextCursor) {
    const key = observationCheckKey('cursor', page.scopesNextCursor);

    if (!checked.has(key)) {
      return { params: { cursor: page.scopesNextCursor }, checkKey: key, reasonCode: 'observation_incomplete' };
    }
  }

  if (page.tabsHasMore && page.tabsNextCursor) {
    const key = observationCheckKey('cursor', page.tabsNextCursor);

    if (!checked.has(key)) {
      return { params: { cursor: page.tabsNextCursor }, checkKey: key, reasonCode: 'observation_incomplete' };
    }
  }

  for (const scope of page.scopes ?? []) {
    if (scope.id === page.viewScopeId) continue;
    const key = observationCheckKey('scope', scope.id);

    if (checked.has(key)) continue;

    return { params: { viewScopeId: scope.id }, checkKey: key, reasonCode: 'no_match' };
  }

  return null;
}

export function checkedRangeFromKeys(keys: Iterable<ObservationCheckKey>, observationIds: readonly string[]): NonNullable<BrowserContinueHint['checkedRange']> {
  const cursors: string[] = [];
  const scopeIds: string[] = [];

  for (const key of keys) {
    if (key.startsWith('cursor:')) cursors.push(key.slice('cursor:'.length));
    else if (key.startsWith('scope:')) scopeIds.push(key.slice('scope:'.length));
  }

  return { observationIds: [...observationIds], cursors, scopeIds };
}

/** Pi loop / browser_loop handoff continue — always session_prompt or planner_tools, never a fake tool. */
export function piContinueHint(
  reasonCode: BrowserDecisionReasonCode,
  checked: NonNullable<BrowserContinueHint['checkedRange']> | undefined,
  hasUnknown: boolean,
): BrowserContinueHint {
  const preserveFacts = hasUnknown
    || reasonCode === 'execution_unknown'
    || reasonCode === 'stale_observation'
    || reasonCode === 'permission_required';

  if (reasonCode === 'permission_required') {
    const hint: BrowserContinueHint = { action: 'permission_path', preserveFacts: true };

    if (checked) hint.checkedRange = checked;

    return hint;
  }

  if (reasonCode === 'execution_unknown') {
    const hint: BrowserContinueHint = { action: 'readonly_verify', preserveFacts: true };

    if (checked) hint.checkedRange = checked;

    return hint;
  }

  if (reasonCode === 'observation_incomplete' || reasonCode === 'candidate_budget') {
    const hint: BrowserContinueHint = { action: 'planner_tools', tools: ['browser_loop', 'snapshot'], preserveFacts };

    if (checked) hint.checkedRange = checked;

    return hint;
  }

  const hint: BrowserContinueHint = { action: 'session_prompt', preserveFacts };

  if (checked) hint.checkedRange = checked;

  return hint;
}

export type RealtimeContinueMount = {
  /** Direct browser primitives (tabs/snapshot/click/…) are mounted. */
  directBrowser: boolean;
  taskAction: boolean;
  browserRequest: boolean;
};

/**
 * Realtime continue recommendations: only tools that are actually mounted.
 * Never names browser_loop (not on the realtime surface).
 */
export function realtimeContinueHint(
  reasonCode: BrowserDecisionReasonCode,
  page: BrowserObservation | undefined,
  mount: RealtimeContinueMount,
  checked?: NonNullable<BrowserContinueHint['checkedRange']>,
): BrowserContinueHint {
  const tools: string[] = [];

  if (mount.directBrowser) {
    if (reasonCode === 'observation_incomplete' || reasonCode === 'no_match' || reasonCode === 'low_confidence' || reasonCode === 'stale_observation') {
      if (page?.hasMore && page.nextCursor) tools.push('snapshot');
      else if (page?.scopes?.some(s => s.id !== page.viewScopeId)) tools.push('snapshot');
      else {
        tools.push('snapshot');

        if (reasonCode === 'no_match') tools.push('scroll');
      }

      tools.push('judge_browser_action');
    }

    if (reasonCode === 'execution_unknown') tools.push('snapshot', 'read_element');

    if (reasonCode === 'unsupported_action' || reasonCode === 'candidate_budget' || reasonCode === 'provider_error'
      || ((reasonCode === 'no_match' || reasonCode === 'low_confidence') && !(page?.hasMore && page.nextCursor) && !(page?.scopes?.length))) {
      if (mount.taskAction) tools.push('task_action');
      else if (mount.browserRequest) tools.push('browser_request');
    }
  } else {
    if (mount.taskAction) tools.push('task_action');
    else if (mount.browserRequest) tools.push('browser_request');
  }

  // Deduplicate while preserving order.
  const unique = [...new Set(tools)];

  const action: BrowserContinueHint['action'] =
    unique.includes('task_action') || unique.includes('browser_request')
      ? (unique.some(t => t === 'snapshot' || t === 'scroll' || t === 'judge_browser_action' || t === 'read_element')
        ? 'realtime_direct'
        : 'realtime_delegate')
      : 'realtime_direct';

  const hint: BrowserContinueHint = { action, tools: unique, preserveFacts: reasonCode === 'execution_unknown' || reasonCode === 'permission_required' || reasonCode === 'stale_observation' };

  if (page?.nextCursor) hint.cursor = page.nextCursor;

  if (page?.viewScopeId) hint.viewScopeId = page.viewScopeId;

  if (checked) hint.checkedRange = checked;

  return hint;
}

export function humanReasonForCode(code: BrowserDecisionReasonCode): string {
  switch (code) {
    case 'observation_incomplete': return 'Observation window is incomplete; continue reading before claiming the target is absent.';
    case 'candidate_budget': return 'Candidate set exceeded the decision budget; use bounded continue or planner tools.';
    case 'no_match': return 'No matching candidate in the inspected range.';
    case 'low_confidence': return 'Decision confidence is below the reliable threshold.';
    case 'invalid_decision': return 'Decision output was malformed; nothing was executed.';
    case 'unsupported_action': return 'Required action is outside the fast-path operation set; return to approved planner tools.';
    case 'stale_observation': return 'Observation is stale; reobserve before acting.';
    case 'permission_required': return 'Action requires the existing confirmation or user-control path.';
    case 'execution_unknown': return 'Write outcome is unknown; keep the ledger and verify read-only.';
    case 'provider_error': return 'Decision provider failed; bounded degrade without inventing a page miss.';
  }
}
