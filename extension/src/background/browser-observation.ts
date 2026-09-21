import type { BrowserObservation, BrowserControl, BrowserActionGuard } from '../../../shared/browser-decision.js';
import { browserContextChange } from '../../../shared/browser-decision-context.js';
import type { AxNodeLite } from './axtree.js';
import { sendCommand } from './debugger.js';
import { readCurrentDocument } from './exec/page-readiness.js';

const allowedRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'textbox', 'searchbox', 'combobox', 'spinbutton']);

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
  const descendants = new Map<string, number>();
  for (const n of nodes.filter(n => !n.ignored && allowedRoles.has(n.role?.value ?? ''))) {
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
    if (n.ignored || !id || seen.has(id) || !allowedRoles.has(role) || (keep && !keep.has(id))) {
      continue;
    }
    seen.add(id);
    const props = Object.fromEntries((n.properties ?? []).map(p => [p.name, p.value?.value]));
    const truth = (v: unknown) => v === true || v === 'true';
    const c: BrowserControl = { ref: `@${id}`, role, name: n.name?.value ?? '', disabled: truth(props.disabled) };
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
  const observed = nodes.filter(n => !n.ignored && allowedRoles.has(n.role?.value ?? '') && n.backendDOMNodeId);
  return observed.length !== controls.length || new Set(observed.map(n => n.backendDOMNodeId)).size !== observed.length;
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
  }>();
  issue(member: string, page: Omit<BrowserObservation, 'id' | 'observedAt'>): BrowserObservation {
    const key = `${member}:${page.tabId}`;
    const value = { ...page, id: crypto.randomUUID(), observedAt: Date.now() };
    if (this.pages.size >= 256 && !this.pages.has(key)) {
      this.pages.delete(this.pages.keys().next().value!);
    }
    this.pages.set(key, { member, page: structuredClone(value) });
    return value;
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
    if (!['click', 'fill', 'press_key', 'scroll'].includes(operation)) {
      throw new Error('DECISION_INVALID: 不支持的候选动作。');
    }
    if (operation === 'scroll') {
      if (guard.target !== undefined || params.toBottom !== undefined || typeof params.dy !== 'number' || ![600, -600].includes(params.dy)) {
        throw new Error('DECISION_INVALID: 无效滚动参数。');
      }
    }
    else {
      const control = entry.page.controls.find(c => c.ref === guard.target);
      if (!control || control.disabled || control.protected || params.target !== control.ref || params.point !== undefined) {
        throw new Error('DECISION_INVALID: 目标不在当前候选中。');
      }
      if (operation === 'click' && !['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'combobox'].includes(control.role)) {
        throw new Error('DECISION_INVALID: 该控件没有可选点击动作。');
      }
      if (operation === 'press_key' && (!control.focused || params.key !== 'Enter')) {
        throw new Error('DECISION_INVALID: 按键目标不在焦点上。');
      }
      if (operation === 'fill' && (control.readOnly || !['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(control.role) || typeof params.value !== 'string')) {
        throw new Error('DECISION_INVALID: 填写目标或参数无效。');
      }
    }
    return entry.page;
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
  const changed = browserContextChange(page, { documentId: current!.documentId!, url: tab.url!, controls: fresh, dialogs: decisionDialogs(nodes), viewport }, guard.target);
  if (changed) {
    throw new Error(`DECISION_STALE: ${changed}，请重新观察。`);
  }
  const final = await readCurrentDocument(page.tabId);
  if (final?.documentId !== page.documentId || (await chrome.tabs.get(page.tabId)).url !== page.url) {
    throw new Error('DECISION_STALE: 读取期间换页，未执行。');
  }
}
