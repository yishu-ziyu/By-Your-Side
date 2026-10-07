import { LINK_PREVIEW_GET, LINK_PREVIEW_KEY, isLinkPreviewOff, previewableUrl, type LinkPreview } from '../shared/link-preview.js';
import { OVERLAY_ATTR } from '../shared/overlay.js';
import { extensionAlive } from './alive.js';

/**
 * Shift+悬停链接预览卡（#48）：按住 Shift 停在普通链接上约 300ms，链接下方出一张小卡，
 * 写目标页标题和 2–3 行要点。松开 Shift 或移开链接就收起；不拦点击、不开新标签。
 */

const SHOW_DELAY_MS = 300;

const LEAVE_GRACE_MS = 120;

const GAP = 8;

const WIDTH = 320;

const STYLE = `
:host{all:initial}
.card{position:fixed;width:${WIDTH}px;box-sizing:border-box;padding:12px 14px;border-radius:14px;pointer-events:auto;
  background:rgba(20,20,19,.9);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border:1px solid rgba(255,255,255,.14);box-shadow:0 16px 40px rgba(0,0,0,.32);color:#fff;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;animation:in .16s cubic-bezier(.23,1,.32,1)}
.card[hidden]{display:none}
@keyframes in{from{opacity:0;transform:translateY(-4px)}}
.host{color:rgba(255,255,255,.55);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.title{margin-top:2px;font-weight:600;font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.title:empty{display:none}
ul{margin:6px 0 0;padding:0;list-style:none}
li{position:relative;padding-left:12px;margin-top:4px;color:rgba(255,255,255,.8);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
li::before{content:"";position:absolute;left:2px;top:.6em;width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.5)}
.note{margin-top:4px;color:rgba(255,255,255,.7)}
.note:empty{display:none}
@media (prefers-reduced-motion:reduce){.card{animation:none}}`;

export function installLinkPreview(): void {
  const host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, 'link-preview');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${STYLE}</style><div class="card" role="tooltip" hidden><div class="host"></div><div class="title"></div><ul></ul><div class="note"></div></div>`;
  const card = root.querySelector<HTMLElement>('.card')!;
  const hostLine = root.querySelector<HTMLElement>('.host')!;
  const title = root.querySelector<HTMLElement>('.title')!;
  const list = root.querySelector<HTMLElement>('ul')!;
  const note = root.querySelector<HTMLElement>('.note')!;

  let enabled = true;
  let shift = false;
  let link: HTMLAnchorElement | null = null;
  let shownFor: HTMLAnchorElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;

  const hide = () => {
    clearTimeout(showTimer); clearTimeout(leaveTimer);
    request += 1; shownFor = null;
    card.hidden = true;
  };

  const urlOf = (a: HTMLAnchorElement) => {
    const url = previewableUrl(a.href);

    // 同一页的锚点跳转不预览。
    if (!url || url === previewableUrl(location.href)) return null;

    return url;
  };

  const place = (a: HTMLAnchorElement) => {
    const rect = a.getClientRects()[0] ?? a.getBoundingClientRect();
    const left = Math.max(GAP, Math.min(rect.left, innerWidth - WIDTH - GAP));
    card.style.left = `${left}px`;
    card.style.top = `${rect.bottom + GAP}px`;
    card.style.bottom = '';

    // 下方放不下就翻到链接上方。
    if (card.offsetHeight && rect.bottom + GAP + card.offsetHeight > innerHeight && rect.top - GAP - card.offsetHeight > 0) {
      card.style.top = '';
      card.style.bottom = `${innerHeight - rect.top + GAP}px`;
    }
  };

  const render = (a: HTMLAnchorElement, url: string, preview: LinkPreview | null) => {
    hostLine.textContent = new URL(url).hostname.replace(/^www\./, '');
    title.textContent = preview?.ok ? preview.title : '';
    list.replaceChildren(...(preview?.ok ? preview.lines : []).map(text => { const li = document.createElement('li'); li.textContent = text;

      return li; }));
    note.textContent = preview === null ? '正在读…' : preview.ok ? '' : '打不开预览';

    if (!host.isConnected) document.documentElement.append(host);
    card.hidden = false;
    place(a);
  };

  const show = (a: HTMLAnchorElement) => {
    const url = urlOf(a);

    if (!url) return;
    shownFor = a;
    const id = ++request;
    render(a, url, null);
    void chrome.runtime.sendMessage({ type: LINK_PREVIEW_GET, url }).then(
      (reply: LinkPreview | undefined) => { if (id === request) render(a, url, reply?.ok ? reply : { ok: false }); },
      () => { if (id === request) render(a, url, { ok: false }); },
    );
  };

  const arm = () => {
    clearTimeout(showTimer);

    if (!enabled || !shift || !link || shownFor === link || !urlOf(link)) return;
    const target = link;
    showTimer = setTimeout(() => { if (shift && link === target) show(target); }, SHOW_DELAY_MS);
  };

  document.addEventListener('pointerover', event => {
    const a = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;

    if (a === link) return;
    link = a;
    shift = event.shiftKey;

    clearTimeout(leaveTimer);

    if (shownFor && a !== shownFor) leaveTimer = setTimeout(hide, LEAVE_GRACE_MS);
    arm();
  }, true);

  // 指针从链接移到卡上时不收起，方便读完；离开卡就收起。
  card.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
  card.addEventListener('pointerleave', () => { if (link !== shownFor) leaveTimer = setTimeout(hide, LEAVE_GRACE_MS); });

  document.addEventListener('keydown', event => { if (event.key === 'Shift' && !shift && extensionAlive()) { shift = true; arm(); } }, true);
  document.addEventListener('keyup', event => { if (event.key === 'Shift') { shift = false; hide(); } }, true);
  // 点击照常导航，只把卡收起。
  document.addEventListener('pointerdown', event => { if (!event.composedPath().includes(card)) hide(); }, true);
  addEventListener('blur', () => { shift = false; hide(); });
  addEventListener('scroll', hide, { capture: true, passive: true });

  const apply = (off: boolean) => { enabled = !off;

 if (!enabled) hide(); };

  void chrome.storage.local.get(LINK_PREVIEW_KEY).then(stored => apply(isLinkPreviewOff(stored[LINK_PREVIEW_KEY])), () => { /* 读不到就按默认开启 */ });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && LINK_PREVIEW_KEY in changes) apply(isLinkPreviewOff(changes[LINK_PREVIEW_KEY]!.newValue));
  });
}
