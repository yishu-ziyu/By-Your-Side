import { isPageInteractionMessage } from '../../../shared/protocol.js';
import { videoKey, type VoicePageCard, type VoicePageOp, type VoicePageReply, type VoicePageState } from '../../../shared/voice-page-op.js';

const NEXT_BUTTONS = ['.ytp-next-button', '.bpx-player-ctrl-next', '.bilibili-player-video-btn-next'];

const VIDEO_LINK = /\/watch\?|\/video\/|\/shorts\//;

const CARD_ROOTS = 'ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,yt-lockup-view-model,.bili-video-card,.bili-feed-card,.video-page-card-small';

const CARD_TITLES = '#video-title,h3,.bili-video-card__info--tit,.title';

const MAX_CARDS = 24;

const SEEK_TOLERANCE_S = 2;

function visibleArea(element: Element): number {
  const rect = element.getBoundingClientRect();

  return Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
}

function mainMedia(): HTMLMediaElement | null {
  const all = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).filter(media => media.currentSrc || media.src);
  const playing = all.filter(media => !media.paused && !media.ended);

  return (playing.length ? playing : all).sort((a, b) => visibleArea(b) - visibleArea(a))[0] ?? null;
}

function nextButton(): HTMLElement | null {
  for (const selector of NEXT_BUTTONS) {
    const button = document.querySelector<HTMLElement>(selector);

    if (button && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length > 0) return button;
  }

  return null;
}

function cardTitle(link: HTMLAnchorElement): string {
  const root = link.closest(CARD_ROOTS);
  const title = root?.querySelector(CARD_TITLES)?.textContent || link.title || link.getAttribute('aria-label') || link.querySelector('img')?.alt || '';

  return title.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 按屏幕位置排行列：DOM 顺序和用户看到的“第几行第几个”不一定一致。轮播图不算卡片。 */
function visibleCards(): VoicePageCard[] {
  const seen = new Set<string>();
  const found: Array<{ top: number; left: number; height: number; url: string; title: string }> = [];

  for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (!VIDEO_LINK.test(link.href) || link.closest('.recommended-swipe')) continue;
    const rect = link.getBoundingClientRect();

    if (rect.width < 120 || rect.height < 60 || rect.bottom <= 0 || rect.top >= innerHeight || rect.top < -rect.height / 2 || rect.left >= innerWidth || rect.right <= 0) continue;
    const key = videoKey(link.href);

    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ top: rect.top, left: rect.left, height: rect.height, url: link.href, title: cardTitle(link) });
  }

  found.sort((a, b) => a.top - b.top);
  const cards: VoicePageCard[] = [];
  let row = 0, rowTop = Number.NEGATIVE_INFINITY, rowItems: typeof found = [];
  const flush = () => { rowItems.sort((a, b) => a.left - b.left).forEach((item, index) => cards.push({ row, col: index + 1, title: item.title, url: item.url })); rowItems = []; };

  for (const item of found) {
    if (item.top - rowTop > item.height / 2) { flush(); row += 1; rowTop = item.top; }
    rowItems.push(item);
  }

  flush();

  return cards.slice(0, MAX_CARDS);
}

function pageState(): VoicePageState {
  const media = mainMedia();

  return {
    url: location.href,
    title: document.title.slice(0, 160),
    media: media ? { playing: !media.paused && !media.ended, currentTime: Math.round(media.currentTime), duration: Number.isFinite(media.duration) ? Math.round(media.duration) : null } : null,
    hasNext: !!nextButton(),
    cards: visibleCards(),
  };
}

const waitSeeked = (media: HTMLMediaElement) => new Promise<void>(done => {
  const timer = setTimeout(done, 800);

  media.addEventListener('seeked', () => { clearTimeout(timer); done(); }, { once: true });
});

async function perform(op: VoicePageOp): Promise<VoicePageReply> {
  const reply = (ok: boolean, message?: string): VoicePageReply => ({ ok, ...(message ? { message } : {}), state: pageState() });

  if (op.kind === 'state') return reply(true);

  if (op.kind === 'open') {
    // 回复要先发出去：跳转后页面脚本就没了。
    setTimeout(() => location.assign(op.url), 0);

    return reply(true);
  }

  if (op.kind === 'next') {
    const button = nextButton();

    if (!button) return reply(false, '这页没有下一个。');
    button.click();

    return reply(true);
  }

  const media = mainMedia();

  if (!media) return reply(false, '这页没有可以控制的视频。');

  if (op.kind === 'pause') {
    media.pause();

    return media.paused ? reply(true) : reply(false, '视频没有暂停。');
  }

  if (op.kind === 'play') {
    try { await media.play(); } catch { return reply(false, '浏览器不允许直接播放，请在页面上点一下。'); }

    return !media.paused ? reply(true) : reply(false, '视频没有开始播放。');
  }

  const target = Number.isFinite(media.duration) ? Math.min(op.seconds, media.duration) : op.seconds;
  const seeked = waitSeeked(media);
  media.currentTime = target;
  await seeked;

  return Math.abs(media.currentTime - target) <= SEEK_TOLERANCE_S ? reply(true) : reply(false, '视频没有跳到这个时间。');
}

export function installVoicePageOps(): void {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isPageInteractionMessage(message) || message.type !== 'VOICE_PAGE_OP') return;

    if (sender.id !== chrome.runtime.id || sender.tab) return;
    void perform(message.op).then(respond);

    return true;
  });
}
