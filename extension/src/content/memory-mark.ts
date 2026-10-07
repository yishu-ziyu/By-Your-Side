import { isPageInteractionMessage, type PageInteractionMessage } from '../../../shared/protocol.js';
import { OVERLAY_ATTR } from '../shared/overlay.js';

/**
 * 按记忆填的那一格：淡蓝底、细边和「记得的」小标签（YIS-87，样子见 docs/previews/circle-and-memory）。
 * 画在页面上面的一层里，不改这一格的值和网页结构；你动手改了这一格，或这一格不在了，记号就消失。
 * 点标签弹出小卡：改一下（选中这一格让你改）/ 这次不用（清空，记忆还在）/ 忘掉（清空，并交给侧栏忘掉这条）。
 */
const FIELD_ATTR = 'data-sideagent-memory-field';

const STYLE = `
  .tint { position:fixed; box-sizing:border-box; pointer-events:none; background:rgba(45,74,134,.075); box-shadow:inset 0 0 0 1px rgba(45,74,134,.38); animation:in .25s ease both; }
  .tag { all:unset; position:fixed; transform:translateY(-50%); display:inline-flex; align-items:center; gap:4px; pointer-events:auto; cursor:pointer; box-sizing:border-box;
    font:500 11px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif; color:#2d4a86; background:#fff;
    border:1px solid rgba(45,74,134,.38); border-radius:999px; padding:3px 7px; white-space:nowrap; animation:in .25s ease both; }
  .tag::before { content:""; width:6px; height:6px; border-radius:50%; background:#2d4a86; }
  .tag:focus-visible { outline:2px solid #2d4a86; outline-offset:2px; }
  .pop { position:fixed; width:268px; box-sizing:border-box; display:grid; gap:8px; pointer-events:auto; background:#fff; border:1px solid #e3e1d9; border-radius:10px; padding:10px 12px;
    box-shadow:0 8px 26px rgba(20,20,19,.14); font:400 12.5px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif; color:#141413; animation:pop .16s ease both; }
  .pop .src { color:#5f5e58; } .pop .src b { color:#141413; font-weight:600; }
  .pop .acts { display:flex; gap:6px; }
  .pop button { all:unset; cursor:pointer; font:500 12px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; border:1px solid rgba(20,20,19,.12); background:#fff; color:#141413; border-radius:999px; padding:3px 10px; }
  .pop button:hover { background:#f0eee6; } .pop button.warn { color:#b54848; } .pop button:focus-visible { outline:2px solid #2d4a86; outline-offset:2px; }
  .pop .err { color:#b54848; }
  @keyframes in { from { opacity:0; } }
  @keyframes pop { from { opacity:0; transform:translateY(-4px); } }
  @media (prefers-reduced-motion: reduce) { .tint, .tag, .pop { animation:none; } }
`;

type MemoryFieldMark = Extract<PageInteractionMessage, { type: 'MEMORY_FIELD_MARK' }>;

const dateLabel = (at: number) => { const d = new Date(at);

 return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };

export function installMemoryMark(): void {
  const marks = new Map<Element, () => void>();

  function mark(field: HTMLElement, memory: MemoryFieldMark['memory']): void {
    marks.get(field)?.();
    const host = document.createElement('div');
    host.setAttribute(OVERLAY_ATTR, 'memory-field');
    host.dataset.memoryId = memory.id;
    host.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483646;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const tint = document.createElement('div');
    tint.className = 'tint';
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'tag';
    tag.textContent = '记得的';
    tag.setAttribute('aria-label', `记得的：按你说过的「${memory.text}」填的，点开可以改`);
    let pop: HTMLElement | null = null;
    shadow.append(style, tint, tag);
    document.documentElement.appendChild(host);

    const place = () => {
      const r = field.getBoundingClientRect();

      if (!field.isConnected || (!r.width && !r.height)) { remove();

 return; }

      Object.assign(tint.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: getComputedStyle(field).borderRadius });

      // 标签贴在格子里靠右；格子太窄就挂在格子右上角外面。
      const inside = r.width >= 140;
      Object.assign(tag.style, inside ? { left: '', right: `${innerWidth - r.right + 6}px`, top: `${r.top + r.height / 2}px` } : { right: '', left: `${r.right + 6}px`, top: `${r.top + r.height / 2}px` });

      if (pop) Object.assign(pop.style, { left: `${Math.max(8, Math.min(r.right - 268, innerWidth - 276))}px`, top: `${r.bottom + 8}px` });
    };

    const closePop = () => { pop?.remove(); pop = null; removeEventListener('pointerdown', onOutside, true); removeEventListener('keydown', onKey, true); };

    const onOutside = (event: Event) => { if (!event.composedPath().includes(host)) closePop(); };

    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { closePop(); tag.focus(); } };

    // 清空这一格：用原生 setter 再发 input/change，受控组件（React 等）也认。
    const clearField = () => {
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, '');
      } else if (field.isContentEditable) field.textContent = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const act = async (action: 'edit' | 'once' | 'forget', button: HTMLButtonElement) => {
      if (action === 'edit') {
        remove();
        field.focus();

        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select();

        return;
      }

      if (action === 'once') { clearField(); remove();

 return; }

      button.disabled = true;
      // 忘掉交给侧栏：它用回答下面那一行同一套「忘掉」，侧栏里写明已忘掉、可撤销。
      // SAFETY: 侧栏按 MEMORY_FIELD_FORGET 回 { ok }；没人接时是 undefined，出错时上面换成 null。
      const result = await chrome.runtime.sendMessage({ type: 'MEMORY_FIELD_FORGET', id: memory.id }).catch(() => null) as { ok?: boolean } | null;

      if (result?.ok) { clearField(); remove();

 return; }

      button.disabled = false;
      const err = pop?.querySelector('.err') ?? pop?.appendChild(Object.assign(document.createElement('div'), { className: 'err' }));

      if (err) err.textContent = '没能忘掉：请打开侧栏，在「记忆」里删掉这条。';
    };

    tag.onclick = () => {
      if (pop) { closePop();

 return; }

      pop = document.createElement('div');
      pop.className = 'pop';
      pop.setAttribute('role', 'dialog');
      const src = document.createElement('div');
      src.className = 'src';
      const quoted = document.createElement('b');
      quoted.textContent = memory.text;
      src.append(`你 ${dateLabel(memory.createdAt)}说过：`, quoted, '。这一格是按这条填的。');
      const acts = document.createElement('div');
      acts.className = 'acts';

      for (const [action, label] of [['edit', '改一下'], ['once', '这次不用'], ['forget', '忘掉']] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.textContent = label;

        if (action === 'forget') button.className = 'warn';
        button.onclick = () => void act(action, button);
        acts.appendChild(button);
      }

      pop.append(src, acts);
      shadow.appendChild(pop);
      place();
      addEventListener('pointerdown', onOutside, true);
      addEventListener('keydown', onKey, true);
      acts.querySelector('button')?.focus();
    };

    // 你自己改了这一格：以你的为准，记号消失。助手再填（脚本事件）不算。
    const onInput = (event: Event) => { if (event.isTrusted) remove(); };

    const observer = new ResizeObserver(place);
    const timer = setInterval(place, 500);

    function remove(): void {
      closePop();
      clearInterval(timer);
      observer.disconnect();
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
      field.removeEventListener('input', onInput, true);
      host.remove();
      marks.delete(field);
    }

    observer.observe(field);
    addEventListener('scroll', place, { capture: true, passive: true });
    addEventListener('resize', place, { passive: true });
    field.addEventListener('input', onInput, true);
    marks.set(field, remove);
    place();
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!isPageInteractionMessage(message) || message.type !== 'MEMORY_FIELD_MARK') return;
    const field = document.querySelector(`[${FIELD_ATTR}="${CSS.escape(message.token)}"]`);
    field?.removeAttribute(FIELD_ATTR);

    if (field instanceof HTMLElement) mark(field, message.memory);
    respond({ ok: field instanceof HTMLElement });
  });
  window.addEventListener('pagehide', () => { for (const remove of Array.from(marks.values())) remove(); });
}
