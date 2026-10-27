import type { readFieldInPage } from "./field-read-in-page.js";

/** 序列化到页面中执行：统一快照发送区域中可见的非敏感输入，不把原文写进记录。 */
export function snapshotSendScopeInPage(target: Element | null, read: typeof readFieldInPage, sensitiveName: string): string | null {
  if (!target?.isConnected) return null;
  const owner = target.closest('button,[role="button"],input[type="submit"],input[type="button"],a') ?? target;
  const form = ("form" in owner && owner.form instanceof HTMLFormElement ? owner.form : null) ?? owner.closest("form");
  let scope: Element | null = form;
  if (!scope) {
    for (let node = owner.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if ([...node.querySelectorAll("textarea,input,select,[contenteditable=true]")].some(field => field.getClientRects().length > 0)) { scope = node; break; }
    }
  }
  const seen = new Set<Element>();
  const candidates = scope ? [...scope.querySelectorAll("textarea,input,select,[contenteditable=true]"), ...(scope instanceof HTMLFormElement ? [...scope.elements] : [])] : [];
  const fields: Array<{ value: NonNullable<ReturnType<typeof readFieldInPage>>; checked: boolean | null }> = [];
  let chars = 0;
  for (const field of candidates) {
    if (!(field instanceof HTMLElement) || seen.has(field) || !field.getClientRects().length) continue;
    seen.add(field);
    if (field instanceof HTMLInputElement && !/^(text|search|email|url|tel|number|checkbox|radio)$/i.test(field.type)) continue;
    if (field.isContentEditable && field.parentElement?.isContentEditable) continue;
    const value = read.call(field, null, 1_000_000, sensitiveName);
    if (!value) continue;
    if (value.sensitive || value.value === undefined || value.truncated) return null;
    chars += value.value.length;
    fields.push({ value, checked: field instanceof HTMLInputElement && /^(checkbox|radio)$/i.test(field.type) ? field.checked : null });
    if (fields.length > 100 || chars > 1_000_000) return null;
  }
  return JSON.stringify(fields);
}
