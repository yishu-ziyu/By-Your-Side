import { isPageInteractionMessage, type GhostQuickAction, type GhostQuickReply } from '../../../shared/protocol.js';

/**
 * 侧栏直连按钮的页面一侧：直接操作页面已有的媒体、播放器自带的「下一个」按钮和代码块高度，不经模型。
 * 做完在页面正中浮起一枚提示，1.2 秒后淡出并删除。
 */

/** 只认播放器自带的「下一个」按钮；不猜网页上其他叫 Next 的链接。 */
const NEXT_BUTTONS = ['.ytp-next-button', '.bpx-player-ctrl-next', '.bilibili-player-video-btn-next'];

const TALL_CODE_PX = 240;

const FOLDED_CODE_PX = 120;

const HUD_MS = 1200;

const FOLD_STYLE = `pre[data-bys-code-folded]{max-height:${FOLDED_CODE_PX}px!important;overflow:hidden!important;-webkit-mask-image:linear-gradient(#000 60%,transparent);mask-image:linear-gradient(#000 60%,transparent)}`;

const HUD_STYLE = `
:host{all:initial}
.capsule{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:8px;padding:10px 22px;border-radius:99px;
  background:rgba(20,20,19,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.15);box-shadow:0 20px 48px rgba(0,0,0,.4);
  color:#fff;font:600 14px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;white-space:nowrap;pointer-events:none;z-index:2147483647;
  animation:hud-in-out ${HUD_MS}ms cubic-bezier(.23,1,.32,1) forwards}
.icon{color:#7ed99b}
.capsule.failed .icon{color:#f2b36b}
@keyframes hud-in-out{0%{opacity:0;transform:translate(-50%,-50%) scale(.92)}20%{opacity:1;transform:translate(-50%,-50%) scale(1)}75%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(.96)}}
@keyframes hud-fade{0%{opacity:0}20%{opacity:1}75%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.capsule{animation-name:hud-fade}}`;

function visibleArea(element: Element): number {
  const rect = element.getBoundingClientRect();
  const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));

  return width * height;
}

/** 正在播的优先，其次可见面积最大的视频，最后是页面里的音频。 */
function mainMedia(): HTMLMediaElement | null {
  const all = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).filter(media => media.currentSrc || media.src || media.querySelector('source'));
  const playing = all.filter(media => !media.paused && !media.ended);
  const pool = playing.length > 0 ? playing : all;

  return pool.sort((a, b) => visibleArea(b) - visibleArea(a))[0] ?? null;
}

function nextButton(): HTMLElement | null {
  for (const selector of NEXT_BUTTONS) {
    const button = document.querySelector<HTMLElement>(selector);

    if (button && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length > 0) return button;
  }

  return null;
}

const tallCode = () => Array.from(document.querySelectorAll<HTMLElement>('pre')).filter(pre => pre.scrollHeight > TALL_CODE_PX);

const foldedCode = () => Array.from(document.querySelectorAll<HTMLElement>('pre[data-bys-code-folded]'));

interface GhostState { playing: boolean; codeFolded: boolean }

function state(): GhostState {
  const media = mainMedia();

  return { playing: !!media && !media.paused && !media.ended, codeFolded: foldedCode().length > 0 };
}

function available(): GhostQuickAction[] {
  const actions: GhostQuickAction[] = [];

  if (mainMedia()) actions.push('toggle_play');

  if (nextButton()) actions.push('next');

  if (foldedCode().length > 0 || tallCode().length > 0) actions.push('toggle_code');

  return actions;
}

function ensureFoldStyle(): void {
  if (document.getElementById('bys-code-fold-style')) return;
  const style = document.createElement('style');
  style.id = 'bys-code-fold-style';
  style.textContent = FOLD_STYLE;
  document.documentElement.append(style);
}

/** 做动作，返回给用户看的结果。播放可能被浏览器的自动播放规则拒绝，如实说。 */
async function perform(action: GhostQuickAction): Promise<{ ok: boolean; icon: string; message: string; elapsedMs: number }> {
  const started = performance.now();
  const done = (ok: boolean, icon: string, message: string) => ({ ok, icon, message, elapsedMs: Math.round(performance.now() - started) });

  if (action === 'toggle_play') {
    const media = mainMedia();

    if (!media) return done(false, '⏯', '这页没有可以播放的内容');

    if (!media.paused && !media.ended) {
      media.pause();

      return done(true, '⏸', '已暂停');
    }

    const play = media.play();
    const result = done(true, '▶', '继续播放');

    try { await play; } catch { return done(false, '▶', '浏览器没让直接播放，请在页面上点一下'); }

    return result;
  }

  if (action === 'next') {
    const button = nextButton();

    if (!button) return done(false, '⏭', '这页没有「下一个」');
    button.click();

    return done(true, '⏭', '已切到下一个');
  }

  const folded = foldedCode();

  if (folded.length > 0) {
    for (const pre of folded) delete pre.dataset.bysCodeFolded;

    return done(true, '⇱', `已展开 ${folded.length} 段代码`);
  }

  const tall = tallCode();

  if (tall.length === 0) return done(false, '⇲', '这页没有长代码块');
  ensureFoldStyle();

  for (const pre of tall) pre.dataset.bysCodeFolded = '';

  return done(true, '⇲', `已折叠 ${tall.length} 段代码`);
}

let hud: { host: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

function showHud(icon: string, message: string, ok: boolean): void {
  if (hud) { clearTimeout(hud.timer); hud.host.remove(); }

  const host = document.createElement('div');
  host.setAttribute('data-bys-ghost-hud', '');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = HUD_STYLE;
  const capsule = document.createElement('div');
  capsule.className = ok ? 'capsule' : 'capsule failed';
  capsule.setAttribute('role', 'status');
  const iconEl = document.createElement('span');
  iconEl.className = 'icon';
  iconEl.textContent = icon;
  const text = document.createElement('span');
  text.textContent = message;
  capsule.append(iconEl, text);
  root.append(style, capsule);
  document.documentElement.append(host);

  const current = { host, timer: setTimeout(() => {
    host.remove();

    if (hud === current) hud = null;
  }, HUD_MS) };

  hud = current;
}

export function installGhostHud(): void {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isPageInteractionMessage(message) || message.type !== 'GHOST_QUICK_ACTION') return;

    // 只认扩展自己的页面（侧栏），不认别的网页脚本。
    if (sender.id !== chrome.runtime.id || sender.tab) return;

    if (message.action === 'probe') {
      respond({ ok: true, available: available(), ...state() } satisfies GhostQuickReply);

      return;
    }

    void perform(message.action).then(result => {
      showHud(result.icon, result.message, result.ok);
      respond({ ok: result.ok, message: result.message, elapsedMs: result.elapsedMs, ...state() } satisfies GhostQuickReply);
    });

    return true;
  });
}
