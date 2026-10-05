import type { PageInteractionMessage } from '../../../shared/protocol.js';
import { registerSource } from './page-sources.js';

export function installMarginaliaTracker(): void {
  let enabled = false;
  let frame = 0;
  let last = '';
  let url = location.href;
  let candidates: HTMLElement[] = [];
  const intersections = new Set<HTMLElement>();
  const send = (message: PageInteractionMessage) => void chrome.runtime.sendMessage(message).catch(() => {});
  const clear = () => { last = ''; send({ type: 'VIEWPORT_ACTIVE_SECTION', action: 'clear' }); };

  const measure = () => {
    frame = 0;

    if (!enabled) return;

    if (url !== location.href) { url = location.href; clear(); }

    const center = innerHeight / 2;

    const visible = Array.from(intersections).filter(element => candidates.includes(element) && element.isConnected && element.checkVisibility()).map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(item => item.rect.bottom > 0 && item.rect.top < innerHeight)
      .sort((a, b) => Math.abs((a.rect.top + a.rect.bottom) / 2 - center) - Math.abs((b.rect.top + b.rect.bottom) / 2 - center));

    const current = visible[0];

    if (!current) { if (last) clear();

      return; }

    const source = registerSource(current.element);

    if (!source) { if (last) clear();

      return; }

    const position = Math.max(0, Math.min(1, (current.rect.top + current.rect.bottom) / 2 / innerHeight));
    const next = `${source.id}:${source.text}:${position.toFixed(3)}`;

    if (last === next) return;
    last = next;
    send({ type: 'VIEWPORT_ACTIVE_SECTION', action: 'update', source, position, viewportHeight: innerHeight, index: candidates.indexOf(current.element) + 1 });
  };

  const schedule = () => { if (enabled && !frame) frame = requestAnimationFrame(measure); };

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;


      if (entry.isIntersecting) intersections.add(entry.target); else intersections.delete(entry.target);
    }


    schedule();
  }, { rootMargin: '-35% 0px -35% 0px', threshold: [0, 1] });

  const refresh = () => {
    observer.disconnect();
    intersections.clear();
    candidates = Array.from(document.querySelectorAll<HTMLElement>('section,h1,h2,h3,p,blockquote')).slice(0, 500);

    for (const element of candidates) observer.observe(element);
    schedule();
  };

  const changes = new MutationObserver(refresh);
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'VIEWPORT_ACTIVE_SECTION' || message.action !== 'track') return;
    enabled = message.enabled === true;
    observer.disconnect(); intersections.clear(); changes.disconnect(); cancelAnimationFrame(frame); frame = 0;
    last = '';

    if (enabled) { refresh(); changes.observe(document.body, { childList: true, subtree: true }); }
    else clear();
    respond({ ok: true });
  });
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('pagehide', () => { enabled = false; observer.disconnect(); changes.disconnect(); cancelAnimationFrame(frame); clear(); });
  send({ type: 'VIEWPORT_ACTIVE_SECTION', action: 'ready' });
}
