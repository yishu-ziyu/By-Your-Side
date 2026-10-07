import type { OrbState } from '../shared/voice-orb.js';
import { mountVoiceOrb } from '../shared/orb-style.js';
import { EDGE_PILL_OPEN } from '../shared/edge-pill.js';
import { OVERLAY_ATTR, OVERLAY_KIND_PTT_CAPSULE } from '../shared/overlay.js';
import { PTT_CAPSULE, PTT_LEVEL, type PttCapsule, type PttCapsuleAction } from '../shared/ptt.js';

/**
 * 按住说话的网页底部胶囊（#125 第 2 步，docs/evals/20261007-ptt-capsule.md）。
 * 光球旁只放一个状态词：在听 / 听写中 / 在做 / 等你 / 结果 / 已停下 / 没成。按住、听写中由按键直接驱动；
 * 之后的内容都由后台按真实事件推来。shadow root 关着，网页读不到听写的话；data-phase 只给验收看现在是哪一步。
 */

const BARS = 18;

/** 自动收起：结果给人读完的时间；需要你动手的（等你、可重发）不自动收。 */
const CLOSE_AFTER_MS: Partial<Record<PttCapsule['phase'], number>> = { done: 10_000, stopped: 4_000, failed: 6_000 };

const WORD: Record<PttCapsule['phase'], string> = { listening: '在听', transcribing: '听写中', doing: '在做', waiting: '等你', done: '结果', stopped: '已停下', failed: '没成' };

const ORB_STATE: Record<PttCapsule['phase'], OrbState> = { listening: 'listening', transcribing: 'thinking', doing: 'thinking', waiting: 'idle', done: 'idle', stopped: 'idle', failed: 'error' };

const STYLE = `
:host{all:initial}
.cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);box-sizing:border-box;display:flex;align-items:center;gap:12px;
  min-width:300px;max-width:min(560px,calc(100vw - 32px));padding:9px 12px 9px 9px;border-radius:24px;
  background:rgba(24,24,22,.92);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.12);
  box-shadow:0 18px 48px rgba(0,0,0,.34);color:#fff;font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;
  z-index:2147483647;animation:in .22s cubic-bezier(.23,1,.32,1)}
@keyframes in{from{opacity:0;transform:translate(-50%,8px) scale(.97)}}
canvas{width:36px;height:36px;flex:none}
.body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.line{display:flex;gap:8px;align-items:baseline;min-width:0}
.word{font-weight:600;flex:none}
.detail{color:rgba(255,255,255,.86);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.heard,.left{font-size:12px;-webkit-user-select:text;user-select:text;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.heard{color:rgba(255,255,255,.58)}
.left{color:rgba(255,255,255,.86)}
.left b{color:#f2c27b;font-weight:600}
.bars{display:flex;gap:3px;align-items:center;height:26px}
.bars i{width:3px;height:3px;border-radius:2px;background:rgba(255,255,255,.88);transition:height 90ms linear}
.side{display:flex;gap:6px;align-items:center;flex:none;color:rgba(255,255,255,.5);font-size:12px;white-space:nowrap}
kbd{border:1px solid rgba(255,255,255,.28);border-radius:5px;padding:0 5px;font:inherit;color:rgba(255,255,255,.8)}
button{all:unset;box-sizing:border-box;padding:5px 11px;border-radius:99px;background:rgba(255,255,255,.14);color:#fff;font-weight:600;cursor:pointer}
button:hover{background:rgba(255,255,255,.22)}
button.primary{background:#fff;color:#141413}
button.x{padding:4px 7px;background:transparent;color:rgba(255,255,255,.55);font-weight:400}
button.x:hover{color:#fff;background:rgba(255,255,255,.1)}
button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.cap{animation:none}.bars i{transition:none}}`;

const send = (action: PttCapsuleAction['action'], text?: string) => {
  const message: PttCapsuleAction = text ? { type: 'ptt_capsule_action', action, text } : { type: 'ptt_capsule_action', action };
  void chrome.runtime.sendMessage(message).catch(() => {});
};

export function createPttCapsule() {
  const host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_PTT_CAPSULE);
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${STYLE}</style><div class="cap" role="status" aria-live="polite"><canvas aria-hidden="true"></canvas>
<div class="bars" aria-hidden="true">${'<i></i>'.repeat(BARS)}</div>
<div class="body"><div class="line"><span class="word"></span><span class="detail"></span></div><div class="heard"></div><div class="left"><b>留给你的：</b><span></span></div></div>
<div class="side"></div></div>`;
  const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const cap = $<HTMLElement>('.cap');
  const canvas = $<HTMLCanvasElement>('canvas');
  const bars = [...root.querySelectorAll<HTMLElement>('.bars i')];
  const word = $<HTMLElement>('.word');
  const detail = $<HTMLElement>('.detail');
  const heard = $<HTMLElement>('.heard');
  const left = $<HTMLElement>('.left');
  const side = $<HTMLElement>('.side');

  let shown: PttCapsule | null = null;
  let level = 0;
  let peak = 0;
  let disposeOrb: (() => void) | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const levels: number[] = Array(BARS).fill(0);

  const drawLevel = (next: number) => {
    level = next;
    levels.push(next); levels.shift();
    // 中间高两边低：同一条音量历史左右对称地铺开。
    bars.forEach((bar, i) => {
      const fromCenter = Math.abs(i - (BARS - 1) / 2) / (BARS / 2);
      const height = 3 + 21 * levels[BARS - 1 - Math.floor(fromCenter * (BARS - 1))]! * (1 - fromCenter * 0.45);
      bar.style.height = `${height.toFixed(1)}px`;
      peak = Math.max(peak, height);
    });
    host.dataset.peak = peak.toFixed(1);
  };

  const button = (label: string, onClick: () => void, kind = '') => {
    const element = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: kind });
    element.addEventListener('click', onClick);

    return element;
  };

  const hide = (tell = true) => {
    if (!shown) return;
    shown = null;
    clearTimeout(closeTimer);
    disposeOrb?.(); disposeOrb = null;
    host.remove();
    delete host.dataset.phase;

    if (tell) send('closed');
  };

  const scheduleClose = () => {
    clearTimeout(closeTimer);
    const after = shown && CLOSE_AFTER_MS[shown.phase];

    // 可以重发的失败留着，等你决定。
    if (after && !(shown?.phase === 'failed' && shown.heard)) closeTimer = setTimeout(() => hide(), after);
  };

  cap.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  cap.addEventListener('pointerleave', scheduleClose);

  const show = (capsule: PttCapsule | null) => {
    if (!capsule) return hide(false);

    const fresh = !shown;
    shown = capsule;
    host.dataset.phase = capsule.phase;
    word.textContent = WORD[capsule.phase];
    $<HTMLElement>('.bars').hidden = capsule.phase !== 'listening';

    if (capsule.phase === 'listening' && fresh) { peak = 0; levels.fill(0); drawLevel(0); }
    const said = 'heard' in capsule ? capsule.heard ?? '' : '';
    heard.textContent = said ? `“${said}”` : '';
    heard.hidden = !said;
    detail.textContent = capsule.phase === 'doing' ? capsule.step ?? '交给助手了' : capsule.phase === 'waiting' ? capsule.reason
      : capsule.phase === 'done' ? capsule.result : capsule.phase === 'failed' ? capsule.reason : capsule.phase === 'transcribing' ? '…' : '';
    detail.hidden = !detail.textContent;
    left.hidden = !(capsule.phase === 'done' && capsule.left);
    left.querySelector('span')!.textContent = capsule.phase === 'done' ? capsule.left ?? '' : '';

    side.replaceChildren();

    if (capsule.phase === 'listening') side.innerHTML = '松开发送 · <kbd>Esc</kbd> 取消';

    if (capsule.phase === 'doing') side.append(button('停', () => send('stop')), Object.assign(document.createElement('kbd'), { textContent: 'Esc' }));

    if (capsule.phase === 'failed' && capsule.heard) { const text = capsule.heard; side.append(button('重发', () => send('resend', text), 'primary')); }

    if (capsule.phase === 'waiting' || capsule.phase === 'done') side.append(button('在侧栏看', () => { void chrome.runtime.sendMessage({ type: EDGE_PILL_OPEN }); }, capsule.phase === 'waiting' ? 'primary' : ''));

    if (capsule.phase !== 'listening' && capsule.phase !== 'transcribing') side.append(button('✕', () => hide(), 'x'));

    if (!host.isConnected) document.documentElement.append(host);

    if (!disposeOrb) disposeOrb = mountVoiceOrb(canvas, 36, () => shown ? ORB_STATE[shown.phase] : 'idle', () => shown?.phase === 'listening' ? level : 0);
    scheduleClose();
  };

  // 任务在跑时 Esc 停下；有结果时 Esc 收起。按住时的 Esc 由按键判定当作取消（ptt-keys.ts）。
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !shown) return;

    if (shown.phase === 'doing') send('stop');
    else if (shown.phase !== 'listening' && shown.phase !== 'transcribing') hide();
  }, true);

  // 光标脚本第一次注入时会清掉页面上所有扩展浮层：胶囊该显示时被清掉就挂回去。
  new MutationObserver(() => { if (shown && !host.isConnected) document.documentElement.append(host); }).observe(document.documentElement, { childList: true });

  chrome.runtime.onMessage.addListener((message: { type?: string; capsule?: PttCapsule | null; level?: number } | undefined, sender) => {
    if (sender.id !== chrome.runtime.id) return;

    if (message?.type === PTT_CAPSULE) show(message.capsule ?? null);

    if (message?.type === PTT_LEVEL && shown?.phase === 'listening' && typeof message.level === 'number') drawLevel(message.level);
  });

  return { show, hide: () => hide(false) };
}
