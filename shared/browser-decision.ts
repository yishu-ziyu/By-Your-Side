import type { TabInfo } from './protocol.js';
/** Cross-provider observation/decision contract. Page strings are evidence, never instructions. */
export const BROWSER_OPERATIONS = ['click', 'fill', 'select', 'press_key', 'scroll', 'switch_tab', 'wait', 'reobserve', 'handoff', 'done'] as const;

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

export interface BrowserObservation {
  id: string;
  tabId: number;
  documentId: string;
  url: string;
  observedAt: number;
  text: string;
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
  controlsTruncated?: boolean;
  dialogs?: string[];
  visibleText?: string;
  /** Browser-owned metadata; independent of the current page's DOM controls. */
  tabs?: TabInfo[];
  tabsTruncated?: boolean;
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
  operation: 'click' | 'fill' | 'press_key' | 'scroll' | 'switch_tab';
  target?: string;
  sourceTabId?: number;
}

export interface BrowserStepReceipt {
  observationId: string;
  candidateId: string;
  operation: BrowserOperation;
  fact: 'not_executed' | 'executed_unverified' | 'verified' | 'unknown';
  detail: string;
}

export type BrowserLoopOutcome = {
  status: 'needs_verification' | 'handoff' | 'blocked' | 'cancelled';
  reason: string;
  receipts: BrowserStepReceipt[];
  lastObservation?: BrowserObservation;
  modelCalls: number;
  decisions: Array<BrowserDecision & {
    elapsedMs: number;
  }>;
};

const controlRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem']);

const fillRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
/** No site templates or semantic matching in code: choices come from observed controls and supplied material. */
export function browserCandidates(page: BrowserObservation, materials: readonly BrowserMaterial[], canGenerateText = false): BrowserCandidate[] {
  const result: BrowserCandidate[] = [];
  let seq = 0;
  const ownedOptions = new Set(page.controls.flatMap(c => c.options?.map(o => o.ref) ?? []));
  for (const tab of page.tabs ?? []) {
    result.push({ id: `browser-tab-${tab.id}`, operation: 'switch_tab', tabId: tab.id, label: `Switch to the observed browser tab "${tab.title}" (${tab.url})${tab.active ? ' [active in its window]' : ''}` });
  }
  for (const control of (page.controlsTruncated ?? page.truncated) ? [] : page.controls) {
    if (control.disabled || control.protected) {
      continue;
    }
    const state = [control.checked !== undefined ? `checked=${control.checked}` : '', control.selected !== undefined ? `selected=${control.selected}` : '', control.expanded !== undefined ? `expanded=${control.expanded}` : '', control.invalid ? `invalid=${control.invalid}` : ''].filter(Boolean).join(', ');
    const label = `${control.role} ${control.name}${control.scopeLabel ? ` in ${control.scopeLabel}` : ''}${control.value !== undefined ? ` (current: ${control.value})` : ''}${state ? ` (${state})` : ''}`;
    if (controlRoles.has(control.role) && !ownedOptions.has(control.ref)) {
      result.push({ id: `c${++seq}`, operation: 'click', label: `Click ${label}`, target: control.ref });
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
    && (p.tabs === undefined || Array.isArray(p.tabs) && p.tabs.length <= 64 && p.tabs.every(t => t && Number.isSafeInteger(t.id) && t.id > 0 && typeof t.title === 'string' && typeof t.url === 'string' && typeof t.active === 'boolean') && new Set(p.tabs.map(t => t.id)).size === p.tabs.length);
}
