import { clickableRoles, type BrowserObservation, type BrowserControl, type BrowserActionGuard } from '../../../shared/browser-decision.js';
import { browserContextChange } from '../../../shared/browser-decision-context.js';
import type { AxNodeLite } from './axtree.js';
import { sendCommand } from './debugger.js';
import { readCurrentDocument } from './exec/page-readiness.js';

const allowedRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * role-less 悬停触发器的准入判据。
 *
 * 页面作者常用 `<div tabindex=0>账号</div>` 这种写法做悬停菜单触发器：它没有 ARIA role，
 * Chrome 的 AX 树给的 role 是 `generic`，而它是页面上唯一能展开 CSS hover 菜单的东西。
 * 白名单只有语义角色，所以这类节点会被丢掉；丢了它，`browserCandidates()` 永远生成不出
 * hover 候选，任务书 §7 的 hover 接线就无从覆盖。
 *
 * 准入卡两个条件，缺一不可：
 *   1. `focusable=true`——页面作者显式把它做成了可键盘操作的对象（tabindex），这是交互意图的证据；
 *   2. 有可读名字——自身可访问名，或（generic 容器 Chrome 不做 name-from-contents）文本后代的拼接。
 *
 * 不收"不可聚焦"或"既无名也无文本"的 generic：否则每个 div 都会变成候选，
 * 直接撑爆 256 候选 / 64K 字节预算，反噬 SEL-01/02/03 的选择链。
 * 只收 generic 一个 role，不收 none/presentation：那两类是明确声明"无语义"的。
 */
function focusableGeneric(n: AxNodeLite, textName: (n: AxNodeLite) => string): boolean {
  if ((n.role?.value ?? '') !== 'generic') return false;
  const props = Object.fromEntries((n.properties ?? []).map(p => [p.name, p.value?.value]));

  if (props.focusable !== true && props.focusable !== 'true') return false;
  const own = (n.name?.value ?? '').trim();

  return own.length > 0 || textName(n).length > 0;
}

export function decisionControls(nodes: readonly AxNodeLite[], refs?: readonly number[]): BrowserControl[] {
  const keep = refs ? new Set(refs) : null;
  const result: BrowserControl[] = [];
  const seen = new Set<number>();
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const scopeRoles = new Set(['form', 'dialog', 'alertdialog', 'group', 'region', 'article', 'listitem', 'row', 'treeitem']);

  const ancestor = (node: AxNodeLite, predicate: (parent: AxNodeLite) => boolean): AxNodeLite | undefined => {
    let current = node.parentId ? byId.get(node.parentId) : undefined;
    const visited = new Set<string>();

    while (current && !visited.has(current.nodeId) && visited.size < 64) {
      visited.add(current.nodeId);

      if (predicate(current)) {
        return current;
      }

      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    return undefined;
  };

  const childrenOf = new Map<string, AxNodeLite[]>();

  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }

  /** Chrome 不为 generic 容器做 name-from-contents，名字散在子 StaticText 里；取文本后代拼接。 */
  const textName = (n: AxNodeLite): string => {
    const parts: string[] = [];
    const stack = [...(childrenOf.get(n.nodeId) ?? [])];
    const visited = new Set<string>([n.nodeId]);
    let guard = 0;

    while (stack.length > 0 && guard < 64) {
      guard += 1;
      const cur = stack.pop();

      if (!cur || visited.has(cur.nodeId)) continue;
      visited.add(cur.nodeId);
      const role = cur.role?.value ?? '';
      const t = (cur.name?.value ?? '').trim();

      if (role === 'StaticText' || role === 'text') {
        if (t) parts.push(t);
        continue;
      }

      for (const ch of childrenOf.get(cur.nodeId) ?? []) stack.push(ch);
    }

    return parts.join(' ').trim();
  };

  const effectiveName = (n: AxNodeLite): string => (n.name?.value ?? '').trim() || textName(n);
  /** 预设每轮只算一次：两个遍历循环（descendants 计数 + 主循环）必须用同一套准入结果。 */
  const admitted = new Set<string>();

  for (const n of nodes) {
    if (n.ignored || (n.role?.value ?? '') !== 'generic') continue;

    if (focusableGeneric(n, textName)) admitted.add(n.nodeId);
  }

  const decides = (n: AxNodeLite): boolean => allowedRoles.has(n.role?.value ?? '') || admitted.has(n.nodeId);
  const descendants = new Map<string, number>();

  for (const n of nodes.filter(n => !n.ignored && decides(n))) {
    let p = n.parentId ? byId.get(n.parentId) : undefined;
    const visited = new Set<string>();

    while (p && !visited.has(p.nodeId) && visited.size < 64) {
      visited.add(p.nodeId);
      descendants.set(p.nodeId, (descendants.get(p.nodeId) ?? 0) + 1);
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
  }

  for (const n of nodes) {
    const id = n.backendDOMNodeId;
    const role = n.role?.value ?? '';

    if (n.ignored || !id || seen.has(id) || !decides(n) || (keep && !keep.has(id))) {
      continue;
    }

    seen.add(id);
    const props = Object.fromEntries((n.properties ?? []).map(p => [p.name, p.value?.value]));
    const truth = (v: unknown) => v === true || v === 'true';
    const c: BrowserControl = { ref: `@${id}`, role, name: effectiveName(n), disabled: truth(props.disabled) };

    if ([true, false, 'true', 'false'].includes(props.readonly as string | boolean)) {
      c.readOnly = truth(props.readonly);
    }

    if (truth(props.protected)) {
      c.protected = true;
    }

    if (props.invalid !== undefined) {
      c.invalid = props.invalid === false || props.invalid === 'false' ? false : props.invalid === true || props.invalid === 'true' ? true : String(props.invalid);
    }

    if (n.value?.value !== undefined && !c.protected) {
      c.value = String(n.value.value);
    }

    const scope = ancestor(n, p => scopeRoles.has((p.role?.value ?? '').toLowerCase())) ?? ancestor(n, p => {
      const parent = p.parentId ? byId.get(p.parentId) : undefined;

      return !!p.backendDOMNodeId && !!parent && !['RootWebArea', 'WebArea'].includes(parent.role?.value ?? '') && ['generic', 'none', 'presentation'].includes(p.role?.value ?? '') && (descendants.get(p.nodeId) ?? 0) > 1;
    });

    if (scope) {
      c.scopeId = scopeIdentity(scope);
      c.scopeLabel = `${scope.role?.value ?? 'group'} ${scope.name?.value ?? ''}`.trim();
    }

    if (role === 'combobox') {
      const options = nodes.filter(o => o.role?.value === 'option' && ancestor(o, p => p.role?.value === 'combobox')?.nodeId === n.nodeId && o.backendDOMNodeId);

      if (options.length) {
        c.options = options.map(o => ({ ref: `@${o.backendDOMNodeId}`, label: o.name?.value ?? '', disabled: o.properties?.some(p => p.name === 'disabled' && truth(p.value?.value)) ?? false }));
      }
    }

    for (const key of ['selected', 'expanded', 'focused'] as const) {
      if ([true, false, 'true', 'false'].includes(props[key] as string | boolean)) {
        c[key] = truth(props[key]);
      }
    }

    if ([true, false, 'true', 'false', 'mixed'].includes(props.checked as string | boolean)) {
      c.checked = props.checked === 'mixed' ? 'mixed' : truth(props.checked);
    }

    if (typeof props.url === 'string') {
      c.url = props.url;
    }

    result.push(c);
  }

  if (refs) {
    const order = new Map(refs.map((id, index) => [`@${id}`, index]));
    result.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));
  }

  return result;
}

const scopeIdentity = (n: AxNodeLite) => `${n.frameId ?? 'page'}:${n.backendDOMNodeId ?? `ax-${n.nodeId}`}`;

export function decisionDialogs(nodes: readonly AxNodeLite[]): string[] {
  return nodes.filter(n => !n.ignored && ['dialog', 'alertdialog'].includes(n.role?.value ?? '')).map(n => `${scopeIdentity(n)}:${n.name?.value ?? ''}`).sort();
}

export function decisionControlsTruncated(nodes: readonly AxNodeLite[], controls: readonly BrowserControl[]): boolean {
  // Use the same admission rule as collection, including focusable generics.
  // Counting only allowedRoles made a fully collected three-control menu look
  // truncated as soon as its role-less trigger was correctly admitted.
  const admitted = new Set(decisionControls(nodes).map(control => control.ref));

  const observed = nodes.filter(n => !n.ignored && n.backendDOMNodeId && admitted.has(`@${n.backendDOMNodeId}`)
    && (allowedRoles.has(n.role?.value ?? '') || n.role?.value === 'generic'));

  return admitted.size !== controls.length || controls.some(control => !admitted.has(control.ref))
    || new Set(controls.map(control => control.ref)).size !== controls.length
    || new Set(observed.map(n => n.backendDOMNodeId)).size !== observed.length;
}

export const VIEW_CONTROL_BUDGET = 100;

export const VIEW_TAB_BUDGET = 64;

export const MAX_COLLECTED_CONTROLS = 2500;

export const SCOPE_SUMMARY_BUDGET = 32;

export type ObservationViewInput = {
  collected: BrowserControl[];
  tabs?: import('../../../shared/protocol.js').TabInfo[];
  collectionComplete: boolean;
  collectionLimitReached?: boolean;
  generation: string;
  textTruncated: boolean;
  cursor?: string;
  viewScopeId?: string;
};

export type ObservationView = {
  controls: BrowserControl[];
  tabs?: import('../../../shared/protocol.js').TabInfo[];
  truncated: boolean;
  textTruncated: boolean;
  controlsTruncated: boolean;
  collectedCount: number;
  collectionComplete: boolean;
  collectionLimitReached?: boolean;
  generation: string;
  viewScopeId?: string;
  viewScopeLabel?: string;
  viewComplete: boolean;
  visibleCount: number;
  hasMore: boolean;
  nextCursor?: string;
  scopes?: import('../../../shared/browser-decision.js').BrowserScopeSummary[];
  scopesTruncated?: boolean;
  scopesHasMore?: boolean;
  scopesNextCursor?: string;
  tabsHasMore?: boolean;
  tabsNextCursor?: string;
  tabsTruncated?: boolean;
};

type CursorKind = 'controls' | 'tabs' | 'scopes';

function encodeCursor(generation: string, kind: CursorKind, offset: number, scopeId?: string): string {
  return scopeId !== undefined
    ? `${generation}:${kind}:${encodeURIComponent(scopeId)}:${offset}`
    : `${generation}:${kind}:${offset}`;
}

function decodeCursor(cursor: string, generation: string): { kind: CursorKind; offset: number; scopeId?: string } {
  const parts = cursor.split(':');

  if (parts.length < 3 || parts[0] !== generation) {
    throw new Error('DECISION_CURSOR: 游标与当前采集代次不匹配。');
  }

  const kind = parts[1] as CursorKind;

  if (kind !== 'controls' && kind !== 'tabs' && kind !== 'scopes') {
    throw new Error('DECISION_CURSOR: 游标类型无效。');
  }

  if (kind === 'controls' && parts.length === 4) {
    const scopeId = decodeURIComponent(parts[2]!);
    const offset = Number(parts[3]);

    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('DECISION_CURSOR: 游标偏移无效。');

    return { kind, offset, scopeId };
  }

  if (parts.length !== 3) throw new Error('DECISION_CURSOR: 游标格式无效。');
  const offset = Number(parts[2]);

  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('DECISION_CURSOR: 游标偏移无效。');

  return { kind, offset };
}

function partitionByScope(controls: readonly BrowserControl[]): Array<{ id: string; label: string; controls: BrowserControl[] }> {
  const order: string[] = [];
  const map = new Map<string, { id: string; label: string; controls: BrowserControl[] }>();

  for (const c of controls) {
    const id = c.scopeId ?? 'page:unscoped';
    const label = c.scopeLabel ?? (c.scopeId ? c.scopeId : 'Page list');
    let bucket = map.get(id);

    if (!bucket) {
      bucket = { id, label, controls: [] };
      map.set(id, bucket);
      order.push(id);
    }

    bucket.controls.push(c);
  }

  return order.map(id => map.get(id)!);
}

/** Bound the model view; host keeps `collected` for verification and continue-reads. */
export function selectObservationView(input: ObservationViewInput): ObservationView {
  const { collected, tabs = [], collectionComplete, collectionLimitReached, generation, textTruncated } = input;

  if (!generation || generation.length > 120) throw new Error('DECISION_CURSOR: 缺少宿主采集代次。');
  const partitions = partitionByScope(collected);
  const hasSemanticScopes = partitions.some(p => p.id !== 'page:unscoped');

  let cursor = input.cursor ? decodeCursor(input.cursor, generation) : undefined;
  let viewScopeId = input.viewScopeId;

  if (cursor?.kind === 'controls' && cursor.scopeId) viewScopeId = cursor.scopeId;

  if (cursor && cursor.kind === 'scopes') {
    const start = cursor.offset;

    if (start >= partitions.length) throw new Error('DECISION_CURSOR: 分区摘要游标已过期。');
    const slice = partitions.slice(start, start + SCOPE_SUMMARY_BUDGET);
    const scopesHasMore = start + SCOPE_SUMMARY_BUDGET < partitions.length;
    // Scope-summary continue does not change the control view; keep first control page.
    const controlView = selectObservationView({ ...input, cursor: undefined, viewScopeId });

    return {
      ...controlView,
      scopes: slice.map(p => ({ id: p.id, label: p.label, count: p.controls.length, complete: true })),
      scopesTruncated: scopesHasMore || partitions.length > SCOPE_SUMMARY_BUDGET,
      scopesHasMore,
      scopesNextCursor: scopesHasMore ? encodeCursor(generation, 'scopes', start + SCOPE_SUMMARY_BUDGET) : undefined,
    };
  }

  if (cursor && cursor.kind === 'tabs') {
    if (cursor.offset >= tabs.length) throw new Error('DECISION_CURSOR: 标签页游标已过期。');
    const tabSlice = tabs.slice(cursor.offset, cursor.offset + VIEW_TAB_BUDGET);
    const tabsHasMore = cursor.offset + VIEW_TAB_BUDGET < tabs.length;
    const controlView = selectObservationView({ ...input, cursor: undefined });

    return {
      ...controlView,
      tabs: tabSlice,
      tabsHasMore,
      tabsTruncated: tabsHasMore,
      tabsNextCursor: tabsHasMore ? encodeCursor(generation, 'tabs', cursor.offset + VIEW_TAB_BUDGET) : undefined,
    };
  }

  let pool = collected;
  let viewScopeLabel: string | undefined;

  if (viewScopeId) {
    const part = partitions.find(p => p.id === viewScopeId);

    if (!part) throw new Error('DECISION_CURSOR: 分区不在当前采集中。');
    pool = part.controls;
    viewScopeLabel = part.label;
  } else if (hasSemanticScopes && collected.length > VIEW_CONTROL_BUDGET) {
    // Default first view: first semantic partition that fits, else first partition page.
    const first = partitions[0]!;

    if (first.controls.length <= VIEW_CONTROL_BUDGET) {
      pool = first.controls;
      viewScopeId = first.id;
      viewScopeLabel = first.label;
    }
  }

  const offset = cursor?.kind === 'controls' ? cursor.offset : 0;

  if (offset > pool.length) throw new Error('DECISION_CURSOR: 控件游标已过期。');

  if (offset === pool.length && pool.length > 0) throw new Error('DECISION_CURSOR: 控件游标已过期。');
  const controls = pool.slice(offset, offset + VIEW_CONTROL_BUDGET);
  const hasMoreInPool = offset + controls.length < pool.length;
  // More partitions after the current scoped/default window.
  let hasMorePartitions = false;

  if (viewScopeId && hasSemanticScopes) {
    const idx = partitions.findIndex(p => p.id === viewScopeId);
    hasMorePartitions = idx >= 0 && idx + 1 < partitions.length && !hasMoreInPool;
  }

  const hasMore = hasMoreInPool || hasMorePartitions;
  let nextCursor: string | undefined;

  if (hasMoreInPool) {
    nextCursor = encodeCursor(generation, 'controls', offset + controls.length, viewScopeId);
  } else if (hasMorePartitions && viewScopeId) {
    const idx = partitions.findIndex(p => p.id === viewScopeId);
    const next = partitions[idx + 1];

    if (next) nextCursor = encodeCursor(generation, 'controls', 0, next.id);
  }

  const scopeSummaries = partitions.map(p => ({ id: p.id, label: p.label, count: p.controls.length, complete: true }));
  const scopes = scopeSummaries.slice(0, SCOPE_SUMMARY_BUDGET);
  const scopesHasMore = scopeSummaries.length > SCOPE_SUMMARY_BUDGET;
  const tabSlice = tabs.slice(0, VIEW_TAB_BUDGET);
  const tabsHasMore = tabs.length > VIEW_TAB_BUDGET;

  return {
    controls,
    tabs: tabs.length ? tabSlice : undefined,
    truncated: textTruncated || !collectionComplete,
    textTruncated,
    controlsTruncated: !collectionComplete,
    collectedCount: collected.length,
    collectionComplete,
    ...(collectionLimitReached ? { collectionLimitReached: true } : {}),
    generation,
    ...(viewScopeId ? { viewScopeId, viewScopeLabel } : {}),
    viewComplete: !hasMoreInPool,
    visibleCount: controls.length,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    ...(hasSemanticScopes || partitions.length > 1 ? {
      scopes,
      scopesTruncated: scopesHasMore,
      scopesHasMore,
      ...(scopesHasMore ? { scopesNextCursor: encodeCursor(generation, 'scopes', SCOPE_SUMMARY_BUDGET) } : {}),
    } : {}),
    ...(tabs.length ? {
      tabsHasMore,
      tabsTruncated: tabsHasMore,
      ...(tabsHasMore ? { tabsNextCursor: encodeCursor(generation, 'tabs', VIEW_TAB_BUDGET) } : {}),
    } : {}),
  };
}

/** Collect interactive controls with an explicit host budget; never use text-render refs as existence. */
export function collectDecisionControls(nodes: readonly AxNodeLite[], limit = MAX_COLLECTED_CONTROLS): {
  controls: BrowserControl[];
  collectionComplete: boolean;
  collectionLimitReached: boolean;
} {
  const all = decisionControls(nodes);

  if (all.length <= limit) {
    return { controls: all, collectionComplete: !decisionControlsTruncated(nodes, all), collectionLimitReached: false };
  }

  return { controls: all.slice(0, limit), collectionComplete: false, collectionLimitReached: true };
}

// Exclude our own UI by DOM ownership, not by a business/site/name heuristic. Closed
// shadow roots are visible to CDP; the page cannot turn an assistant control into a task candidate.
export async function readDecisionTree(tabId: number): Promise<AxNodeLite[]> {
  const { root } = await sendCommand<{
    root: {
      nodeId: number;
    };
  }>(tabId, 'DOM.getDocument', { depth: 0 });

  const { nodeIds } = await sendCommand<{
    nodeIds: number[];
  }>(tabId, 'DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-sideagent-overlay],[data-sideagent-ask]' });

  const excluded = new Set<number>();

  type Node = {
    backendNodeId?: number;
    children?: Node[];
    shadowRoots?: Node[];
    contentDocument?: Node;
  };

  const visit = (n: Node) => {
    if (n.backendNodeId) {
      excluded.add(n.backendNodeId);
    }

    for (const c of [...n.children ?? [], ...n.shadowRoots ?? [], ...(n.contentDocument ? [n.contentDocument] : [])]) {
      visit(c);
    }
  };

  for (const nodeId of nodeIds) {
    const { node } = await sendCommand<{
      node: Node;
    }>(tabId, 'DOM.describeNode', { nodeId, depth: -1, pierce: true });

    visit(node);
  }

  const tree = await sendCommand<{
    nodes?: AxNodeLite[];
  }>(tabId, 'Accessibility.getFullAXTree');

  return (tree.nodes ?? []).filter(n => !n.backendDOMNodeId || !excluded.has(n.backendDOMNodeId));
}

/** One currently issued observation per execution member/tab. Consumed before any possible write. */
export class BrowserObservationRegistry {
  private pages = new Map<string, {
    member: string;
    page: BrowserObservation;
    collected: BrowserControl[];
    collectedTabs: import('../../../shared/protocol.js').TabInfo[];
    generation: string;
  }>();
  issue(
    member: string,
    page: Omit<BrowserObservation, 'id' | 'observedAt'>,
    extras?: {
      collectedControls?: BrowserControl[];
      collectedTabs?: import('../../../shared/protocol.js').TabInfo[];
      generation?: string;
    },
  ): BrowserObservation {
    const key = `${member}:${page.tabId}`;
    const generation = extras?.generation ?? page.generation ?? crypto.randomUUID();
    const collected = extras?.collectedControls ? structuredClone(extras.collectedControls) : structuredClone(page.controls);
    const collectedTabs = extras?.collectedTabs ? structuredClone(extras.collectedTabs) : structuredClone(page.tabs ?? []);

    if (collected.length > MAX_COLLECTED_CONTROLS) {
      throw new Error('DECISION_UNSUPPORTED: 采集控件超出宿主登记上限。');
    }

    const value: BrowserObservation = {
      ...page,
      id: crypto.randomUUID(),
      observedAt: Date.now(),
      generation,
      collectedCount: page.collectedCount ?? collected.length,
    };

    if (this.pages.size >= 256 && !this.pages.has(key)) {
      this.pages.delete(this.pages.keys().next().value!);
    }

    this.pages.set(key, { member, page: structuredClone(value), collected, collectedTabs, generation });

    return value;
  }
  peekCollected(member: string, tabId: number): BrowserControl[] | undefined {
    return this.pages.get(`${member}:${tabId}`)?.collected.map(c => ({ ...c }));
  }
  /** Same-generation continue-read: host-owned collected baseline, not a model claim. */
  readActive(member: string, tabId: number): {
    page: BrowserObservation;
    collected: BrowserControl[];
    collectedTabs: import('../../../shared/protocol.js').TabInfo[];
    generation: string;
  } | undefined {
    const entry = this.pages.get(`${member}:${tabId}`);

    if (!entry) return undefined;

    return {
      page: structuredClone(entry.page),
      collected: entry.collected.map(c => ({ ...c })),
      collectedTabs: entry.collectedTabs.map(t => ({ ...t })),
      generation: entry.generation,
    };
  }
  consume(member: string, tabId: number, operation: string, params: Record<string, unknown>): BrowserObservation {
    const guard = params.decisionGuard as BrowserActionGuard | undefined;
    const sourceTabId = operation === 'switch_tab' ? guard?.sourceTabId : tabId;
    const entry = this.pages.get(`${member}:${sourceTabId}`);

    if (!guard || !entry || guard.observationId !== entry.page.id || guard.operation !== operation) {
      throw new Error('DECISION_STALE: 观察身份无效，未执行。');
    }

    this.pages.delete(`${member}:${sourceTabId}`);

    if (Date.now() - entry.page.observedAt > 15000) {
      throw new Error('DECISION_STALE: 观察已过期，未执行。');
    }

    if (operation === 'switch_tab') {
      if (!entry.page.tabs?.some(t => t.id === tabId) || params.tabId !== tabId || guard.target !== undefined) {
        throw new Error('DECISION_INVALID: 标签页不在当前观察中。');
      }

      return entry.page;
    }

    if (!['click', 'fill', 'press_key', 'scroll', 'hover'].includes(operation)) {
      throw new Error('DECISION_INVALID: 不支持的候选动作。');
    }

    if (operation === 'scroll') {
      if (guard.target !== undefined || params.toBottom !== undefined || typeof params.dy !== 'number' || ![600, -600].includes(params.dy)) {
        throw new Error('DECISION_INVALID: 无效滚动参数。');
      }
    }
    else {
      // Target must appear in the issued view; verification uses the full collected baseline.
      const control = entry.page.controls.find(c => c.ref === guard.target);

      if (!control || control.disabled || control.protected || params.target !== control.ref || params.point !== undefined) {
        throw new Error('DECISION_INVALID: 目标不在当前候选中。');
      }

      if ((operation === 'click' || operation === 'hover') && !clickableRoles.has(control.role)) {
        throw new Error(operation === 'hover' ? 'DECISION_INVALID: 该控件没有可选悬停动作。' : 'DECISION_INVALID: 该控件没有可选点击动作。');
      }

      if (operation === 'press_key' && (!control.focused || params.key !== 'Enter')) {
        throw new Error('DECISION_INVALID: 按键目标不在焦点上。');
      }

      if (operation === 'fill' && (control.readOnly || !['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(control.role) || typeof params.value !== 'string')) {
        throw new Error('DECISION_INVALID: 填写目标或参数无效。');
      }
    }

    // Return collected controls as the verification baseline (view stays on entry.page for identity).
    return { ...entry.page, controls: entry.collected };
  }
}

export const browserObservations = new BrowserObservationRegistry();

export async function assertBrowserDecision(member: string, operation: string, params: Record<string, unknown>): Promise<void> {
  if (params.decisionGuard === undefined) {
    return;
  }

  if (!Number.isSafeInteger(params.tabId)) {
    throw new Error('DECISION_INVALID: 缺少作用页面。');
  }

  const page = browserObservations.consume(member, Number(params.tabId), operation, params);
  const current = await readCurrentDocument(page.tabId);

  if (current?.documentId !== page.documentId) {
    throw new Error('DECISION_STALE: 页面文档已变化，未执行。');
  }

  const tab = await chrome.tabs.get(page.tabId);

  if (tab.url !== page.url) {
    throw new Error('DECISION_STALE: 页面地址已变化，未执行。');
  }

  if (operation === 'switch_tab') {
    const expected = page.tabs!.find(t => t.id === params.tabId)!;
    const target = await chrome.tabs.get(expected.id);

    if (target.url !== expected.url || target.title !== expected.title || target.pendingUrl && target.pendingUrl !== expected.url) {
      throw new Error('DECISION_STALE: 目标标签页已变化，未执行。');
    }

    return;
  }

  const nodes = await readDecisionTree(page.tabId);
  const fresh = decisionControls(nodes);
  const guard = params.decisionGuard as BrowserActionGuard;
  let viewport: BrowserObservation['viewport'];

  if (operation === 'scroll' && page.viewport) {
    const result = await chrome.scripting.executeScript({ target: { tabId: page.tabId }, world: 'ISOLATED', func: () => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }) });

    if (result[0]?.documentId !== page.documentId) {
      throw new Error('DECISION_STALE: 滚动观察所属页面已变化。');
    }

    viewport = result[0]?.result;
  }

  // `page.controls` is the collected baseline from consume(); never compare a short view to a full tree.
  const changed = browserContextChange(page, { documentId: current!.documentId!, url: tab.url!, controls: fresh, dialogs: decisionDialogs(nodes), viewport }, guard.target);

  if (changed) {
    throw new Error(`DECISION_STALE: ${changed}，请重新观察。`);
  }

  const final = await readCurrentDocument(page.tabId);

  if (final?.documentId !== page.documentId || (await chrome.tabs.get(page.tabId)).url !== page.url) {
    throw new Error('DECISION_STALE: 读取期间换页，未执行。');
  }
}
