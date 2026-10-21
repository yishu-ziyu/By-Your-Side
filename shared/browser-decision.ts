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

export interface BrowserActionGuard {
  observationId: string;
  operation: 'click' | 'fill' | 'press_key' | 'scroll' | 'switch_tab' | 'hover';
  target?: string;
  sourceTabId?: number;
}

/**
 * 会生成 click/hover 候选的角色。
 * `generic` 只在观测层已按「可聚焦 + 有可读名字」筛过之后才会出现在 controls 里
 * （见 extension/src/background/browser-observation.ts 的 focusableGeneric），
 * 那是 role-less 悬停菜单触发器（<div tabindex=0>账号</div>）唯一能被看见的方式。
 * 不填 fillRoles：generic 不是文本字段，不能往里填材料。
 */
const controlRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'generic']);

/**
 * 允许执行 click/hover 的角色 = 候选角色 ∪ {combobox}。
 * combobox 不在 controlRoles 里（它走「打开选项」那条独立分支），但同样应可点。
 * 守卫侧必须与这里同源，否则会出现「候选给了、执行被守卫拒」的分叉——
 * 历史上 generic 触发器的 hover 就是这样被挡死的。
 */
export const clickableRoles = new Set([...controlRoles, 'combobox']);

