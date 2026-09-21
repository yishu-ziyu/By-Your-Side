import type { BrowserControl, BrowserObservation } from './browser-decision.js';

const editableRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'switch']);

const keys = ['ref', 'role', 'name', 'value', 'disabled', 'checked', 'selected', 'expanded', 'focused', 'url', 'readOnly', 'protected', 'invalid', 'scopeId', 'scopeLabel'] as const;
/** Compare action evidence, not a whole-page byte snapshot. A new observation ID is expected. */
export function browserContextChange(before: BrowserObservation, after: Pick<BrowserObservation, 'documentId' | 'url' | 'controls' | 'dialogs' | 'viewport'>, targetRef?: string): string | null {
  if (before.documentId !== after.documentId || before.url !== after.url) {
    return '页面文档或地址已变化';
  }
  const target = before.controls.find(c => c.ref === targetRef);
  if (targetRef && !target) {
    return '原目标不在观察中';
  }
  // Keep all editable values as conservative dependencies (e.g. copy one field into
  // another). Scope narrows incidental buttons, not the source facts used by an action.
  const relevant = (c: BrowserControl) => c.ref === targetRef || (!!target?.scopeId && c.scopeId === target.scopeId) || editableRoles.has(c.role);
  const expected = before.controls.filter(relevant);
  const actual = after.controls.filter(relevant);
  if (expected.length !== actual.length || expected.some(c => {
    const a = actual.find(a => a.ref === c.ref);
    return !a || keys.some(k => c[k] !== a[k]) || JSON.stringify(c.options) !== JSON.stringify(a.options);
  })) {
    return '目标或关联区域已变化';
  }
  if (JSON.stringify(before.dialogs ?? []) !== JSON.stringify(after.dialogs ?? [])) {
    return '对话框已变化';
  }
  if (!targetRef && before.viewport && after.viewport && (['x', 'y', 'width', 'height'] as const).some(k => before.viewport![k] !== after.viewport![k])) {
    return '滚动位置或视口已变化';
  }
  return null;
}
