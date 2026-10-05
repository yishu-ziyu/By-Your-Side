import { EDGE_PILL_GET, EDGE_PILL_OPEN, EDGE_PILL_SHOW, type EdgePill } from '../shared/edge-pill.js';
import { OVERLAY_ATTR, OVERLAY_KIND_EDGE_PILL } from '../shared/overlay.js';

/**
 * 侧栏关着时页面右边缘的小药丸（#45）：平时只是一道细光，鼠标停上去展开成一张小卡，移开收回。
 * 只有药丸和卡片接住点击，其余地方不挡网页。
 */

const EXPAND_DELAY_MS = 250;

const COLLAPSE_DELAY_MS = 300;

const LABEL = { running: '正在做', paused: '已暂停 · 页面归你', error: '出错了，回侧栏看看' } as const;

const STYLE = `
:host{all:initial}
.wrap{position:fixed;right:0;top:50%;transform:translateY(-50%);display:flex;align-items:center;flex-direction:row-reverse;gap:10px;padding:10px 2px 10px 4px;
  pointer-events:auto;z-index:2147483646;font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
.pill{width:6px;height:40px;border-radius:99px;background:var(--c);box-shadow:0 0 0 1px rgba(255,255,255,.5),0 2px 8px rgba(0,0,0,.18);transition:height .2s cubic-bezier(.23,1,.32,1)}
.wrap[data-state=running]{--c:#0a84ff}
.wrap[data-state=paused]{--c:#ff9f0a}
.wrap[data-state=error]{--c:#ff453a}
.wrap[data-state=running] .pill{animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{0%,100%{box-shadow:0 0 0 1px rgba(255,255,255,.5),0 0 4px 0 color-mix(in srgb,var(--c) 40%,transparent)}50%{box-shadow:0 0 0 1px rgba(255,255,255,.5),0 0 14px 3px color-mix(in srgb,var(--c) 70%,transparent)}}
.card{display:none;width:240px;padding:12px 14px;border-radius:14px;background:rgba(20,20,19,.9);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border:1px solid rgba(255,255,255,.14);box-shadow:0 16px 40px rgba(0,0,0,.32);color:#fff}
.wrap.open .card{display:block;animation:in .18s cubic-bezier(.23,1,.32,1)}
.wrap.open .pill{height:56px}
@keyframes in{from{opacity:0;transform:translateX(6px)}}
.state{display:flex;align-items:center;gap:6px;font-weight:600}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c)}
.goal[hidden]{display:none}
.goal{margin-top:4px;color:rgba(255,255,255,.75);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
button{all:unset;box-sizing:border-box;margin-top:10px;width:100%;padding:6px 0;border-radius:8px;text-align:center;cursor:pointer;background:rgba(255,255,255,.14);color:#fff;font-weight:600}
button:hover{background:rgba(255,255,255,.22)}
button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.wrap[data-state=running] .pill,.wrap.open .card{animation:none}.pill{transition:none}}`;

export function installEdgePill(): void {
  const host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_EDGE_PILL);
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483646';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${STYLE}</style><div class="wrap" role="status"><div class="pill"></div><div class="card"><div class="state"></div><div class="goal"></div><button type="button">打开侧栏</button></div></div>`;
  const wrap = root.querySelector<HTMLElement>('.wrap')!;
  const state = root.querySelector<HTMLElement>('.state')!;
  const goal = root.querySelector<HTMLElement>('.goal')!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wanted = false;

  const setOpen = (open: boolean, delay: number) => {
    if (open === wanted) return;
    wanted = open; clearTimeout(timer);
    timer = setTimeout(() => { wrap.classList.toggle('open', open); host.dataset.open = String(open); }, delay);
  };

  // Agent 的点击会把浏览器的鼠标位置挪走、卡片收起；手一微动就要重新展开，所以听移动而不只是移入。
  wrap.addEventListener('pointermove', () => setOpen(true, EXPAND_DELAY_MS));
  wrap.addEventListener('pointerleave', () => setOpen(false, COLLAPSE_DELAY_MS));
  root.querySelector('button')!.addEventListener('click', () => { void chrome.runtime.sendMessage({ type: EDGE_PILL_OPEN }); });

  let shown: EdgePill = null;

  const show = (pill: EdgePill) => {
    shown = pill;

    if (!pill) { clearTimeout(timer); wanted = false; wrap.classList.remove('open'); host.dataset.open = 'false'; host.remove();

      return; }

    wrap.dataset.state = host.dataset.state = pill.state;
    state.textContent = LABEL[pill.state];
    goal.textContent = pill.goal;
    goal.hidden = !pill.goal;
    wrap.setAttribute('aria-label', `By Your Side ${LABEL[pill.state]}`);

    if (!host.isConnected) document.documentElement.append(host);
  };

  // 光标脚本第一次注入时会清掉页面上所有扩展浮层：药丸该显示时被清掉就立刻挂回去。
  new MutationObserver(() => { if (shown && !host.isConnected) document.documentElement.append(host); }).observe(document.documentElement, { childList: true });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === EDGE_PILL_SHOW) show(message.pill);
  });
  void chrome.runtime.sendMessage({ type: EDGE_PILL_GET }).then((reply: { pill?: EdgePill } | undefined) => show(reply?.pill ?? null), () => { /* 后台未就绪 */ });
}
