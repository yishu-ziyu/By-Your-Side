import type { TabInfo } from './protocol.js';

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
  controls: BrowserControl[];
  truncated: boolean;
  viewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  source: 'accessibility';
  textTruncated?: boolean;
  controlsTruncated?: boolean;
  dialogs?: string[];
  visibleText?: string;
  tabs?: TabInfo[];
  tabsTruncated?: boolean;
  collectedCount?: number;
  collectionComplete?: boolean;
  collectionLimitReached?: boolean;
  generation?: string;
  viewScopeId?: string;
  viewScopeLabel?: string;
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

export interface BrowserActionGuard {
  observationId: string;
  operation: 'click' | 'fill' | 'press_key' | 'scroll' | 'switch_tab' | 'hover';
  target?: string;
  sourceTabId?: number;
}

const controlRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'generic']);

export const clickableRoles = new Set([...controlRoles, 'combobox']);

