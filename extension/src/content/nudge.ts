import { NUDGE_ACT, NUDGE_AUTO_HIDE_MS, NUDGE_DISMISS, NUDGE_DWELL_MS, NUDGE_KEY, NUDGE_PAGE, NUDGE_SHOW, isNudgeCard, isNudgeOn, nudgeableUrl, type NudgeCard, type NudgePageMessage } from '../shared/nudge.js';
import { OVERLAY_ATTR } from '../shared/overlay.js';

/**
 * 主动建议卡（#52）的页面一半：开关打开时，这一页在前台停够 15 秒且用户滚动或选过文字，就把页面摘录报给后台；
 * 后台判断有建议时，页面右下角出一张小卡：一句话、一行出处、一个按钮、×。
 * 外观有意和右边缘的进度药丸不同（浅色卡、在右下角），免得把「建议」看成「任务进度」。
 */

const TICK_MS = 1000;

const RESEND_MS = 30_000;

const MIN_TEXT_CHARS = 100;

const STYLE = `
:host{all:initial}
.card{position:fixed;right:20px;bottom:20px;width:300px;box-sizing:border-box;padding:12px 14px 12px;border-radius:12px;pointer-events:auto;
  background:#fff;color:#1d1d1f;border:1px solid rgba(0,0,0,.1);box-shadow:0 10px 30px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;animation:in .22s cubic-bezier(.23,1,.32,1)}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
.head{display:flex;align-items:flex-start;gap:8px}
.sentence{flex:1;font-size:14px;font-weight:600;padding-top:1px}
.close{all:unset;flex:none;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;cursor:pointer;color:#86868b;font-size:16px;line-height:1}
.close:hover{background:rgba(0,0,0,.06);color:#1d1d1f}
.evidence{margin-top:4px;color:#6e6e73;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.action{all:unset;box-sizing:border-box;margin-top:10px;padding:5px 14px;border-radius:8px;cursor:pointer;background:#1d1d1f;color:#fff;font-weight:600}
.action:hover{background:#3a3a3c}
.close:focus-visible,.action:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
@media (prefers-color-scheme:dark){.card{background:#2c2c2e;color:#f5f5f7;border-color:rgba(255,255,255,.12)}.evidence{color:#a1a1a6}.close:hover{background:rgba(255,255,255,.1);color:#f5f5f7}.action{background:#f5f5f7;color:#1d1d1f}.action:hover{background:#d2d2d7}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}`;

/** 正文摘录：优先 article/main，没有就整页，压成一行后截到 4000 字。 */
function mainText(): string {
  const root = document.querySelector<HTMLElement>('article') ?? document.querySelector<HTMLElement>('main,[role=main]') ?? document.body;

  return (root?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

function selectedText(): string {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;

  if (!selection || selection.isCollapsed || element?.closest('input,textarea,[contenteditable]')) return '';

  return selection.toString().trim().slice(0, 2000);
}

export function installNudge(): void {
  if (!nudgeableUrl(location.href)) return;

  const host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, 'nudge');
  host.style.cssText = 'all:initial;position:fixed;inset:auto 0 0 auto;z-index:2147483645;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${STYLE}</style><div class="card" role="dialog" aria-label="By Your Side 建议"><div class="head"><div class="sentence"></div><button type="button" class="close" aria-label="关闭这条建议">×</button></div><div class="evidence"></div><button type="button" class="action"></button></div>`;
  const card = root.querySelector<HTMLElement>('.card')!;
  const sentence = root.querySelector<HTMLElement>('.sentence')!;
  const evidence = root.querySelector<HTMLElement>('.evidence')!;
  const action = root.querySelector<HTMLButtonElement>('.action')!;
  let shown: NudgeCard | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => { clearTimeout(hideTimer); shown = null; host.remove(); };

  const armHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, NUDGE_AUTO_HIDE_MS); };

  card.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  card.addEventListener('pointerleave', () => { if (shown) armHide(); });
  card.addEventListener('focusin', () => clearTimeout(hideTimer));
  action.addEventListener('click', () => { if (shown) void chrome.runtime.sendMessage({ type: NUDGE_ACT, id: shown.id }).catch(() => {}); hide(); });
  root.querySelector('.close')!.addEventListener('click', () => { if (shown) void chrome.runtime.sendMessage({ type: NUDGE_DISMISS, id: shown.id }).catch(() => {}); hide(); });

  const show = (next: NudgeCard) => {
    shown = next;
    sentence.textContent = next.sentence;
    const quote = `「${next.evidence}」`;
    evidence.textContent = next.source && next.source !== next.evidence ? `${quote} · ${next.source}` : quote;
    action.textContent = next.actionLabel;

    if (!host.isConnected) document.documentElement.append(host);
    armHide();
  };

  // 光标脚本第一次注入时会清掉页面上所有扩展浮层：卡片该显示时被清掉就挂回去。
  new MutationObserver(() => { if (shown && !host.isConnected) document.documentElement.append(host); }).observe(document.documentElement, { childList: true });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== NUDGE_SHOW) return;

    if (isNudgeCard(message.card)) show(message.card);
  });

  // 停留与动作：按网址计，换页（含单页应用换地址）重新计。
  let enabled = false;
  let url = location.href;
  let dwell = 0;
  let interacted = false;
  let viewReported = false;
  let sentInteracted = false;
  let done = false;
  let lastSent = 0;
  let inFlight = false;

  const markInteracted = () => { interacted = true; };

  addEventListener('scroll', markInteracted, { passive: true, capture: true });
  document.addEventListener('selectionchange', () => { if (selectedText()) interacted = true; });

  const report = () => {
    const text = mainText();

    if (text.length < MIN_TEXT_CHARS) { done = true;

 return; }

    const selection = selectedText();
    const message: NudgePageMessage = { type: NUDGE_PAGE, title: document.title, text, interacted };

    if (selection) message.selection = selection;
    inFlight = true; viewReported = true; sentInteracted = interacted; lastSent = Date.now();
    void chrome.runtime.sendMessage(message).then((reply: { again?: boolean } | undefined) => { if (!reply?.again) done = true; }, () => { /* 后台未就绪，下次再报 */ })
      .finally(() => { inFlight = false; });
  };

  setInterval(() => {
    if (!enabled) return;

    if (location.href !== url) { url = location.href; dwell = 0; interacted = false; viewReported = false; sentInteracted = false; done = false; lastSent = 0; hide(); }

    if (document.visibilityState !== 'visible') return;
    dwell += TICK_MS;

    if (done || inFlight || dwell < NUDGE_DWELL_MS) return;

    // 先报一次「看过」（记进最近看过的页）；用户动过手后再报一次请求判断；后台说冷却中就隔 30 秒再报。
    if (!viewReported || (interacted && (!sentInteracted || Date.now() - lastSent >= RESEND_MS))) report();
  }, TICK_MS);

  const apply = (on: boolean) => { enabled = on;

 if (!enabled) hide(); };

  void chrome.storage.local.get(NUDGE_KEY).then(stored => apply(isNudgeOn(stored[NUDGE_KEY])), () => {});
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && NUDGE_KEY in changes) apply(isNudgeOn(changes[NUDGE_KEY]!.newValue)); });
}
