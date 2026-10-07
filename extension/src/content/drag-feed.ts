import { isPageElementSource, type PageElementSource } from '../../../shared/protocol.js';
import { registerSelection, registerSource, resolveSource } from './page-sources.js';
import { extensionAlive } from './alive.js';

export const FEED_PREFIX = 'by-your-side-feed:';

/**
 * 把网页内容拖进侧栏。页面元素一律不设成可拖动，所以在正文里按住拖动始终是选字。
 * 两种拖法：选中任意文字后按住选区拖，材料就是选中的那段；表格和代码块悬停时左上角出把手，按住把手拖整块。
 */

const BLOCKS = 'table,pre';

const GRIP_SIZE = 24;

const GRIP_GAP = 6;

const HIDE_DELAY_MS = 250;

const GRIP_STYLE = `
:host{all:initial}
.grip{position:fixed;width:${GRIP_SIZE - 2}px;height:${GRIP_SIZE + 2}px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;
  border:1px solid #e3e1d9;border-radius:6px;background:#fff;color:#77756d;cursor:grab;z-index:2147483646;box-shadow:0 1px 3px rgba(20,20,19,.08);
  opacity:0;transform:translateX(4px);pointer-events:none;transition:opacity .15s,transform .2s cubic-bezier(.23,1,.32,1),background .15s,color .15s}
.grip.on{opacity:1;transform:none;pointer-events:auto}
.grip:hover{background:#eeece6;color:#2d4a86}
.grip:active{cursor:grabbing}
.grip svg{width:12px;height:14px;pointer-events:none}
@media (prefers-reduced-motion:reduce){.grip{transition:none}}`;

const DOTS = '<svg viewBox="0 0 12 14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="2" r="1.3"/><circle cx="9" cy="2" r="1.3"/><circle cx="3" cy="7" r="1.3"/><circle cx="9" cy="7" r="1.3"/><circle cx="3" cy="12" r="1.3"/><circle cx="9" cy="12" r="1.3"/></svg>';

const offer = (event: DragEvent, source: PageElementSource) => {
  const token = crypto.randomUUID();
  event.dataTransfer!.effectAllowed = 'copy';
  event.dataTransfer!.setData('application/x-by-your-side-feed', token);

  if (!event.dataTransfer!.getData('text/plain')) event.dataTransfer!.setData('text/plain', FEED_PREFIX + token);
  void chrome.runtime.sendMessage({ type: 'FEED_DROPPED_ELEMENT', action: 'offer', token, source }).catch(() => {});
};

const usable = (block: HTMLElement) => !block.closest('[data-bys-translation],[contenteditable]') && block.checkVisibility() && block.getBoundingClientRect().height >= GRIP_SIZE;

export function installDragFeed(): void {
  const host = document.createElement('div');
  host.setAttribute('data-bys-feed-grip', '');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = GRIP_STYLE;
  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.draggable = true;
  grip.setAttribute('role', 'button');
  grip.innerHTML = DOTS;
  root.append(style, grip);
  const pageStyle = document.createElement('style');
  pageStyle.textContent = '.bys-feed-dragging{opacity:.6;outline:2px dashed #2d4a86;outline-offset:3px}';
  document.documentElement.append(host, pageStyle);

  let current: HTMLElement | null = null;
  let dragging: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const place = () => {
    if (!current?.isConnected) return hide();
    const rect = current.getBoundingClientRect();
    grip.style.left = `${Math.max(2, rect.left - GRIP_SIZE - GRIP_GAP)}px`;
    grip.style.top = `${Math.max(2, rect.top + 4)}px`;
  };

  const show = (block: HTMLElement) => {
    clearTimeout(hideTimer);
    current = block;
    grip.title = block.matches('table') ? '按住拖整张表格到侧栏' : '按住拖整段代码到侧栏';
    grip.setAttribute('aria-label', grip.title);
    place();
    grip.classList.add('on');
  };

  function hide(): void {
    clearTimeout(hideTimer);
    grip.classList.remove('on');
    current = null;
  }

  document.addEventListener('mouseover', event => {
    if (dragging || event.buttons || !extensionAlive()) return;

    if (event.composedPath().includes(grip)) { clearTimeout(hideTimer);

      return; }

    const block = event.target instanceof Element ? event.target.closest<HTMLElement>(BLOCKS) : null;

    if (block && usable(block)) show(block);
    else if (current) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, HIDE_DELAY_MS); }
  }, { passive: true });
  addEventListener('scroll', () => { if (current) place(); }, { capture: true, passive: true });
  addEventListener('resize', () => { if (current) place(); }, { passive: true });

  grip.addEventListener('dragstart', event => {
    const block = current;
    const source = block ? registerSource(block, block.matches('table') ? 'table' : 'code') : null;

    if (!block || !source || !event.dataTransfer) { event.preventDefault();

      return; }

    event.dataTransfer.setData('text/plain', source.text);
    event.dataTransfer.setDragImage(block, 16, 16);
    offer(event, source);
    dragging = block;
    block.classList.add('bys-feed-dragging');
  });

  // 拖动已选中的文字：浏览器照常带上选中文字，我们只多附一个材料凭据。
  document.addEventListener('dragstart', event => {
    if (event.composedPath().includes(grip) || !event.dataTransfer) return;
    const selection = getSelection();
    const target = event.target instanceof Node ? event.target : null;

    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !target) return;
    const range = selection.getRangeAt(0);

    if (!range.intersectsNode(target)) return;
    const source = registerSelection(range);

    if (source) offer(event, source);
  }, true);

  document.addEventListener('dragend', () => { dragging?.classList.remove('bys-feed-dragging'); dragging = null; });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'FEED_DROPPED_ELEMENT' || message.action !== 'validate') return;
    respond({ ok: isPageElementSource(message.source) && !!resolveSource(message.source) });
  });
  window.addEventListener('pagehide', () => { hide(); dragging?.classList.remove('bys-feed-dragging'); });
}
