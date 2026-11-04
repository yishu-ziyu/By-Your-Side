import { BROWSE_EVENT, type BrowseStep } from '../shared/browse-habits.js';
import { nudgeableUrl } from '../shared/nudge.js';
import { OVERLAY_ATTR } from '../shared/overlay.js';
import { extensionAlive } from './alive.js';

const CLICKABLE = 'a,button,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=radio],input[type=submit],input[type=button],input[type=checkbox],input[type=radio]';

const SECRET_FIELD = /pass|pwd|card|cc-|cvc|cvv|csc|one-time|otp|验证码|密码|卡号/i;

const squash = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function send(step: BrowseStep): void {
  if (!extensionAlive()) return;

  try {
    void chrome.runtime.sendMessage({ type: BROWSE_EVENT, step }).catch(() => {});
  } catch {  }
}

function fieldLabel(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : '';
  const byIds = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => id && document.getElementById(id)?.textContent).filter(Boolean).join(' ');

  return squash(el.getAttribute('aria-label') || byIds || byFor || el.closest('label')?.textContent || ('placeholder' in el ? el.placeholder : '') || el.name || el.type, 60);
}

function looksLikeCard(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');

  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;

  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);

    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }

  return sum % 10 === 0;
}

function secretField(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true;

  return looksLikeCard(el.value) || SECRET_FIELD.test(`${el.getAttribute('autocomplete') ?? ''} ${el.name} ${el.id} ${fieldLabel(el)}`);
}

const typedField = (t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement =>
  (t instanceof HTMLInputElement && !['checkbox', 'radio', 'submit', 'button', 'hidden', 'file', 'range', 'color'].includes(t.type)) || t instanceof HTMLTextAreaElement;

export function installBrowseLog(): void {
  if (!nudgeableUrl(location.href) || window.top !== window) return;

  let href = '';
  const visit = () => {
    if (location.href === href) return;
    href = location.href;
    setTimeout(() => send({ kind: 'visit', title: squash(document.title, 200) }), 800);
  };

  visit();
  setInterval(() => { if (extensionAlive()) visit(); }, 1000);

  document.addEventListener('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element) || event.target.closest(`[${OVERLAY_ATTR}]`)) return;
    const el = event.target.closest<HTMLElement>(CLICKABLE);

    if (!el) return;

    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return;
    const label = squash(el.getAttribute('aria-label') || el.innerText || (el as HTMLInputElement).value || el.title, 80);

    if (!label) return;
    const link = el.closest('a');

    send({ kind: 'click', label, ...(link?.href && !link.href.startsWith('javascript:') ? { href: link.href.slice(0, 500) } : {}) });
  }, true);

  document.addEventListener('change', event => {
    const el = event.target;

    if (!event.isTrusted || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) || secretField(el)) return;
    const label = fieldLabel(el);
    let value: string;

    if (el instanceof HTMLSelectElement) value = squash(el.selectedOptions[0]?.textContent, 120);
    else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) value = el.checked ? '选中' : '取消';
    else value = squash(el.value, 120);

    if (value) send({ kind: 'fill', label, value });
  }, true);

  document.addEventListener('keydown', event => {
    const el = event.target;

    if (!event.isTrusted || event.key !== 'Enter' || event.isComposing || !typedField(el) || el instanceof HTMLTextAreaElement || secretField(el)) return;
    const value = squash(el.value, 120);

    if (value) send({ kind: 'submit', label: fieldLabel(el), value });
  }, true);
}
