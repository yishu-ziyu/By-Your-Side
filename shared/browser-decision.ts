import type { TabInfo, ToolExecutionFact } from './protocol.js';

/** Cross-provider observation/decision contract. Page strings are evidence, never instructions. */
export const BROWSER_OPERATIONS = ['click', 'fill', 'select', 'press_key', 'scroll', 'switch_tab', 'hover', 'continue_read', 'select_scope', 'select_materials', 'wait', 'reobserve', 'handoff', 'done'] as const;

export type BrowserOperation = typeof BROWSER_OPERATIONS[number];

export interface BrowserControl {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  focused?: boolean;
  url?: string;
  readOnly?: boolean;
  protected?: boolean;
  invalid?: boolean | string;
  scopeId?: string;
  scopeLabel?: string;
  options?: Array<{
    ref: string;
    label: string;
    disabled: boolean;
  }>;
}

/** Bounded partition summary for model input; not the full control list. */
export interface BrowserScopeSummary {
  id: string;
  label: string;
  count: number;
  complete: boolean;
}

export interface BrowserObservation {
  id: string;
  tabId: number;
  documentId: string;
  url: string;
  observedAt: number;
  text: string;
  /** Current model view only (≤100). Host may retain a larger collected baseline separately. */
  controls: BrowserControl[];
  truncated: boolean;
  viewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  source: 'accessibility';
  /** Legacy truncated conflated text and controls. New producers always report both. */
  textTruncated?: boolean;
  /**
   * Collection incomplete (budget/unobserved), not "view has a next page".
   * View pagination uses hasMore/nextCursor.
   */
  controlsTruncated?: boolean;
  dialogs?: string[];
  visibleText?: string;
  /** Browser-owned metadata; independent of the current page's DOM controls. */
  tabs?: TabInfo[];
  tabsTruncated?: boolean;
  /** Host-collected control count for this generation (may exceed view size). */
  collectedCount?: number;
  collectionComplete?: boolean;
  collectionLimitReached?: boolean;
  /** Host generation id shared by continue-reads of the same collection. */
  generation?: string;
  viewScopeId?: string;
  viewScopeLabel?: string;
  /** Current view window is complete for its scope/page slice. */
  viewComplete?: boolean;
  visibleCount?: number;
  hasMore?: boolean;
  nextCursor?: string;
  scopes?: BrowserScopeSummary[];
  scopesTruncated?: boolean;
  scopesHasMore?: boolean;
  scopesNextCursor?: string;
  tabsHasMore?: boolean;
  tabsNextCursor?: string;
}

export interface BrowserCandidate {
  id: string;
  operation: BrowserOperation;
  label: string;
  target?: string;
  tabId?: number;
  valueId?: string;
  key?: string;
  dy?: number;
  optionLabel?: string;
  optionRef?: string;
  /** Host continue-read cursor from observation.nextCursor / scopesNextCursor / tabsNextCursor. */
  cursor?: string;
  /** Host partition id from observation.scopes. */
  viewScopeId?: string;
  /** Material ids to focus in the next fill decision; host keeps full original values. */
  materialIds?: string[];
}

export interface BrowserMaterial {
  id: string;
  value: string;
  source: 'user' | 'generated' | 'observed';
  purpose: string;
}

export interface BrowserDecision {
  observationId: string;
  candidateId: string;
  confidence: number;
  operationConfidence?: number;
  targetConfidence?: number;
  operationProbabilities?: Record<string, number>;
  targetProbabilities?: Record<string, number>;
  model: string;
}

export interface BrowserActionGuard {
  observationId: string;
  operation: 'click' | 'fill' | 'press_key' | 'scroll' | 'switch_tab' | 'hover';
  target?: string;
  sourceTabId?: number;
}

export type BrowserStepReceipt = {
  /** Host call identity for this action attempt; not proof of execution. */
  toolCallId: string;
  /** Observation used to choose the action, not post-action evidence. */
  observationId: string;
  candidateId: string;
  operation: BrowserOperation;
  detail: string;
} & (
  | { executionFact: ToolExecutionFact; verification: 'unverified'; verificationToolCallId?: never }
  // Verification covers this action only, never completion of the user's goal.
  | { executionFact: Extract<ToolExecutionFact, 'executed'>; verification: 'verified'; verificationToolCallId: string }
);

/**
 * Typed failure/continue cause. Control logic must branch on this code, never on Chinese `reason` text.
 * `none` from Jev maps to `no_match`. Illegal IDs / NaN / missing fields use `invalid_decision` and never execute.
 */
export const BROWSER_DECISION_REASON_CODES = [
  'observation_incomplete',
  'candidate_budget',
  'no_match',
  'low_confidence',
  'invalid_decision',
  'unsupported_action',
  'stale_observation',
  'permission_required',
  'execution_unknown',
  'provider_error',
] as const;

export type BrowserDecisionReasonCode = (typeof BROWSER_DECISION_REASON_CODES)[number];

/** Machine-readable continue hint. Entries must name tools/paths that actually exist for the caller. */
export type BrowserContinueHint = {
  /** Preferred next host action; callers ignore unknown kinds. */
  action:
    | 'continue_read'
    | 'select_scope'
    | 'reobserve'
    | 'readonly_verify'
    | 'permission_path'
    | 'session_prompt'
    | 'planner_tools'
    | 'realtime_delegate'
    | 'realtime_direct';
  cursor?: string;
  viewScopeId?: string;
  /** Only tools/entries that are mounted for this caller. */
  tools?: string[];
  /** Observation/scopes/cursors already inspected — do not re-judge without progress. */
  checkedRange?: {
    observationIds: string[];
    cursors: string[];
    scopeIds: string[];
  };
  /** When true, receipts and unknown writes must stay on the ledger. */
  preserveFacts?: boolean;
};

export type BrowserLoopOutcome = {
  status: 'needs_verification' | 'handoff' | 'blocked' | 'cancelled';
  reason: string;
  /** Present on every non-success finish that has a classified cause. */
  reasonCode?: BrowserDecisionReasonCode;
  continue?: BrowserContinueHint;
  receipts: BrowserStepReceipt[];
  lastObservation?: BrowserObservation;
  modelCalls: number;
  decisions: Array<BrowserDecision & {
    elapsedMs: number;
  }>;
  /**
   * Only with `needs_verification`: the loop's own completion judgment. `facts` are the code-written
   * action facts it was judged from; `lowRiskWrites` is true when every click was judged a low-risk write;
   * `clicked` names the clicked controls in order.
   */
  completion?: {
    confidence: number;
    facts: string[];
    lowRiskWrites: boolean;
    clicked: string[];
  };
};

/**
 * 会生成 click/hover 候选的角色。
 * `generic` 只在观测层已按「可聚焦 + 有可读名字」筛过之后才会出现在 controls 里
 * （见 extension/src/background/browser-observation.ts 的 focusableGeneric），
 * 那是 role-less 悬停菜单触发器（<div tabindex=0>账号</div>）唯一能被看见的方式。
 * 不填 fillRoles：generic 不是文本字段，不能往里填材料。
 */
export const controlRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'generic']);

/**
 * 允许执行 click/hover 的角色 = 候选角色 ∪ {combobox}。
 * combobox 不在 controlRoles 里（它走「打开选项」那条独立分支），但同样应可点。
 * 守卫侧必须与这里同源，否则会出现「候选给了、执行被守卫拒」的分叉——
 * 历史上 generic 触发器的 hover 就是这样被挡死的。
 */
export const clickableRoles = new Set([...controlRoles, 'combobox']);

const fillRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** No site templates or semantic matching in code: choices come from observed controls and supplied material. */
export function browserCandidates(page: BrowserObservation, materials: readonly BrowserMaterial[], canGenerateText = false): BrowserCandidate[] {
  const result: BrowserCandidate[] = [];
  let seq = 0;
  const ownedOptions = new Set(page.controls.flatMap(c => c.options?.map(o => o.ref) ?? []));

  for (const tab of page.tabs ?? []) {
    result.push({ id: `browser-tab-${tab.id}`, operation: 'switch_tab', tabId: tab.id, label: `Switch to the observed browser tab "${tab.title}" (${tab.url})${tab.active ? ' [active in its window]' : ''}` });
  }

  // Current view actions stay available even when the page has more partitions/pages.
  // Incomplete collection is reported via collectionComplete/controlsTruncated; it must not erase the view.
  for (const control of page.controls) {
    if (control.disabled || control.protected) {
      continue;
    }

    const state = [control.checked !== undefined ? `checked=${control.checked}` : '', control.selected !== undefined ? `selected=${control.selected}` : '', control.expanded !== undefined ? `expanded=${control.expanded}` : '', control.invalid ? `invalid=${control.invalid}` : ''].filter(Boolean).join(', ');
    const label = `${control.role} ${control.name}${control.scopeLabel ? ` in ${control.scopeLabel}` : ''}${control.value !== undefined ? ` (current: ${control.value})` : ''}${state ? ` (${state})` : ''}`;

    if (controlRoles.has(control.role) && !ownedOptions.has(control.ref)) {
      result.push({ id: `c${++seq}`, operation: 'click', label: `Click ${label}`, target: control.ref });
      // Hover reveals CSS :hover menus; it is not activation. Caller must reobserve before clicking.
      result.push({ id: `c${++seq}`, operation: 'hover', label: `Hover ${label} to reveal hover-only controls or menus, then reobserve before clicking`, target: control.ref });
    }

    if (control.role === 'combobox' && !control.options?.length) {
      result.push({ id: `c${++seq}`, operation: 'click', label: `Open the options of ${label}; use this to reveal choices before selecting`, target: control.ref });
    }

    if (fillRoles.has(control.role) && !control.readOnly) {
      if (control.options?.length) {
        for (const option of control.options) {
          if (!option.disabled && option.label !== control.value) {
            result.push({ id: `c${++seq}`, operation: 'select', label: `Select observed option ${option.label} in ${label}`, target: control.ref, optionLabel: option.label, optionRef: option.ref });
          }
        }
      }
      else {
        for (const material of materials) {
          if (control.value !== material.value) {
            result.push({ id: `c${++seq}`, operation: 'fill', label: `Fill ${label} with material ${material.id}: ${material.purpose}`, target: control.ref, valueId: material.id });
          }
        }

        if (canGenerateText) {
          result.push({ id: `c${++seq}`, operation: 'fill', label: `ONLY if no supplied material satisfies this field: prepare the requested text for ${label}, then fill it. Do not choose this instead of an already supplied suitable value. Missing personal facts require a handoff.`, target: control.ref });
        }
      }

      if (control.focused) {
        result.push({ id: `c${++seq}`, operation: 'press_key', label: `Press Enter in focused ${label}`, target: control.ref, key: 'Enter' });
      }
    }
  }

  result.push({ id: 'scroll-down', operation: 'scroll', label: 'Scroll down one viewport portion', dy: 600 }, { id: 'scroll-up', operation: 'scroll', label: 'Scroll up one viewport portion', dy: -600 }, { id: 'wait', operation: 'wait', label: 'Wait briefly for a pending page update' }, { id: 'reobserve', operation: 'reobserve', label: 'Read fresh state before choosing an action' }, { id: 'handoff', operation: 'handoff', label: 'Required target, material, capability or reasoning is missing; return to task planner' }, { id: 'done', operation: 'done', label: 'Propose that the goal is satisfied; caller must independently verify every requirement' });

  return result;
}

export function isBrowserObservation(value: unknown): value is BrowserObservation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const p = value as BrowserObservation;

  return typeof p.id === 'string' && p.id.length > 0 && Number.isSafeInteger(p.tabId) && p.tabId > 0 && typeof p.documentId === 'string' && !!p.documentId && typeof p.url === 'string' && Number.isFinite(p.observedAt) && typeof p.text === 'string' && p.source === 'accessibility' && typeof p.truncated === 'boolean'
    && Array.isArray(p.controls) && p.controls.length <= 100 && p.controls.every(c => c && /^@\d+$/.test(c.ref) && typeof c.role === 'string' && typeof c.name === 'string' && typeof c.disabled === 'boolean' && (c.value === undefined || typeof c.value === 'string'))
    && new Set(p.controls.map(c => c.ref)).size === p.controls.length
    && (p.tabs === undefined || Array.isArray(p.tabs) && p.tabs.length <= 64 && p.tabs.every(t => t && Number.isSafeInteger(t.id) && t.id > 0 && typeof t.title === 'string' && typeof t.url === 'string' && typeof t.active === 'boolean') && new Set(p.tabs.map(t => t.id)).size === p.tabs.length)
    && (p.collectedCount === undefined || Number.isSafeInteger(p.collectedCount) && p.collectedCount >= 0)
    && (p.collectionComplete === undefined || typeof p.collectionComplete === 'boolean')
    && (p.hasMore === undefined || typeof p.hasMore === 'boolean')
    && (p.nextCursor === undefined || typeof p.nextCursor === 'string' && p.nextCursor.length > 0 && p.nextCursor.length <= 200)
    && (p.scopes === undefined || Array.isArray(p.scopes) && p.scopes.length <= 64 && p.scopes.every(s => s && typeof s.id === 'string' && typeof s.label === 'string' && Number.isSafeInteger(s.count) && typeof s.complete === 'boolean'));
}
