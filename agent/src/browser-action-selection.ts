import {
  browserCandidates,
  type BrowserCandidate,
  type BrowserContinueHint,
  type BrowserDecision,
  type BrowserDecisionReasonCode,
  type BrowserMaterial,
  type BrowserObservation,
  type BrowserOperation,
} from '../../shared/browser-decision.js';

/** Existing loop/judge threshold; do not change to paper over candidate problems. */
export const BROWSER_DECISION_CONFIDENCE_THRESHOLD = 0.85;

export const BROWSER_DECISION_CANDIDATE_LIMIT = 256;

export const BROWSER_DECISION_PAYLOAD_BYTES = 64000;

/** Prefer this many materials per bounded fill window before falling back to handoff. */
const MATERIAL_WINDOW_SIZE = 3;

export type BrowserToolGate = (modelToolName: string) => boolean;

export interface BrowserActionSelectionInput {
  goal: string;
  page: BrowserObservation;
  /** Full host materials; originals are never truncated here. */
  materials: readonly BrowserMaterial[];
  history: readonly string[];
  canGenerateText?: boolean;
  /**
   * Whether the caller may use a model-visible tool now.
   * Pass canExecute / isToolActive results — not "hidden by mode".
   * Missing gate = no extra filter (caller still re-checks at execution).
   */
  canExecute?: BrowserToolGate;
  /** When set, only these material ids participate in fill candidates this request. */
  focusedMaterialIds?: readonly string[];
  /**
   * Observation ranges (cursors / partitions) the caller already inspected. Already-read windows are
   * not offered again: re-offering them is the no-progress retry SEL-03 forbids.
   */
  checkedRanges?: ReadonlySet<ObservationCheckKey>;
  /** Material windows already inspected by the caller. */
  checkedMaterialWindows?: ReadonlySet<string>;
  /**
   * True while the caller is searching material windows itself. Then the still-unread windows stay
   * selectable; a window the model already chose is answered with that window's field actions only.
   */
  materialWindowSearch?: boolean;
  /**
   * True while the caller is still resolving this task's action: control/partition windows of the
   * observed page or material windows are still being read, or a bounded material window is focused.
   * Reading those ranges comes before switching browser tabs, so an in-progress search must not turn
   * the operation choice into a guess between "act here" and "look in another tab". Tab switching is
   * offered again as soon as no search is in progress; a caller that cannot continue hands back.
   */
  searchInProgress?: boolean;
}

export interface BrowserActionSelection {
  candidates: BrowserCandidate[];
  /** Materials included in this Jev request body (may be a focused window). */
  decisionMaterials: BrowserMaterial[];
  /** True when this request offers partition/material windows instead of the full cartesian fill set. */
  bounded: boolean;
}

/** Map a decision operation to the model-visible tool that must be enabled to suggest it. */
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

function selectAllowed(canExecute?: BrowserToolGate): boolean {
  if (!canExecute) return true;

  return canExecute('fill') || canExecute('click');
}

export function filterExecutableCandidates(
  candidates: readonly BrowserCandidate[],
  canExecute?: BrowserToolGate,
): BrowserCandidate[] {
  if (!canExecute) return [...candidates];

  return candidates.filter(candidate => {
    if (candidate.operation === 'select') return selectAllowed(canExecute);
    const tool = modelToolForOperation(candidate.operation);

    return tool === null || canExecute(tool);
  });
}

/** Host continue-read / partition candidates derived from observation coverage fields. */
export function viewNavigationCandidates(page: BrowserObservation): BrowserCandidate[] {
  const result: BrowserCandidate[] = [];

  if (page.hasMore && page.nextCursor) {
    result.push({
      id: 'continue-controls',
      operation: 'continue_read',
      label: `Continue reading the next control window (currently ${page.visibleCount ?? page.controls.length} of ${page.collectedCount ?? page.controls.length} collected). This does not activate a control.`,
      cursor: page.nextCursor,
      ...(page.viewScopeId ? { viewScopeId: page.viewScopeId } : {}),
    });
  }

  if (page.scopesHasMore && page.scopesNextCursor) {
    result.push({
      id: 'continue-scopes',
      operation: 'continue_read',
      label: 'Continue reading more partition summaries for this page. This does not activate a control.',
      cursor: page.scopesNextCursor,
    });
  }

  if (page.tabsHasMore && page.tabsNextCursor) {
    result.push({
      id: 'continue-tabs',
      operation: 'continue_read',
      label: 'Continue reading more observed browser tabs. This does not activate a control.',
      cursor: page.tabsNextCursor,
    });
  }

  for (const scope of page.scopes ?? []) {
    if (scope.id === page.viewScopeId) continue;
    result.push({
      id: `scope-${scope.id}`,
      operation: 'select_scope',
      label: `Open partition "${scope.label}" (${scope.count} controls${scope.complete ? '' : ', incomplete'}). Then choose an action inside that window.`,
      viewScopeId: scope.id,
    });
  }

  return result;
}

function materialWindowCandidates(materials: readonly BrowserMaterial[]): BrowserCandidate[] {
  if (materials.length <= MATERIAL_WINDOW_SIZE) return [];
  const result: BrowserCandidate[] = [];

  for (let offset = 0; offset < materials.length; offset += MATERIAL_WINDOW_SIZE) {
    const slice = materials.slice(offset, offset + MATERIAL_WINDOW_SIZE);
    const ids = slice.map(m => m.id);
    result.push({
      id: `materials-${ids.join('+')}`,
      operation: 'select_materials',
      label: `Focus supplied materials ${ids.map(id => {
        const m = slice.find(item => item.id === id)!;

        return `${id} (${m.purpose}; ${m.value.length} chars; source=${m.source})`;
      }).join('; ')} for the next fill decision. Host keeps full original values; do not treat this summary as fill text.`,
      materialIds: ids,
    });
  }

  return result;
}

export function materialWindowKey(ids: readonly string[]): string {
  return `materials:${ids.join('+')}`;
}

/** Bounded material windows in supplied order; host still owns the full original values. */
export function materialWindows(materials: readonly BrowserMaterial[], size = MATERIAL_WINDOW_SIZE): string[][] {
  if (materials.length <= size) return [];
  const windows: string[][] = [];

  for (let offset = 0; offset < materials.length; offset += size) {
    windows.push(materials.slice(offset, offset + size).map(m => m.id));
  }

  return windows;
}

/** Next material window the caller has not inspected yet, in supplied order. */
export function nextMaterialWindow(
  materials: readonly BrowserMaterial[],
  checked: ReadonlySet<string>,
  size = MATERIAL_WINDOW_SIZE,
): string[] | undefined {
  return materialWindows(materials, size).find(ids => !checked.has(materialWindowKey(ids)));
}

/**
 * Order only decides which alternatives the model weighs first; it never deletes a partition,
 * a capability or a range. Page actions the observation supports come before browser-level
 * navigation and administrative stops, so an actionable target is not weighed behind "switch tab".
 */
const ACTION_ORDER: readonly BrowserOperation[] = [
  'click', 'fill', 'select', 'press_key', 'hover', 'scroll',
  'continue_read', 'select_scope', 'select_materials',
  'reobserve', 'wait', 'switch_tab', 'handoff', 'done',
];

export function orderActionCandidates(candidates: readonly BrowserCandidate[]): BrowserCandidate[] {
  const rank = (candidate: BrowserCandidate) => {
    const index = ACTION_ORDER.indexOf(candidate.operation);

    return index < 0 ? ACTION_ORDER.length : index;
  };

  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
    .map(entry => entry.candidate);
}

/** Mirror decideBrowserCandidate serialization for budget checks; unused branches stay speculative. */
export function estimateDecisionPayloadBytes(input: {
  goal: string;
  page: BrowserObservation;
  candidates: readonly BrowserCandidate[];
  materials: readonly BrowserMaterial[];
  history: readonly string[];
}): number {
  const groups: Record<string, BrowserCandidate[]> = {};

  for (const candidate of input.candidates) {
    (groups[candidate.operation] ??= []).push(candidate);
  }

  const questions: Record<string, unknown> = {
    operation: {
      type: 'choice',
      instructions: 'Choose the next operation',
      criteria: Object.fromEntries(Object.keys(groups).map(k => [k, k])),
    },
  };

  for (const [operation, members] of Object.entries(groups)) {
    if (members.length > 1) {
      questions[`${operation}_target`] = {
        type: 'choice',
        instructions: `Assuming ${operation}`,
        criteria: { ...Object.fromEntries(members.map(c => [c.id, c.label])), none: 'none' },
      };
    }
  }

  return Buffer.byteLength(JSON.stringify({
    model: 'jev-1.13.0',
    state: {
      goal: input.goal,
      page: {
        url: input.page.url,
        text: input.page.text,
        visibleText: input.page.visibleText,
        textScope: 'accessibility_excerpt_and_separate_viewport',
        controls: input.page.controls,
        textTruncated: input.page.textTruncated ?? input.page.truncated,
        controlsTruncated: input.page.controlsTruncated ?? input.page.truncated,
      },
      browserTabs: input.page.tabs,
      browserTabsTruncated: input.page.tabsTruncated,
      materials: input.materials,
      history: input.history.slice(-8),
    },
    questions,
  }));
}

function fitsBudget(
  goal: string,
  page: BrowserObservation,
  candidates: readonly BrowserCandidate[],
  materials: readonly BrowserMaterial[],
  history: readonly string[],
): boolean {
  if (candidates.length > BROWSER_DECISION_CANDIDATE_LIMIT) return false;

  return estimateDecisionPayloadBytes({ goal, page, candidates, materials, history }) <= BROWSER_DECISION_PAYLOAD_BYTES;
}

function metaOnly(page: BrowserObservation, materials: readonly BrowserMaterial[]): BrowserCandidate[] {
  const base = browserCandidates(page, [], false).filter(c =>
    c.operation === 'scroll' || c.operation === 'wait' || c.operation === 'reobserve'
    || c.operation === 'handoff' || c.operation === 'done' || c.operation === 'switch_tab');

  return [...viewNavigationCandidates(page), ...materialWindowCandidates(materials), ...base];
}

/**
 * Shared bounded selection for browser_loop and realtime judge.
 * Does not execute actions, does not own task state, and is not a mandatory router for every tool call.
 */
export function selectBrowserActionCandidates(input: BrowserActionSelectionInput): BrowserActionSelection {
  const focused = input.focusedMaterialIds?.length
    ? input.materials.filter(m => input.focusedMaterialIds!.includes(m.id))
    : [...input.materials];

  /** A window the caller (or the model) already chose: answering it must not re-offer other windows. */
  const windowed = !!input.focusedMaterialIds?.length;
  /**
   * While the caller walks material windows it owns the stop decision: unread windows must be read
   * before handing back (SEL-03), so a half-read material set must not become a confident handoff.
   * The model still rejects every target in this request with `none`.
   */
  const searchOwnsStop = input.materialWindowSearch === true;

  const usable = (candidates: readonly BrowserCandidate[]): BrowserCandidate[] => {
    const ranges = input.checkedRanges;
    const materialWindowsChecked = input.checkedMaterialWindows;

    return candidates.filter(candidate => {
      // "Switch" to the tab this observation was taken from cannot change anything.
      if (candidate.operation === 'switch_tab' && candidate.tabId === input.page.tabId) return false;

      // Finish the in-progress search before offering to leave the observed page.
      if (candidate.operation === 'switch_tab' && input.searchInProgress === true) return false;

      if (searchOwnsStop && candidate.operation === 'handoff') return false;

      if (ranges && candidate.operation === 'continue_read' && candidate.cursor) {
        if (ranges.has(observationCheckKey('cursor', candidate.cursor))) return false;
      }

      if (ranges && candidate.operation === 'select_scope' && candidate.viewScopeId) {
        if (ranges.has(observationCheckKey('scope', candidate.viewScopeId))) return false;
      }

      if (materialWindowsChecked && candidate.operation === 'select_materials' && candidate.materialIds) {
        if (materialWindowsChecked.has(materialWindowKey(candidate.materialIds))) return false;
      }

      return true;
    });
  };

  // `usable` drops windows the caller already read, so a chosen window is never re-offered.
  const offerableWindows = materialWindowCandidates(input.materials);
  const viewNavigation = viewNavigationCandidates(input.page);

  // Full fan-out: one request keeps operation plus every target question for the current view.
  const withFills = usable(filterExecutableCandidates(
    [...browserCandidates(input.page, focused, !!input.canGenerateText), ...viewNavigation],
    input.canExecute,
  ));

  if (!windowed && fitsBudget(input.goal, input.page, withFills, focused, input.history)) {
    return { candidates: orderActionCandidates(withFills), decisionMaterials: focused, bounded: false };
  }

  // Over budget. A focused material window keeps that window's field actions, so the one
  // field+material pair the goal needs is still nameable; the host resolves the full original value,
  // never a summary. While the caller walks windows itself, the unread ones stay selectable so the
  // model can name one instead of handing off; a window the model chose is answered on its own.
  const searchableWindows = input.materialWindowSearch === true
    ? offerableWindows
    : [];

  const windowedSet = usable(filterExecutableCandidates(
    [
      ...browserCandidates(input.page, focused, !!input.canGenerateText),
      ...viewNavigation,
      ...searchableWindows,
    ],
    input.canExecute,
  ));

  if (windowed && fitsBudget(input.goal, input.page, windowedSet, focused, input.history)) {
    return { candidates: orderActionCandidates(windowedSet), decisionMaterials: focused, bounded: true };
  }

  // No material window (or it still does not fit): drop the field×material fan-out, keep direct actions
  // that do not explode, continue-read and material windows. Supplied materials stay visible in state.
  const withoutMaterialFills = usable(filterExecutableCandidates(
    [
      ...browserCandidates(input.page, [], !!input.canGenerateText),
      ...viewNavigation,
      ...offerableWindows,
    ],
    input.canExecute,
  ));

  if (fitsBudget(input.goal, input.page, withoutMaterialFills, input.materials, input.history)) {
    return { candidates: orderActionCandidates(withoutMaterialFills), decisionMaterials: [...input.materials], bounded: true };
  }

  // Still over (long labels / huge page text): drop generate-text fills and click/hover noise; keep navigation + handoff.
  let fallback = usable(filterExecutableCandidates(metaOnly(input.page, input.materials), input.canExecute));

  if (!fitsBudget(input.goal, input.page, fallback, input.materials, input.history)) {
    // Huge accessibility text often blows the byte budget before material windows can be offered.
    const slimPage = {
      ...input.page,
      text: '',
      visibleText: '',
      controls: input.page.controls.slice(0, 40),
    };

    fallback = usable(filterExecutableCandidates(metaOnly(slimPage, input.materials), input.canExecute));

    if (!fitsBudget(input.goal, slimPage, fallback, input.materials, input.history)) {
      // Last resort: handoff only so the caller returns to planning without throwing.
      fallback = [{ id: 'handoff', operation: 'handoff', label: 'Required target, material, capability or reasoning is missing; return to task planner' }];
    }
  }

  return { candidates: orderActionCandidates(fallback), decisionMaterials: [...input.materials], bounded: true };
}

export function isReliableDecisionConfidence(confidence: number): boolean {
  return Number.isFinite(confidence)
    && confidence >= BROWSER_DECISION_CONFIDENCE_THRESHOLD
    && confidence <= 1;
}

export type BrowserDecisionVerdict =
  | { kind: 'execute'; candidate: BrowserCandidate }
  | { kind: 'reject'; reasonCode: BrowserDecisionReasonCode; reason: string };

/**
 * Classify a Jev decision for control flow. Branches on candidateId/confidence/observationId only —
 * never on Chinese reason strings. `none` is no_match; illegal IDs / NaN never execute.
 */
export function resolveBrowserDecision(
  decision: BrowserDecision,
  candidates: readonly BrowserCandidate[],
  pageId: string,
): BrowserDecisionVerdict {
  if (decision.observationId !== pageId) {
    return { kind: 'reject', reasonCode: 'stale_observation', reason: 'Decision belongs to a stale observation; not executed.' };
  }

  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    return { kind: 'reject', reasonCode: 'invalid_decision', reason: 'Decision confidence is not a finite probability; not executed.' };
  }

  if (decision.candidateId === 'none') {
    return { kind: 'reject', reasonCode: 'no_match', reason: 'No supported target matches current candidates; not executed.' };
  }

  const candidate = candidates.find(c => c.id === decision.candidateId);

  if (!candidate) {
    return { kind: 'reject', reasonCode: 'invalid_decision', reason: 'Decision named an unknown candidate id; not executed.' };
  }

  if (!isReliableDecisionConfidence(decision.confidence)) {
    return { kind: 'reject', reasonCode: 'low_confidence', reason: 'Decision confidence is below the reliable threshold; not executed.' };
  }

  return { kind: 'execute', candidate };
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
      return {
        params: { cursor: page.nextCursor, ...(page.viewScopeId ? { viewScopeId: page.viewScopeId } : {}) },
        checkKey: key,
        reasonCode: 'observation_incomplete',
      };
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
    return { action: 'permission_path', preserveFacts: true, ...(checked ? { checkedRange: checked } : {}) };
  }

  if (reasonCode === 'execution_unknown') {
    return { action: 'readonly_verify', preserveFacts: true, ...(checked ? { checkedRange: checked } : {}) };
  }

  if (reasonCode === 'observation_incomplete' || reasonCode === 'candidate_budget') {
    return { action: 'planner_tools', tools: ['browser_loop', 'snapshot'], preserveFacts, ...(checked ? { checkedRange: checked } : {}) };
  }

  return { action: 'session_prompt', preserveFacts, ...(checked ? { checkedRange: checked } : {}) };
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

  return {
    action,
    tools: unique,
    preserveFacts: reasonCode === 'execution_unknown' || reasonCode === 'permission_required' || reasonCode === 'stale_observation',
    ...(page?.nextCursor ? { cursor: page.nextCursor } : {}),
    ...(page?.viewScopeId ? { viewScopeId: page.viewScopeId } : {}),
    ...(checked ? { checkedRange: checked } : {}),
  };
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
