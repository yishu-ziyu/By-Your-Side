import type { MarginaliaMode, ViewportSectionUpdate } from '../../../shared/protocol.js';
import type { BgToPanel } from '../relay.js';

export function createMarginalia(select: HTMLSelectElement, rail: HTMLElement) {
  let page: { id: number; url: string } | null = null;
  let update: ViewportSectionUpdate | null = null;
  let frame = 0;
  let generation = 0;
  const card = document.createElement('aside');
  card.className = 'marginalia-card';
  const title = document.createElement('strong');
  const text = document.createElement('p');
  card.append(title, text); rail.append(card); rail.hidden = true;
  const mode = (): MarginaliaMode => select.value === 'ai' ? 'ai' : select.value === 'source' ? 'source' : 'off';

  const move = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!update) return;
      const travel = Math.max(0, rail.clientHeight - card.offsetHeight);
      // Native side-panel chrome takes the height difference; align to the page's visible point.
      rail.dataset.pageY = String(update.position * update.viewportHeight);
      rail.dataset.pageHeight = String(update.viewportHeight);
      const nativeHeader = update.viewportHeight - innerHeight;
      const target = update.position * update.viewportHeight - nativeHeader - rail.getBoundingClientRect().top - card.offsetHeight / 2;
      card.style.transform = `translateY(${Math.round(Math.max(0, Math.min(travel, target)))}px)`;
    });
  };

  const resize = new ResizeObserver(move);
  resize.observe(rail); resize.observe(card);

  const sync = async () => {
    const current = ++generation;
    update = null; rail.hidden = mode() === 'off';


    if (mode() !== 'off') { title.textContent = '伴读 · 正在寻找当前段落'; text.textContent = ''; }

    if (!page) return;

    try {
      const reply = await chrome.runtime.sendMessage({ type: 'VIEWPORT_ACTIVE_SECTION', action: 'track', tabId: page.id, mode: mode() });

      if (current !== generation) return;

      if (!reply?.ok && mode() !== 'off') { rail.hidden = false; title.textContent = '边注未启用'; text.textContent = reply?.error ?? '当前网页无法连接。'; }

    } catch { if (current !== generation) return;

    if (mode() !== 'off') { rail.hidden = false; title.textContent = '边注未启用'; text.textContent = '扩展连接已断开。'; } }
  };

  select.onchange = () => void sync();
  window.addEventListener('pagehide', () => {
    resize.disconnect();
    cancelAnimationFrame(frame);

    if (page) void chrome.runtime.sendMessage({ type: 'VIEWPORT_ACTIVE_SECTION', action: 'track', tabId: page.id, mode: 'off' }).catch(() => {});
  });

  return {
    refresh: () => void sync(),
    showConversation() { select.value = 'off'; void sync(); },
    setPage(next: { id: number; url: string }) {
      if (page?.id === next.id && page.url === next.url) return;

      if (page && page.id !== next.id) void chrome.runtime.sendMessage({ type: 'VIEWPORT_ACTIVE_SECTION', action: 'track', tabId: page.id, mode: 'off' }).catch(() => {});
      page = next; void sync();
    },
    receive(message: BgToPanel) {
      if (mode() === 'off' || !page) return;

      if (message.kind === 'page_section') {
        if (message.tabId !== page.id) return;
        update = message.update;

        if (!update || update.source.url !== page.url) { rail.hidden = true;

          return; }

        rail.hidden = false;
        title.textContent = `${mode() === 'ai' ? 'AI解释' : '原文摘录'} · 段落 ${update.index} · ${update.source.title}`;

        if (mode() === 'source') { text.textContent = update.source.text; text.title = update.source.text; }
        else if (card.dataset.source !== update.source.id) { text.textContent = '正在解释当前段落…'; card.dataset.state = 'pending'; }

        card.dataset.source = update.source.id;
        move();
      }

      if (message.kind === 'marginalia' && mode() === 'ai' && update && message.update.source.id === update.source.id && message.update.tabId === page.id && message.update.source.url === page.url) {
        card.dataset.state = message.state;
        text.textContent = message.text || (message.state === 'error' || message.state === 'stopped' ? '解释未完成，切换模式可重试。' : '正在解释当前段落…');
        text.title = text.textContent;
        move();
      }
    },
  };
}
