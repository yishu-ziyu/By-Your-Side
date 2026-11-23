import { isPageInteractionMessage } from '../../../shared/protocol.js';
import { LEAD_COLOR } from '../../../shared/cast.js';
import { findUniqueSource, resolveSource, documentIdentity } from './page-sources.js';
import { OVERLAY_ATTR } from '../shared/overlay.js';
import { GUIDE_DRAW_MS, GUIDE_ROUGHNESS, sketchFrame } from '../shared/rough/index.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const SHOW_MS = 1800;

const DRAW_MS = GUIDE_DRAW_MS;

const PEEK_FADE_MS = 160;

export function installSonarPinpoint(): void {
  let host: HTMLElement | null = null;
  let raf: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  const clear = () => {
    clearTimeout(timer);

    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = undefined;
    host?.remove();
    host = null;
  };

  let peekHost: HTMLElement | null = null;
  let peekRaf: number | undefined;

  function unpeek(): void {
    if (peekRaf !== undefined) cancelAnimationFrame(peekRaf);
    peekRaf = undefined;
    const leaving = peekHost;
    peekHost = null;

    if (!leaving) return;

    if (reduced.matches) { leaving.remove();

      return; }
    leaving.style.opacity = '0';
    setTimeout(() => leaving.remove(), PEEK_FADE_MS);
  }

  function showPeek(element: HTMLElement): void {
    unpeek();
    const hostEl = document.createElement('div');
    hostEl.setAttribute(OVERLAY_ATTR, 'cite-peek');
    hostEl.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:2147483646;opacity:0;transition:opacity ${PEEK_FADE_MS}ms ease-out`;
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;border-radius:6px;background:rgb(234 196 84 / .28);box-shadow:0 0 0 3px rgb(234 196 84 / .28)';
    shadow.append(box);
    document.documentElement.append(hostEl);
    peekHost = hostEl;

    const place = () => {
      const r = element.getBoundingClientRect();
      box.style.left = `${r.left - 2}px`;
      box.style.top = `${r.top - 2}px`;
      box.style.width = `${r.width + 4}px`;
      box.style.height = `${r.height + 4}px`;
      peekRaf = requestAnimationFrame(place);
    };

    place();
    requestAnimationFrame(() => { hostEl.style.opacity = '1'; });
  }

  function showCircle(element: HTMLElement): void {
    clear();
    host = document.createElement('div');
    host.setAttribute(OVERLAY_ATTR, 'sonar');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;opacity:1';
    const shadow = host.attachShadow({ mode: 'closed' });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', LEAD_COLOR);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
    shadow.append(svg);
    document.documentElement.append(host);

    const draw = () => {
      const r = element.getBoundingClientRect();

      if (r.width <= 0 || r.height <= 0) return;

      const outline = sketchFrame(
        { x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 },
        { seed: 42, roughness: GUIDE_ROUGHNESS },
      );

      path.setAttribute('d', outline.d);
    };

    draw();

    if (!reduced.matches) {
      const len = Math.ceil(path.getTotalLength());
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
      path.getBoundingClientRect();
      path.style.transition = `stroke-dashoffset ${DRAW_MS}ms ease-in-out`;
      path.style.strokeDashoffset = '0';
    }

    const follow = () => {
      draw();
      raf = requestAnimationFrame(follow);
    };

    raf = requestAnimationFrame(follow);

    timer = setTimeout(() => {
      if (!host) return;
      host.style.transition = 'opacity .2s ease-out';
      host.style.opacity = '0';
      timer = setTimeout(clear, 220);
    }, SHOW_MS);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!isPageInteractionMessage(message)) return;


    if (message?.type !== 'PINPOINT_DOM_TARGET') return;

    if (message.action === 'identity') { respond({ ok: true, ...documentIdentity() });

      return; }

    if (message.action === 'resolve') {
      const identity = documentIdentity();

      if (message.document !== identity.document || message.url !== identity.url) { respond({ ok: false, error: '请求的原页面已变化，未生成引用。' });

        return; }

      const source = findUniqueSource(message.query);
      respond(source ? { ok: true, source } : { ok: false, error: '没有唯一的原文位置，未生成引用。' });

      return;
    }

    if (message.action === 'peek') {
      const target = message.source ? resolveSource(message.source) : null;

      if (target) showPeek(target);
      else unpeek();
      respond({ ok: !!target || !message.source });

      return;
    }

    if (message.action !== 'reveal') return;
    unpeek();
    const element = resolveSource(message.source);

    if (!element) { respond({ ok: false, error: '原文已变化，请重新核对来源。' });

      return; }

    element.scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block: 'center' });
    showCircle(element);
    respond({ ok: true });
  });
  window.addEventListener('pagehide', () => { clear(); unpeek(); });
}
