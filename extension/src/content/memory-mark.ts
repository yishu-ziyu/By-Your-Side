import { OVERLAY_ATTR } from '../shared/overlay.js';

/**
 * 按记忆填的那一格：淡蓝底、细边和「记得的」小标签（YIS-87，样子见 docs/previews/circle-and-memory）。
 * 画在页面上面的一层里，不改这一格的值和网页结构；你动手改了这一格，或这一格不在了，记号就消失。
 */
const FIELD_ATTR = 'data-sideagent-memory-field';

const STYLE = `
  .tint { position:fixed; box-sizing:border-box; pointer-events:none; background:rgba(45,74,134,.075); box-shadow:inset 0 0 0 1px rgba(45,74,134,.38); animation:in .25s ease both; }
  .tag { position:fixed; transform:translateY(-50%); display:inline-flex; align-items:center; gap:4px; pointer-events:auto; cursor:default;
    font:500 11px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif; color:#2d4a86; background:#fff;
    border:1px solid rgba(45,74,134,.38); border-radius:999px; padding:3px 7px; white-space:nowrap; animation:in .25s ease both; }
  .tag::before { content:""; width:6px; height:6px; border-radius:50%; background:#2d4a86; }
  @keyframes in { from { opacity:0; } }
  @media (prefers-reduced-motion: reduce) { .tint, .tag { animation:none; } }
`;

type MemoryFieldMark = { type: 'MEMORY_FIELD_MARK'; token: string; memory: { id: string; text: string; createdAt: number } };

function isMemoryFieldMark(value: unknown): value is MemoryFieldMark {
  if (!value || typeof value !== 'object') return false;
  // SAFETY: non-null object; every field used below is checked here.
  const message = value as Partial<MemoryFieldMark>;

  return message.type === 'MEMORY_FIELD_MARK' && typeof message.token === 'string' && message.token.length > 0 && message.token.length <= 80
    && !!message.memory && typeof message.memory.id === 'string' && typeof message.memory.text === 'string' && typeof message.memory.createdAt === 'number';
}

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
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '记得的';
    tag.title = `你 ${dateLabel(memory.createdAt)}说过：${memory.text}。这一格是按这条填的。`;
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
    };

    // 你自己改了这一格：以你的为准，记号消失。助手再填（脚本事件）不算。
    const onInput = (event: Event) => { if (event.isTrusted) remove(); };

    const observer = new ResizeObserver(place);
    const timer = setInterval(place, 500);

    function remove(): void {
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
    if (!isMemoryFieldMark(message)) return;
    const field = document.querySelector(`[${FIELD_ATTR}="${CSS.escape(message.token)}"]`);
    field?.removeAttribute(FIELD_ATTR);

    if (field instanceof HTMLElement) mark(field, message.memory);
    respond({ ok: field instanceof HTMLElement });
  });
  window.addEventListener('pagehide', () => { for (const remove of Array.from(marks.values())) remove(); });
}
