import { installDragFeed } from "./drag-feed.js";
import { installGhostHud } from "./ghost-hud.js";
import { installMarginaliaTracker } from "./marginalia-tracker.js";
import { installNudge } from "./nudge.js";
import { installBrowseLog } from "./browse-log.js";
import { installFloatCard } from "./float-card.js";
import { installSonarPinpoint } from "./sonar-pinpoint.js";
import { installMemoryMark } from "./memory-mark.js";
import { installPushToTalkKeys } from "./ptt.js";
import { PTT_CAPSULE, PTT_LEVEL, PTT_WARM, READING_VOICE, type PttCapsuleAction, type ReadingVoiceMessage } from "../shared/ptt.js";
import { extensionAlive } from "./alive.js";
/** Selection → local reading conversation. UI only relays selection or reading records; never task/steer messages. */
import { createElement as icon, ArrowUp, Square, X, PanelRight, Lightbulb, Volume2, Ellipsis, Mic, Copy, Check, Pin, Sparkles, MessageCircleQuestion, Languages, SpellCheck, CircleHelp, BookOpenText } from 'lucide';
import { sanitizeAnswerHtml } from '../shared/answer-html.js';
import { clipSelection, isEditableTarget, EXPLAIN_PROMPT, SELECTION_BAR_KEY, READING_ALOUD_KEY, isSelectionBarOff, isReadingAloudOn, READING_CARD_SIZE_KEY, readReadingCardSize, type ReadingCardSize } from '../shared/ask-selection.js';
import { READING_CONTEXT_LIMIT, READING_SELECTION_LIMIT, type ReadingSource } from '../../../shared/reading.js';
import { readingBusy, type ReadingRecord } from '../shared/reading-state.js';
import { renderMarkdownHtml } from '../shared/markdown.js';
import { ASK_STYLES } from './ask-styles.js';
import { selectionSurrounding } from './selection-context.js';
import { createReadAloud } from './read-aloud.js';
import { syncColorTone } from '../shared/color-tone.js';

const HOST = 'data-sideagent-ask';

const RETIRED = 'data-sideagent-ask-retired';

interface SelectionSnapshot {
  source: ReadingSource;
  range: Range | null;
  rect: DOMRect;
}

function selectionLocation(range: Range): string {
  const path = (node: Node): number[] => {
    const result: number[] = [];
    while (node.parentNode) {
      result.push(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
      node = node.parentNode;
    }
    return result.reverse();
  };
  const location = JSON.stringify([path(range.startContainer), range.startOffset, path(range.endContainer), range.endOffset]);
  return location.length <= 2000 ? location : '';
}

function sameSelection(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
  if (!a || !b) return false;
  if (a.range && b.range) return a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset && a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset;
  return !!a.source.location && a.source.location === b.source.location;
}

export function selectionSnapshot(): SelectionSnapshot | null {
  const selection = getSelection();

  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return null;
  }

  if (isEditableTarget(selection.anchorNode?.parentElement ?? null) || isEditableTarget(selection.focusNode?.parentElement ?? null)) {
    return null;
  }

  const raw = selection.toString().trim();
  const text = clipSelection(raw);

  if (!text) {
    return null;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();

  if (!rect.width && !rect.height) {
    return null;
  }

  const surrounding = selectionSurrounding(range, raw, READING_CONTEXT_LIMIT);

  return { source: { text, surrounding, location: selectionLocation(range), truncated: raw.length > READING_SELECTION_LIMIT, tabId: 0, title: document.title, url: location.href }, range, rect };
}

/** 与样式宽度一致，用于判断正文旁是否放得下回答。 */
const CARD_WIDTH = 450;

/** 右下角能拉到多小；再小回答就只剩一条缝。 */
const CARD_MIN_WIDTH = 320;
const CARD_MIN_HEIGHT = 240;

const PLACE_MARGIN = 12;

/** 正文和回答之间留出的缝。 */
const BESIDE_GAP = 40;

/** 工具条和选区之间留一点气口；胶囊本身不再画三角。 */
const LENS_GAP = 6;

/** 「更多」里的常用提问；钉上的出现在工具条上。存的是 id，改文案不丢已钉的。 */
const PROMPTS = [
  { id: 'translate', label: '翻译', question: '把这段翻译成中文；本来就是中文就翻成英文。' },
  { id: 'define', label: '定义', question: '这段里的关键词是什么意思？' },
  { id: 'example', label: '举个例子', question: '举个例子' },
  { id: 'why', label: '为什么重要', question: '这段话为什么重要？' },
  { id: 'evidence', label: '证据是什么', question: '作者的证据是什么？' },
] as const;

const PROMPT_ICONS = {
  translate: Languages,
  define: SpellCheck,
  example: Sparkles,
  why: CircleHelp,
  evidence: BookOpenText,
};

/** 输入框下的快捷问题：从常用提问里取跟着读下去最常问的三个。 */
const QUICK_QUESTIONS = PROMPTS.filter(prompt => ['example', 'why', 'evidence'].includes(prompt.id));

const PINS_KEY = 'reading_bar_pins';

/** 一轮里换过段时，那轮上面引用原文的长度：认得出是哪一段就够。 */

/** 系统默认的双击间隔约 500ms，网页里多数连击在 400ms 内。 */
const MULTI_CLICK_MS = 420;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

function contentBlockOf(range: Range | null): Element | null {
  if (!range?.startContainer.isConnected) return null;
  const node = range.commonAncestorContainer;
  const parent = node instanceof Element ? node : node.parentElement;

  return parent?.closest('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,dd,dt,figcaption,td') ?? null;
}

function paints(style: CSSStyleDeclaration): boolean {
  const bg = style.backgroundColor;

  if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return true;

  if (style.backgroundImage && style.backgroundImage !== 'none') return true;

  return Boolean(style.boxShadow && style.boxShadow !== 'none');
}

/** 采样点上有没有正文块以外的可见内容。包住正文的整页容器不算，侧栏、广告、目录算。 */
function gutterOccupied(host: HTMLElement, block: Element, x: number, y: number): boolean {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === host || host.contains(el) || el === document.documentElement || el === document.body) continue;
    const style = getComputedStyle(el);

    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

    if (el.contains(block)) continue;
    const tag = el.tagName;

    if (tag === 'IMG' || tag === 'PICTURE' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IFRAME' || tag === 'SVG' || tag === 'OBJECT') return true;

    if (paints(style) || (el.textContent ?? '').trim()) return true;
  }

  return false;
}

function gutterBlank(host: HTMLElement, block: Element, region: { left: number; right: number; top: number; bottom: number }): boolean {
  const width = region.right - region.left;
  const height = region.bottom - region.top;

  if (width < 8 || height < 8) return false;
  const columns = [0.12, 0.5, 0.88].map(part => region.left + width * part);
  const rows = Math.min(6, Math.max(3, Math.round(height / 140)));

  for (let row = 0; row < rows; row++) {
    const y = region.top + height * ((row + 0.5) / rows);

    for (const x of columns) if (gutterOccupied(host, block, x, y)) return false;
  }

  return true;
}

/** 本页已装的那份网页脚本留下的存活检查（同一扩展的网页脚本共用这个 window）。 */
const BOOTED = '__sideagentContentAlive';

/**
 * 同一页面只装一份：网页在安装时正在加载，Chrome 按 manifest 装一份，background/reinject.ts 又补装一份，两份都连着扩展，
 * 胶囊、边缘光条、按键就都成了两份。旧的那份还连着就不再装；断开了（扩展重载、更新后）照常装，补装不受影响。
 */
const WORDS = new Intl.Segmenter('zh', { granularity: 'word' });

/**
 * 流式回答每来一段都会整段重画；按词切开正文，只给第 shown 个之后的词挂淡入，
 * 已经读到的字不会跟着闪。代码块不切，保留原样可复制。返回现在的总词数。
 */
function fadeNewWords(root: HTMLElement, shown: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('pre, code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  let count = 0;

  for (const text of texts) {
    const parts = [...WORDS.segment(text.data)].map(part => part.segment);
    const start = count;
    count += parts.length;
    if (count <= shown) continue;
    const fragment = document.createDocumentFragment();

    for (const [index, part] of parts.entries()) {
      if (start + index < shown || !part.trim()) {
        fragment.append(part);
        continue;
      }
      const word = document.createElement('span');
      word.className = 'fresh';
      word.textContent = part;
      fragment.append(word);
    }

    text.replaceWith(fragment);
  }

  return count;
}

function installedAlready(): boolean {
  const slot = window as unknown as Record<string, (() => boolean) | undefined>;
  let alive = false;

  try {
    alive = !!slot[BOOTED]?.();
  } catch {
    alive = false;
  }

  if (!alive) slot[BOOTED] = extensionAlive;

  return alive;
}

function boot(): void {
  if (window !== window.top || document.contentType !== 'text/html' || installedAlready()) {
    return;
  }

  installSonarPinpoint();
  installMemoryMark();
  installDragFeed();
  installMarginaliaTracker();
  installGhostHud();
  installNudge();
  installBrowseLog();
  installFloatCard();
  const previous = document.querySelector(`[${HOST}]`);
  previous?.setAttribute(RETIRED, '1');
  previous?.remove();
  const host = document.createElement('div');
  host.setAttribute(HOST, '1');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645';
  syncColorTone(host);
  const root = host.attachShadow({ mode: 'closed' });
  // 封闭的影子根让网页看到的焦点是一个普通 div：Claude 网页版这类「随处打字就聚焦自己输入框」的网站会把卡片里的按键抢走，所以按键不再冒泡出卡片。
  for (const type of ['keydown', 'keypress', 'keyup'] as const) host.addEventListener(type, event => event.stopPropagation());
  root.innerHTML = `<style>${ASK_STYLES}</style>
    <section class="surface" role="dialog" aria-label="划词阅读" hidden>
      <div class="bar" role="toolbar" aria-label="划词"><button class="icon ask" data-act="ask" data-tip="问这段" aria-label="问这段"></button><button class="icon" data-act="explain" data-tip="解释" aria-label="解释"></button><button class="icon" data-act="read" data-tip="朗读" aria-label="朗读" hidden></button><span class="pins"></span><button class="icon more" data-act="more" data-tip="更多问法" aria-label="更多问法" aria-haspopup="menu" aria-expanded="false"></button><span class="sep" aria-hidden="true"></span><button class="icon dismiss" data-act="dismiss" data-tip="关闭" aria-label="关闭"></button></div>
      <div class="bar-tip" id="toolbar-tip" role="tooltip" hidden></div>
      <div class="head" hidden><strong class="title"></strong><button class="icon small" data-act="close" aria-label="收起" title="收起"></button></div>
      <div class="messages" tabindex="0" aria-label="阅读问答" hidden></div>
      <div class="foot" hidden><span class="grow"></span><button type="button" class="icon" data-act="copy" aria-label="复制" title="复制"></button><button type="button" class="icon" data-act="speak" aria-label="朗读" title="朗读" hidden></button><button type="button" class="icon" data-act="answer-more" hidden aria-label="更多回答操作" title="更多回答操作" aria-haspopup="menu" aria-expanded="false"></button><button type="button" class="handoff" data-act="handoff" aria-label="继续聊天" title="继续聊天"></button></div>
      <div class="error" role="status" hidden></div>
      <form class="composer" hidden><textarea rows="1" maxlength="2000" aria-label="关于这段继续提问" placeholder="问这段…"></textarea><button type="button" class="depth" data-act="depth" aria-pressed="false" title="换成深度回答">快速回答</button><button class="send" type="submit" aria-label="发送问题" title="发送问题"></button></form>
      <div class="chips" role="group" aria-label="常用问题" hidden>${QUICK_QUESTIONS.map(prompt => `<button type="button" data-ask="${prompt.question}">${prompt.label}</button>`).join('')}</div>
      <div class="resize" title="拖动调整大小，双击恢复" aria-hidden="true"></div>
      <span class="tail" aria-hidden="true"></span>
    </section>
    <div class="menu" role="menu" aria-label="更多问法" hidden><button class="menu-action" role="menuitem" data-act="copy-selection"><span class="menu-action-icon menu-copy-icon" aria-hidden="true"></span>复制所选文字</button><div class="rule" role="separator"></div><div class="menu-label">更多问法</div>${PROMPTS.map(prompt => `<div class="menu-row"><span class="menu-glyph" aria-hidden="true"></span><button role="menuitem" data-prompt="${prompt.id}">${prompt.label}</button><button class="icon small pin" data-pin="${prompt.id}" aria-pressed="false" aria-label="固定到工具条" title="固定到工具条"></button></div>`).join('')}<div class="rule" role="separator"></div><button class="menu-action" role="menuitem" data-act="transfer"><span class="menu-action-icon menu-transfer-icon" aria-hidden="true"></span>在侧栏打开</button><div class="rule" role="separator"></div><div class="menu-label">自动显示</div><button role="menuitem" class="dim" data-act="mute-page">此页不再自动显示</button><button role="menuitem" class="dim" data-act="mute-all">所有网页不再自动显示</button></div>
    <div class="menu answer-menu" role="menu" aria-label="更多回答操作" hidden><button role="menuitem" data-act="deep">用深度回答重答</button><button role="menuitem" data-act="details">收起回答</button></div>
    <button class="restore" data-act="restore" hidden>继续阅读</button>`;
  document.documentElement.append(host);
  const el = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  el('[data-act="ask"]').append(icon(MessageCircleQuestion));
  el('[data-act="explain"]').append(icon(Lightbulb));
  el('[data-act="read"]').append(icon(Volume2));
  el('[data-act="more"]').append(icon(Ellipsis));
  el('[data-act="close"]').append(icon(X));
  el('[data-act="answer-more"]').append(icon(Ellipsis));
  el('[data-act="handoff"]').replaceChildren(icon(PanelRight), document.createTextNode('继续聊天'));
  el('.answer-menu [data-act="deep"]').prepend(icon(Sparkles));
  el('[data-act="dismiss"]').append(icon(X));
  el('[data-act="copy"]').prepend(icon(Copy));
  el('[data-act="copy"]').append(Object.assign(document.createElement('span'), { className: 'copy-label', textContent: '复制' }));
  el('[data-act="speak"]').prepend(icon(Volume2));
  el('.menu-copy-icon').append(icon(Copy));
  el('.menu-transfer-icon').append(icon(PanelRight));
  for (const [index, glyph] of [...root.querySelectorAll('.menu-glyph')].entries()) glyph.append(icon(PROMPT_ICONS[PROMPTS[index]!.id]));
  for (const pin of root.querySelectorAll('[data-pin]')) pin.append(icon(Pin));

  const surface = el('.surface');
  const bar = el('.bar');
  const barTip = el('.bar-tip');
  const head = el('.head');
  const resizeHandle = el('.resize');
  head.addEventListener('pointerdown', startDrag);
  head.addEventListener('pointermove', moveDrag);
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  head.addEventListener('lostpointercapture', endDrag);
  resizeHandle.addEventListener('pointerdown', startResize);
  resizeHandle.addEventListener('pointermove', moveResize);
  resizeHandle.addEventListener('pointerup', endResize);
  resizeHandle.addEventListener('pointercancel', endResize);
  resizeHandle.addEventListener('lostpointercapture', endResize);
  resizeHandle.addEventListener('dblclick', resetSize);
  const menu = el('.menu');
  const more = el('[data-act="more"]');
  const answerMore = el('[data-act="answer-more"]');
  const answerMenu = el('.answer-menu');
  const messages = el('.messages');
  const input = el<HTMLTextAreaElement>('textarea');
  const submit = el<HTMLButtonElement>('.send');
  const restore = el('.restore');
  const error = el('.error');
  const reader = createReadAloud(root);
  let barTipTimer: ReturnType<typeof setTimeout> | undefined;
  let barTipTarget: HTMLElement | null = null;
  let snapshot: SelectionSnapshot | null = null;
  let record: ReadingRecord | undefined;
  let opening: Promise<void> | null = null;
  let expanded = false;
  let visible = false;
  let sending = false;
  let pageMuted = false;
  let selectionVersion = 0;
  let lastFocus: HTMLElement | null = null;
  let pageUrl = location.href;
  let renderedThread = '';
  let renderedTurns = 0;

  const answers: Array<{
    turn: HTMLElement;
    question: HTMLElement;
    node: HTMLElement;
    summary: HTMLElement;
    meta: HTMLElement;
    metaKey: string;
    detailed: boolean;
    text: string;
    /** 已经显示过的词数：流式重画时只让后面新出来的词淡入。 */
    words: number;
  }> = [];

  /** 哪几轮是用深度模型答的；记录里只存最近一次的档位。 */
  const deepTurns = new Set<number>();

  const drafts = new Map<string, string>();
  /** 输入框左边的模型芯片：打字问时用快速还是深度。整页沿用，不随换段重置。 */
  let typedDepth: 'fast' | 'deep' = 'fast';
  /** 钉到工具条上的常用提问。 */
  let pins: string[] = [];
  /** 朗读默认不出现，只有用户在设置里主动开启后才进入工具条和回答卡。 */
  let aloudEnabled = false;
  let pinned = false;

  function hideBarTip(): void {
    clearTimeout(barTipTimer);
    barTip.hidden = true;
    barTipTarget?.removeAttribute('aria-describedby');
    barTipTarget = null;
  }

  function placeBarTip(target: HTMLElement): void {
    const targetRect = target.getBoundingClientRect();
    const tipRect = barTip.getBoundingClientRect();
    const center = targetRect.left + targetRect.width / 2;
    const left = clamp(center - tipRect.width / 2, 8, Math.max(8, innerWidth - tipRect.width - 8));
    const above = targetRect.top - tipRect.height - 9 >= 8;

    barTip.style.left = `${left}px`;
    barTip.style.top = `${above ? targetRect.top - tipRect.height - 9 : targetRect.bottom + 9}px`;
    barTip.style.setProperty('--tip-x', `${clamp(center - left, 12, Math.max(12, tipRect.width - 12))}px`);
    barTip.dataset.side = above ? 'top' : 'bottom';
  }

  function showBarTip(target: HTMLElement, immediate = false): void {
    clearTimeout(barTipTimer);
    barTipTarget?.removeAttribute('aria-describedby');
    barTipTarget = target;

    const reveal = () => {
      if (!target.isConnected || target.hidden || expanded || !target.dataset.tip) return;
      barTip.textContent = target.dataset.tip;
      barTip.hidden = false;
      target.setAttribute('aria-describedby', 'toolbar-tip');
      placeBarTip(target);
    };

    if (immediate) reveal();
    else barTipTimer = setTimeout(reveal, 160);
  }

  /**
   * 按住说话的这一次交流，只在页面里：按下时抓住的那段字（之后用户点别处、改选都不影响这一句问的是哪），
   * listening 是还按着，released 是松开后等回答接上。新的一次按下整个换掉旧的。previous：松开前卡片指着的那段，话没交给卡时指回去。
   */
  let voice: { phase: 'listening' | 'released'; target: SelectionSnapshot; heard: string; previous: SelectionSnapshot | null } | null = null;
  /** 光标陪着这张卡：从按住说话起，到卡收起为止。 */
  let companion = false;
  /** 正在念哪张卡的回答。 */
  let speakingThread = '';
  /** 用户正在滚动读正文：浮在正文上的卡片和光标先让开。 */
  let quiet = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let followTimer: ReturnType<typeof setInterval> | undefined;
  /** 按住说话时按 Esc 只取消这一次说话，不连带收起卡片。 */
  let swallowEscape = false;
  /** 卡开着时按下鼠标先不收：可能是去选另一段接着问，松开时没选中文字才收。 */
  let dismissOnUp = false;
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  /** 卡开着时新选中的一段：打字问时问的是它。 */
  let candidate: SelectionSnapshot | null = null;
  let pendingTurn: HTMLElement | null = null;
  /** 回答放在选区哪一边：打开时定一次，之后回答变长也不换边，免得跳位。右侧空白够放时不用这一边。 */
  let side: 'above' | 'below' | null = null;
  /** 用户把卡拖到别处后记着这一处：不再跟着选区走，滚动也不动。 */
  let manualPos: { left: number; top: number } | null = null;
  /** 用户拉过右下角后的大小：跨卡片沿用，存进本地。 */
  let manualSize: ReadingCardSize | null = null;
  /** 拉的过程中别的标签页存了新尺寸：松手且没拉动时再用，不打断手指。 */
  let pendingCardSize: ReadingCardSize | null = null;
  /** 已经写到卡上的大小：流式回答每次重绘时不重复改样式。 */
  let appliedSize: ReadingCardSize | null = null;
  let drag: { pointerId: number; startX: number; startY: number; left: number; top: number; moved: boolean } | null = null;
  let resize: { pointerId: number; startX: number; startY: number; left: number; top: number; width: number; height: number; moved: boolean } | null = null;
  const highlightName = `by-your-side-reading`;

  const highlights = (CSS as typeof CSS & {
    highlights?: Map<string, unknown>;
  }).highlights;

  const HighlightClass = (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;

  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `::highlight(${highlightName}) { background: rgba(242, 196, 56, .46); color: inherit; }`;
  document.documentElement.append(highlightStyle);

  const report = (message = '', informational = false) => {
    error.textContent = message;
    error.hidden = !message;
    error.classList.toggle('info', informational);
  };

  async function rpc(type: string, extra: Record<string, unknown> = {}): Promise<any> {
    const result = await chrome.runtime.sendMessage({ type, threadId: record?.threadId, ...extra });

    if (!result?.ok) {
      throw new Error(result?.error ?? '扩展断开了。刷新页面，再试一次。');
    }

    return result;
  }

  const rememberDraft = () => {
    if (record) {
      drafts.set(record.threadId, input.value);
    }
  };

  function closeMenu(): void {
    menu.hidden = true;
    answerMenu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    answerMore.setAttribute('aria-expanded', 'false');
  }

  function openMenu(button = more, sheet = menu): void {
    closeMenu();
    const anchor = button.getBoundingClientRect();
    sheet.hidden = false;
    const box = sheet.getBoundingClientRect();
    const below = anchor.bottom + 8 + box.height <= innerHeight - PLACE_MARGIN;
    sheet.style.left = `${clamp(anchor.right - box.width, PLACE_MARGIN, innerWidth - box.width - PLACE_MARGIN)}px`;
    sheet.style.top = `${below ? anchor.bottom + 8 : Math.max(PLACE_MARGIN, anchor.top - 8 - box.height)}px`;
    button.setAttribute('aria-expanded', 'true');
  }

  function animate(name: 'enter' | 'morph'): void {
    surface.classList.remove('enter', 'morph');
    void surface.offsetWidth;
    surface.classList.add(name);
  }

  function position(): void {
    if (!visible) {
      return;
    }

    const margin = PLACE_MARGIN;

    // 用户把卡拖走后，位置由他定：只把卡收在窗口内，不再跟着选区或滚动走。
    // 快捷键恢复的卡没有选区（snapshot 为空），手动位置仍然要能用。
    if (manualPos) {
      delete surface.dataset.tail;
      surface.dataset.place = 'manual';
      if (!manualSize) surface.style.maxHeight = `${innerHeight - margin * 2}px`;
      const box = surface.getBoundingClientRect();
      manualPos.left = clamp(manualPos.left, margin, Math.max(margin, innerWidth - box.width - margin));
      manualPos.top = clamp(manualPos.top, margin, Math.max(margin, innerHeight - box.height - margin));
      surface.style.left = `${manualPos.left}px`;
      surface.style.top = `${manualPos.top}px`;

      return;
    }

    // 按住说话问另一段时，卡片一按下就让到那段旁边：不压住用户刚选的字。
    const anchor = voice?.target ?? snapshot;

    if (!anchor) {
      // 快捷键恢复时没有选区：卡片留在原处，只保证窗口变过之后还在视口里。
      const box = surface.getBoundingClientRect();
      surface.style.left = `${clamp(box.left, margin, Math.max(margin, innerWidth - box.width - margin))}px`;
      surface.style.top = `${clamp(box.top, margin, Math.max(margin, innerHeight - box.height - margin))}px`;

      return;
    }

    const live = anchor.range?.startContainer.isConnected ? anchor.range : null;
    const r = live ? live.getBoundingClientRect() : anchor.rect;
    const lines = live ? [...live.getClientRects()].filter(line => line.width > 0 && line.height > 0) : [];
    const first = lines[0] ?? r;
    const last = lines.at(-1) ?? r;

    // 还没有回答时是一条贴着选区的胶囊：放在第一行上方，小三角指着它；上方放不下才放到最后一行下方。
    if (!expanded || (!record?.turns.length && voice?.phase !== 'released')) {
      surface.style.maxHeight = '';
      const box = surface.getBoundingClientRect();
      const above = first.top - LENS_GAP - box.height >= margin;
      const anchor = above ? first : last;
      const center = anchor.left + anchor.width / 2;
      const left = clamp(center - box.width / 2, margin, innerWidth - box.width - margin);
      const top = above ? first.top - LENS_GAP - box.height : clamp(last.bottom + LENS_GAP, margin, innerHeight - box.height - margin);
      surface.style.left = `${left}px`;
      surface.style.top = `${top}px`;
      surface.dataset.place = 'lens';
      surface.dataset.tail = above ? 'down' : 'up';
      surface.style.setProperty('--tail-x', `${clamp(center - left, 18, box.width - 18)}px`);
      surface.style.setProperty('--origin', `${clamp(center - left, 18, box.width - 18)}px ${above ? 'bottom' : 'top'}`);

      return;
    }

    delete surface.dataset.tail;

    // 这段滚出视口时卡片靠到右上角，滚回来再回到这段旁边：卡片始终对着能看见的那段，或者让开正文。
    pinned = r.bottom < 0 || r.top > innerHeight;

    const block = pinned ? null : contentBlockOf(anchor.range);
    const blockRect = block?.getBoundingClientRect();
    const cardWidth = surface.getBoundingClientRect().width || CARD_WIDTH;
    const roomy = !!blockRect && innerWidth - blockRect.right >= cardWidth + BESIDE_GAP + margin;
    const besideRegion = roomy && block && blockRect ? {
      left: blockRect.right + 1,
      right: innerWidth - 1,
      top: Math.max(0, Math.min(blockRect.top, r.top)),
      bottom: Math.min(innerHeight, Math.max(blockRect.bottom, r.top + Math.min(540, innerHeight - margin * 2))),
    } : null;
    // 正文右侧到窗口右边缘真是空白、并且放得下回答和两侧间距时，写在正文旁边；否则浮在选区下方。
    const beside = !pinned && !!besideRegion && !!block && gutterBlank(host, block, besideRegion);
    const room = { above: r.top - margin - 8, below: innerHeight - r.bottom - margin - 8 };
    side ??= room.below >= 220 || room.below >= room.above ? 'below' : 'above';
    if (!manualSize) {
      const cap = beside ? innerHeight - margin * 2 : pinned ? 540 : Math.max(220, room[side]);
      surface.style.maxHeight = `${Math.min(innerHeight - margin * 2, cap)}px`;
    }
    const box = surface.getBoundingClientRect();

    if (beside && blockRect) {
      surface.style.left = `${blockRect.right + BESIDE_GAP}px`;
      surface.style.top = `${clamp(first.top - 6, margin, innerHeight - box.height - margin)}px`;
      surface.style.setProperty('--origin', 'left top');
      surface.dataset.place = 'beside';

      return;
    }

    surface.dataset.place = pinned ? 'dock' : 'float';
    const left = pinned ? innerWidth - box.width - margin : clamp(r.left + r.width / 2 - box.width / 2, margin, innerWidth - box.width - margin);
    const bottomLimit = innerHeight - box.height - margin;
    const top = pinned ? margin : side === 'below' ? clamp(r.bottom + LENS_GAP, margin, bottomLimit) : clamp(r.top - box.height - LENS_GAP, margin, bottomLimit);
    surface.style.left = `${left}px`;
    surface.style.top = `${top}px`;
    surface.style.setProperty('--origin', pinned ? 'right top' : side === 'above' ? 'bottom center' : 'top center');
  }

  /** 把用户拉过的大小落到卡上；窗口变小只收显示，不改存着的尺寸。 */
  function applyManualSize(): void {
    if (!expanded || !manualSize) {
      if (!appliedSize) return;

      appliedSize = null;
      surface.classList.remove('resized');
      surface.style.removeProperty('width');
      surface.style.removeProperty('height');
      surface.style.removeProperty('max-height');

      return;
    }

    const margin = PLACE_MARGIN;
    // 窗口比最小尺寸还小时，先保证卡和右下角把手留在视口里。
    const maxWidth = Math.max(200, innerWidth - margin * 2);
    const maxHeight = Math.max(160, innerHeight - margin * 2);
    const width = clamp(manualSize.width, Math.min(CARD_MIN_WIDTH, maxWidth), maxWidth);
    const height = clamp(manualSize.height, Math.min(CARD_MIN_HEIGHT, maxHeight), maxHeight);

    if (appliedSize?.width === width && appliedSize.height === height) return;

    appliedSize = { width, height };
    surface.classList.add('resized');
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    surface.style.maxHeight = 'none';
  }

  function highlight(): void {
    const range = (voice?.target ?? snapshot)?.range;

    if (range && HighlightClass) {
      highlights?.set(highlightName, new HighlightClass(range));
    }
  }

  function show(keyboard = false): void {
    visible = true;
    surface.hidden = false;
    restore.hidden = true;

    if (!keyboard) animate('enter');
    position();
  }

  function hide(): void {
    const restoreFocus = Boolean(root.activeElement);
    rememberDraft();
    hideBarTip();
    closeMenu();
    visible = false;
    surface.hidden = true;
    restore.hidden = !record?.turns.length;
    highlights?.delete(highlightName);
    candidate = null;
    dismissOnUp = false;

    if (voice?.phase !== 'listening') endCompanion();

    if (restoreFocus && lastFocus?.isConnected) {
      lastFocus.focus({ preventScroll: true });
    }
  }

  /** 标题栏拖动整张卡：拖过就由用户定位置，不再跟着选区走。 */
  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || !expanded || drag || resize || (event.target as Element).closest('button')) return;

    const box = surface.getBoundingClientRect();
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: box.left, top: box.top, moved: false };
    surface.classList.add('dragging');
    surface.classList.remove('glide', 'receding');
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;

    drag.moved = true;
    manualPos = { left: drag.left + dx, top: drag.top + dy };
    position();
  }

  function endDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;

    drag = null;
    surface.classList.remove('dragging');
  }

  /** 右下角拉大小：从当前位置往外拉，拉过就不再自动贴回选区。 */
  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || !expanded || drag || resize) return;

    const box = surface.getBoundingClientRect();
    resize = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: box.left, top: box.top, width: box.width, height: box.height, moved: false };
    surface.classList.add('resizing');
    surface.classList.remove('glide', 'receding');
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveResize(event: PointerEvent): void {
    if (!resize || event.pointerId !== resize.pointerId) return;

    const dx = event.clientX - resize.startX;
    const dy = event.clientY - resize.startY;

    if (!resize.moved && Math.abs(dx) + Math.abs(dy) < 3) return;

    resize.moved = true;
    manualPos ??= { left: resize.left, top: resize.top };
    const margin = PLACE_MARGIN;
    const maxWidth = Math.max(200, innerWidth - margin * 2);
    const maxHeight = Math.max(160, innerHeight - margin * 2);
    manualSize = {
      width: clamp(resize.width + dx, Math.min(CARD_MIN_WIDTH, maxWidth), maxWidth),
      height: clamp(resize.height + dy, Math.min(CARD_MIN_HEIGHT, maxHeight), maxHeight),
    };
    applyManualSize();
    position();
  }

  function endResize(event: PointerEvent): void {
    if (!resize || event.pointerId !== resize.pointerId) return;

    const moved = resize.moved;
    resize = null;
    surface.classList.remove('resizing');

    if (moved && manualSize) {
      pendingCardSize = null;
      void chrome.storage.local.set({ [READING_CARD_SIZE_KEY]: manualSize }).catch(() => { /* 扩展刚重载 */ });
    }
    else if (pendingCardSize) {
      manualSize = pendingCardSize;
      pendingCardSize = null;
      applyManualSize();
      position();
    }
  }

  /** 双击右下角回到默认大小；拖动过的位置留着。 */
  function resetSize(event: MouseEvent): void {
    event.preventDefault();
    manualSize = null;
    resize = null;
    applyManualSize();
    void chrome.storage.local.remove(READING_CARD_SIZE_KEY).catch(() => { /* 扩展刚重载 */ });
    position();
  }

  function update(next: ReadingRecord): void {
    if (record?.threadId === next.threadId && record.updatedAt > next.updatedAt) {
      return;
    }

    record = next;

    if (next.handoffError) {
      report(next.handoffError);
    }
    else if (next.transferredConversationId) {
      report();
    }

    if (expanded) {
      render();
    }
  }

  const questionLabel = (question: string) => question === EXPLAIN_PROMPT ? '解释这段文字' : PROMPTS.find(prompt => prompt.question === question)?.label ?? question;
  const preset = (question: string) => question === EXPLAIN_PROMPT || PROMPTS.some(prompt => prompt.question === question);
  /** 卡片标题用这一问的动作名（解释、翻译…），自己打的问题统一叫「问这段」。 */
  const actionName = (question: string) => question === EXPLAIN_PROMPT ? '解释' : PROMPTS.find(prompt => prompt.question === question)?.label ?? '问这段';

  function metaButton(label: string, act: string, turn: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.act = act;
    button.dataset.turn = String(turn);
    button.textContent = label;

    return button;
  }

  function render(): void {
    const turns = record?.turns ?? [];
    const waiting = voice?.phase === 'released';
    const answering = expanded && (turns.length > 0 || waiting);
    const composing = expanded && !turns.length && !waiting;
    if (expanded) hideBarTip();
    surface.classList.toggle('expanded', expanded);
    surface.classList.toggle('composing', composing);
    applyManualSize();
    el('.bar').hidden = expanded;
    // 打字用的输入卡也能拖：标题栏一直留着，标题写「提问」。
    el('.head').hidden = !expanded;
    const hasAnswer = turns.some(turn => turn.answer.trim());
    el('.foot').hidden = !expanded || !hasAnswer;
    for (const action of ['copy', 'handoff']) el(`[data-act="${action}"]`).hidden = !hasAnswer;
    el('[data-act="read"]').hidden = !aloudEnabled;
    el('[data-act="speak"]').hidden = !hasAnswer || !aloudEnabled;
    answerMore.hidden = !hasAnswer;
    messages.hidden = !answering;
    // 生成中不露回答操作：写完才出现，卡片不会边写边跳高。
    surface.classList.toggle('live', turns.some(turn => turn.state === 'pending' || turn.state === 'streaming') || waiting);
    el('.composer').hidden = !expanded;
    el('.chips').hidden = !composing;

    if (!expanded) {
      position();

      return;
    }

    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 36;

    if (renderedThread !== record?.threadId || renderedTurns > turns.length) {
      messages.replaceChildren();
      answers.length = 0;
      deepTurns.clear();
      renderedThread = record?.threadId ?? '';
      renderedTurns = 0;
    }

    const corrected = record?.correctedTurns ?? [];
    const lastIndex = turns.length - 1;
    const sources = turns.map((_, index) => sourceOf(index));
    const waitingSource = waiting ? voice!.target.source.text : undefined;
    // 问过不止一段时，每段第一问上面引用它那段原文：旧回答留着自己的出处，新一轮引用新的一段。
    const several = turns.some(turn => !!turn.source) || new Set([...sources, ...(waitingSource ? [waitingSource] : [])]).size > 1;

    for (const [index, turn] of turns.entries()) {
      if (!answers[index]) {
        const wrapper = document.createElement('article');
        wrapper.className = 'turn';
        const question = document.createElement('div');
        question.className = 'question';
        const node = document.createElement('div');
        node.className = 'answer';
        node.id = `reading-answer-${index}`;
        const summary = document.createElement('div');
        summary.className = 'answer-summary';
        const meta = document.createElement('div');
        meta.className = 'meta';
        wrapper.append(question, summary, node, meta);
        messages.append(wrapper);
        // 回答默认整段显示：边听边看的内容写完后不缩成一句，用户自己点「收起」才收。
        answers.push({ turn: wrapper, question, node, summary, meta, metaKey: '', detailed: true, text: '', words: 0 });
      }

      const item = answers[index]!;
      const showsSource = index === 0 || (several && !!turn.source);
      setSourceQuote(item.turn, showsSource ? sources[index]! : '', index);
      const fixed = corrected.includes(index);
      item.question.replaceChildren(...turn.spoken ? [icon(Mic, { 'aria-label': '说的' })] : [], questionLabel(turn.question));
      // 第一问是解释、翻译这类动作时，标题已经说了，不再重复一行。
      item.question.hidden = index === 0 && preset(turn.question) && !corrected.includes(index);

      if (fixed) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = ' · 已按新要求回答';
        item.question.append(tag);
      }

      // 被改口停下的旧回答原样留着，新回答接在下面。
      const interrupted = turn.state === 'stopped' && corrected.includes(index + 1);

      if (item.text !== turn.answer) {
        item.node.innerHTML = sanitizeAnswerHtml(renderMarkdownHtml(turn.answer), { images: false });

        for (const anchor of item.node.querySelectorAll('a')) {
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
        }

        item.text = turn.answer;
        const live = turn.state === 'pending' || turn.state === 'streaming';
        item.words = live ? fadeNewWords(item.node, item.words) : 0;
      }

      item.node.classList.toggle('thinking', (turn.state === 'pending' || turn.state === 'streaming') && !turn.answer.trim());

      const first = [...item.node.children].find(child => !/^H[1-6]$/.test(child.tagName) && child.textContent?.trim()) ?? item.node.firstElementChild;
      const summaryText = (first?.textContent ?? item.node.textContent ?? '').trim();
      const sentenceEnd = summaryText.search(/[。！？]|[.!?](?=\s|$)/u);
      const summaryLimit = sentenceEnd >= 0 && sentenceEnd < 100 ? sentenceEnd + 1 : 100;
      const hasMoreText = summaryText.length > summaryLimit;
      const done = turn.state === 'done';
      const hasDetails = done && (item.node.childElementCount > 1 || hasMoreText || Boolean(first && first.tagName !== 'P'));
      // 摘要只用纯文字；原回答保留完整结构，收起时也不留下不可见的可聚焦链接。
      item.summary.textContent = summaryText.slice(0, summaryLimit) + (hasMoreText && summaryLimit === 100 ? '…' : '');
      item.summary.hidden = !hasDetails || item.detailed;
      item.node.hidden = hasDetails && !item.detailed;

      const deep = deepTurns.has(index) || (index === lastIndex && record?.depth === 'deep');
      const metaKey = [turn.state, turn.error ?? '', hasDetails, item.detailed, interrupted, deep, index === lastIndex, sending].join('|');

      if (metaKey !== item.metaKey) {
        item.metaKey = metaKey;
        const parts: Node[] = [];
        const say = (text: string, error = false) => {
          const span = document.createElement('span');
          span.className = error ? 'status err' : 'status';
          span.setAttribute('role', 'status');
          span.textContent = text;
          parts.push(span);
        };

        if (turn.state === 'pending' || turn.state === 'streaming') say('正在回答…');
        else if (turn.state === 'error') say(turn.error ?? '回答没有完成，可以重试。', true);
        else if (interrupted) say('已停在这里，按新要求接着答');
        else if (turn.state === 'stopped') say('已中止，内容已保留');

        if (hasDetails && index !== lastIndex) parts.push(metaButton(item.detailed ? '收起' : '展开全文', 'details', index));

        if (index === lastIndex && (turn.state === 'error' || turn.state === 'stopped')) parts.push(metaButton('重试', 'retry', index));


        item.meta.replaceChildren(...parts);
      }
      if (index === lastIndex) {
        const detailButton = el<HTMLButtonElement>('.answer-menu [data-act="details"]');
        detailButton.hidden = !hasDetails;
        detailButton.textContent = item.detailed ? '收起回答' : '展开全文';
        detailButton.dataset.turn = String(index);
        const deepButton = el<HTMLButtonElement>('.answer-menu [data-act="deep"]');
        deepButton.hidden = !done || deep;
        deepButton.disabled = sending;
        answerMore.hidden = !hasDetails && (!done || deep);
      }
    }

    renderedTurns = turns.length;
    renderWaitingTurn(several && waitingSource !== sources.at(-1) ? waitingSource! : '');

    if (atBottom) {
      messages.scrollTop = messages.scrollHeight;
    }

    const latestQuestion = turns.at(-1)?.question ?? '';
    el('.title').textContent = actionName(latestQuestion);
    const busy = readingBusy(record);
    // 生成中输入框有字时，按钮是改口；空着时才是停止。
    const stops = busy && !input.value.trim();
    const label = stops ? '停止回答' : busy ? '停止这条回答，按新问题重新回答' : '发送问题';
    submit.replaceChildren(icon(stops ? Square : ArrowUp));
    submit.setAttribute('aria-label', label);
    submit.title = label;
    submit.disabled = sending || (!busy && !input.value.trim());
    input.placeholder = turns.length ? '继续提问…' : '输入问题…';
    const handoff = el<HTMLButtonElement>('[data-act="handoff"]');
    handoff.disabled = busy || sending;
    const handoffLabel = record?.transferredConversationId ? '回到侧栏' : '继续聊天';
    handoff.replaceChildren(icon(PanelRight), document.createTextNode(handoffLabel));
    handoff.setAttribute('aria-label', handoffLabel);
    handoff.title = handoffLabel;
    const depth = el<HTMLButtonElement>('.depth');
    depth.textContent = typedDepth === 'deep' ? '深度回答' : '快速回答';
    depth.setAttribute('aria-pressed', String(typedDepth === 'deep'));
    depth.title = typedDepth === 'deep' ? '现在用深度回答，点一下换回快速回答' : '现在用快速回答，点一下换成深度回答';
    position();
    pushPointer();
  }

  /** 复制成功：图标换成对勾一会儿，不另弹提示。 */
  function flash(button: HTMLElement): void {
    const glyph = button.querySelector('svg');

    if (!glyph) return;
    glyph.replaceWith(icon(Check));
    button.dataset.copied = '1';
    button.setAttribute('aria-label', '已复制');
    setTimeout(() => {
      button.querySelector('svg')?.replaceWith(icon(Copy));
      delete button.dataset.copied;
      button.setAttribute('aria-label', '复制');
    }, 1200);
  }

  /** 回原文：跨得远时直接到，别让平滑滚动拖几秒；只在附近才用动画。 */
  function revealSource(node: Node | null | undefined): void {
    const element = node instanceof Element ? node : node?.parentElement;

    if (!element) return;
    const rect = element.getBoundingClientRect();
    const far = rect.bottom < -innerHeight || rect.top > innerHeight * 2;
    element.scrollIntoView({ block: 'center', behavior: far ? 'auto' : 'smooth' });
  }

  /** 工具条上「解释」「朗读」后面跟着用户钉上的常用提问，菜单里的图钉同步亮。 */
  function renderPins(): void {
    hideBarTip();
    el('.pins').replaceChildren(...PROMPTS.filter(prompt => pins.includes(prompt.id)).map(prompt => {
      const button = document.createElement('button');
      button.className = 'icon';
      button.dataset.prompt = prompt.id;
      button.dataset.tip = prompt.label;
      button.setAttribute('aria-label', prompt.label);
      button.append(icon(PROMPT_ICONS[prompt.id]));

      return button;
    }));

    for (const pin of root.querySelectorAll<HTMLElement>('[data-pin]')) {
      const on = pins.includes(pin.dataset.pin!);
      pin.setAttribute('aria-pressed', String(on));
      pin.setAttribute('aria-label', on ? '从工具条移除' : '固定到工具条');
      pin.title = on ? '从工具条移除' : '固定到工具条';
    }
    if (visible && !expanded) position();
  }


  /** 第 index 问针对哪段原文：往前最近一个换过段的轮次，没有就是卡片打开时那段。 */
  function sourceOf(index: number): string {
    const turns = record?.turns ?? [];

    for (let i = index; i >= 0; i--) {
      const own = turns[i]?.source;

      if (own) return own.text;
    }

    return record?.source.text ?? '';
  }

  function setSourceQuote(turn: HTMLElement, text: string, index?: number): void {
    let quote = turn.querySelector<HTMLElement>(':scope > .source');

    if (!text) {
      quote?.remove();

      return;
    }

    if (!quote) {
      quote = document.createElement('button');
      quote.setAttribute('type', 'button');
      quote.className = 'source';
      if (index !== undefined) { quote.dataset.act = 'source-turn'; quote.dataset.turn = String(index); }
      turn.prepend(quote);
    }

    quote.textContent = text;
    quote.title = text.slice(0, 400);
  }

  /** 松开后、回答接上前的那一轮：先写「听写中…」，听到后换成听到的话。不进记录，回答接上时换成真的一轮。 */
  function renderWaitingTurn(sourceText: string): void {
    if (voice?.phase !== 'released') {
      pendingTurn?.remove();
      pendingTurn = null;

      return;
    }

    if (!pendingTurn) {
      pendingTurn = document.createElement('article');
      pendingTurn.className = 'turn voice-pending';
      pendingTurn.innerHTML = '<div class="question"></div><div class="meta"><span class="status" role="status"></span></div>';
    }

    setSourceQuote(pendingTurn, sourceText);
    pendingTurn.querySelector('.question')!.replaceChildren(icon(Mic, { 'aria-label': '说的' }), voice.heard || '听写中…');
    pendingTurn.querySelector('.status')!.textContent = voice.heard ? '正在回答…' : '正在听写…';

    if (pendingTurn.parentElement !== messages || pendingTurn !== messages.lastElementChild) messages.append(pendingTurn);
  }

  /** 先在原地把胶囊变成输入框、拿到焦点，再去后台开阅读记录：选中后直接打字的那个字不能丢。 */
  function openReading(keyboard = false): Promise<void> {
    if (!snapshot) {
      return Promise.resolve();
    }

    const version = selectionVersion;
    const source = snapshot.source;
    rememberDraft();
    closeMenu();
    report();
    record = undefined;
    expanded = true;
    pinned = false;
    side = null;
    manualPos = null;
    drag = null;
    resize = null;
    lastFocus = document.activeElement instanceof HTMLElement && !host.contains(document.activeElement) ? document.activeElement : lastFocus;
    input.value = '';
    render();

    if (visible) animate('morph');
    else show(keyboard);
    highlight();
    input.focus({ preventScroll: true });

    const pending = rpc('reading_open', { source }).then(result => {
      if (version !== selectionVersion) {
        return;
      }

      record = result.record;
      const draft = drafts.get(record!.threadId);

      if (draft && !input.value) input.value = draft;
      render();
    });

    const tracked: Promise<void> = pending.finally(() => {
      if (opening === tracked) opening = null;
    });
    opening = tracked;

    return tracked;
  }

  /** 按住说话这句话对着哪段：按下时抓住的那段；卡开着时带上卡上最近一问。 */
  function voiceTarget(): { selection?: string; asked?: string; source?: { text: string; surrounding: string; location?: string; truncated?: boolean } } {
    const card = visible && expanded && record?.turns.length ? record : undefined;
    const target = voice?.target ?? selectionSnapshot() ?? (card ? snapshot : null);

    if (!target) return {};
    const asked = card?.turns.at(-1)?.question;

    // source 与 voiceAsk 发问时带的一样：后台判断去向的同时按它先写回答，拼出的问答才对得上。
    return { selection: target.source.text, source: { text: target.source.text, surrounding: target.source.surrounding, location: target.source.location, truncated: target.source.truncated }, ...(asked ? { asked: questionLabel(asked) } : {}) };
  }

  /** 说的话交给阅读卡：卡开着就接在这张卡里（换了段，这一轮带上新的一段）；没开就在这段旁边开卡。还在回答时就是改口。 */
  async function voiceAsk(question: string): Promise<void> {
    const exchange = voice;
    const target = exchange?.target ?? selectionSnapshot();

    // 等开卡的这段时间里用户可能又按住说话了：那时这一句作废，不能再提交、停掉新的回答。
    const stale = () => exchange ? voice !== exchange || exchange.phase === 'listening' : !!voice;

    if (stale()) throw new Error('又按住说话了。');

    if (opening) await opening.catch(() => {});

    if (!(visible && expanded && record)) {
      if (!target) throw new Error('没有选中的文字。');
      snapshot = target;
      selectionVersion++;
      await voiceOpen();
    }

    if (stale()) throw new Error('又按住说话了。');

    await send(question, false, true, 'fast', true, target?.source, () => {
      if (voice === exchange) voice = null;
    });

    if (record?.turns.at(-1)?.question !== question) throw new Error('没能交给阅读卡。');
  }

  /** 松开后马上在这段旁边展开卡片：先有引用和「听写中…」，不出现打字用的输入态。卡片从光标所在的位置长出来。 */
  function voiceOpen(): Promise<void> {
    if (!snapshot) return Promise.resolve();
    const version = selectionVersion;
    const source = snapshot.source;
    rememberDraft();
    closeMenu();
    report();
    record = undefined;
    expanded = true;
    pinned = false;
    side = null;
    manualPos = null;
    drag = null;
    resize = null;
    render();

    if (visible) animate('morph');
    else show();
    growFromCursor();
    highlight();

    const pending = rpc('reading_open', { source }).then(result => {
      if (version !== selectionVersion) return;
      record = result.record;
      render();
    });

    const tracked: Promise<void> = pending.finally(() => {
      if (opening === tracked) opening = null;
    });
    opening = tracked;

    return tracked;
  }

  function growFromCursor(): void {
    const tip = window.__sideagent?.cursorState?.();

    if (!tip || tip.hidden) return;
    const box = surface.getBoundingClientRect();
    surface.style.setProperty('--origin', `${Math.round(clamp(tip.x - box.left, 0, box.width))}px ${Math.round(clamp(tip.y - box.top, 0, box.height))}px`);
  }

  // ── 陪读：光标、高亮和卡片指着同一段字 ─────────────────────────────

  /** 光标该在哪：这段最后一行的末尾边上；这段不在视口里时靠在卡片左上角，不停在别的正文上；都没有就隐去。 */
  function pointerPoint(): { x: number; y: number } | null {
    const range = (voice?.target ?? snapshot)?.range;
    const live = range?.startContainer.isConnected && !range.collapsed ? range : null;
    const last = live ? [...live.getClientRects()].filter(line => line.width > 0 && line.height > 0).at(-1) : undefined;

    if (last && last.bottom > 0 && last.top < innerHeight && last.right > 0 && last.left < innerWidth) {
      return { x: Math.round(Math.min(last.right + 3, innerWidth - 12)), y: Math.round(last.bottom - 3) };
    }

    if (visible && expanded && !surface.hidden) {
      const box = surface.getBoundingClientRect();

      return { x: Math.round(Math.max(8, box.left - 4)), y: Math.round(box.top + 10) };
    }

    return null;
  }

  type CompanionPhase = 'listening' | 'transcribing' | 'thinking' | 'answering' | 'speaking' | 'idle';

  function companionPhase(): CompanionPhase | null {
    if (!companion) return null;

    if (voice?.phase === 'listening') return 'listening';

    if (voice) return voice.heard ? 'thinking' : 'transcribing';

    if (record && speakingThread === record.threadId) return 'speaking';
    const last = record?.turns.at(-1);

    if (last?.state === 'pending') return 'thinking';

    return last?.state === 'streaming' ? 'answering' : 'idle';
  }

  function pushPointer(fly = false): void {
    if (!companion) return;
    const phase = companionPhase();
    const said = phase === 'listening' || phase === 'transcribing' || phase === 'thinking' || phase === 'speaking' ? phase : null;
    const card = visible && expanded && !surface.hidden ? surface.getBoundingClientRect() : null;
    // 名牌避开卡片：卡片里是要读的回答，不能被挡住。
    window.__sideagent?.cursor?.companion?.({ point: pointerPoint(), voice: said, fly, quiet, ...(card ? { avoid: { x: card.x, y: card.y, width: card.width, height: card.height } } : {}) });
  }

  function endCompanion(): void {
    if (!companion) return;
    companion = false;
    voice = null;
    quiet = false;
    clearInterval(followTimer);
    surface.classList.remove('receding');

    // 卡收起了，念着的回答也停下。
    if (speakingThread) {
      speakingThread = '';
      void chrome.runtime.sendMessage({ type: 'ptt_capsule_action', action: 'hush' } satisfies PttCapsuleAction).catch(() => {});
    }

    window.__sideagent?.cursor?.companion?.(null);
  }

  /** 按住右 ⌥：有选中的字或开着的卡，就由光标来听，飞到这段末尾；否则交给底部胶囊。 */
  function companionStart(): boolean {
    if (retired()) return false;
    const live = selectionSnapshot();
    const card = visible && expanded && !!record?.turns.length;
    const target = live ?? (card ? snapshot : null);

    if (!target) return false;
    voice = { phase: 'listening', target, heard: '', previous: card ? snapshot : null };
    companion = true;
    closeMenu();

    // 划词工具条先收起：松开后在这里长成卡片。
    if (visible && !expanded) {
      visible = false;
      surface.hidden = true;
    }

    if (card && !sameSelection(target, snapshot)) {
      side = null;
      glide();
      position();
    }

    highlight();
    pushPointer(true);
    clearInterval(followTimer);
    // 图片晚加载、网页自己改排版时没有滚动事件，隔一会儿重量一次那段字的位置。
    followTimer = setInterval(() => pushPointer(), 300);

    return true;
  }

  function companionStop(): boolean {
    if (voice?.phase !== 'listening') return false;
    voice.phase = 'released';
    const target = voice.target;
    const onCard = visible && expanded && !!record?.turns.length;
    const moved = !sameSelection(target, snapshot);
    selectionVersion++;
    snapshot = target;

    if (onCard) {
      if (moved) {
        side = null;
        glide();
      }

      render();
    }
    else void voiceOpen().catch(err => report(err.message));
    pushPointer();

    return true;
  }

  function companionCancel(): void {
    if (voice?.phase !== 'listening') return;
    swallowEscape = true;
    setTimeout(() => { swallowEscape = false; }, 0);
    retract();
  }

  /** 这句话没进卡（取消、交给了助手、没听清）：卡上没有回答就收起，有就指回原来那段。 */
  function retract(): void {
    if (!voice) return;
    const previous = voice.previous;
    voice = null;

    if (!(visible && expanded && record?.turns.length)) {
      hide();
      highlights?.delete(highlightName);
      endCompanion();

      return;
    }

    if (previous && !sameSelection(previous, snapshot)) snapshot = previous;
    side = null;
    glide();

    render();
    highlight();
    pushPointer(true);
  }

  /** 换到另一段时卡片滑过去，不瞬移。 */
  function glide(): void {
    surface.classList.add('glide');
    setTimeout(() => surface.classList.remove('glide'), 320);
  }

  function recede(): void {
    if (!visible || !expanded) return;
    quiet = true;
    // 拖走的卡片留在原处，但陪读光标和名牌仍要让开正文。
    if (!manualPos) surface.classList.toggle('receding', surface.dataset.place !== 'beside');
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quiet = false;
      surface.classList.remove('receding');
      pushPointer();
    }, 600);
  }

  /** correction 只由输入框和说话发出（打字后回车、点发送、按住说话）：再点一次「解释」不算改口。spoken：说出来的，回答会被念出来。 */
  async function send(question: string, retry = false, correction = false, depth: 'fast' | 'deep' = 'fast', spoken = false, source?: ReadingSource, accepted?: () => void): Promise<void> {
    if (opening) await opening.catch(() => {});

    if (!record || sending || !question.trim()) {
      return;
    }

    const threadId = record.threadId;
    sending = true;
    report();
    render();

    try {
      const result = await rpc('reading_send', { question, retry, correction, depth, spoken, ...(source ? { source: { text: source.text, surrounding: source.surrounding, location: source.location, truncated: source.truncated } } : {}) });

      if (record?.threadId !== threadId) {
        return;
      }

      accepted?.();
      update(result.record);
      const index = (record?.turns.length ?? 1) - 1;

      if (depth === 'deep') deepTurns.add(index);
      else deepTurns.delete(index);

      // 说出来的问题不碰输入框里打了一半的字。
      if (!spoken && record?.turns.at(-1)?.state !== 'error') {
        input.value = '';
        rememberDraft();
      }
    }
    catch (err) {
      report(String(err instanceof Error ? err.message : err));
    }
    finally {
      sending = false;
      render();
    }
  }

  /** 打字问：卡开着时新选了一段，问的就是那一段，接在同一张卡里。 */
  function typed(question: string): Promise<void> {
    const next = candidate;

    if (!next || !question.trim()) return send(question, false, readingBusy(record), typedDepth);
    return send(question, false, readingBusy(record), typedDepth, false, next.source, () => {
      if (candidate === next) candidate = null;
      snapshot = next;
      side = null;
      glide();
      highlight();
    });
  }

  bar.addEventListener('pointerover', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-tip]');
    const related = event.relatedTarget;

    if (!button || (related instanceof Node && button.contains(related))) return;
    showBarTip(button);
  });
  bar.addEventListener('pointerout', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-tip]');
    const related = event.relatedTarget;

    if (!button || (related instanceof Node && button.contains(related))) return;
    hideBarTip();
  });
  bar.addEventListener('focusin', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-tip]');

    if (button) showBarTip(button, true);
  });
  bar.addEventListener('focusout', hideBarTip);

  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-act],[data-ask],[data-prompt],[data-pin]');

    if (!target) {
      return;
    }

    hideBarTip();
    const action = target.dataset.act;
    const quick = target.dataset.ask ?? PROMPTS.find(prompt => prompt.id === target.dataset.prompt)?.question;
    const pin = target.dataset.pin;

    void (async () => {
      report();

      if (pin) {
        await chrome.storage.local.set({ [PINS_KEY]: pins.includes(pin) ? pins.filter(id => id !== pin) : [...pins, pin] });
      }
      else if (quick) {
        closeMenu();

        // 从工具条或菜单点的：卡还没展开就先在原地展开，和「解释」一样。
        if (!expanded) await openReading();
        await send(quick);
      }
      else if (action === 'ask') {
        await openReading();
      }
      else if (action === 'explain') {
        const opened = openReading();
        await opened;
        await send(EXPLAIN_PROMPT);
      }
      else if (action === 'more') {
        if (menu.hidden) openMenu();
        else closeMenu();
      }
      else if (action === 'answer-more') {
        if (answerMenu.hidden) openMenu(answerMore, answerMenu);
        else closeMenu();
      }
      else if (action === 'read') {
        // 朗读只在本页用浏览器声音出声，不发起任何阅读或页面任务。
        const current = snapshot;
        hide();

        if (current) {
          await reader.start(current.source.text, current.range);
        }
      }
      else if (action === 'close' || action === 'dismiss') {
        hide();
      }
      else if (action === 'copy-selection' || action === 'copy') {
        const text = action === 'copy' ? answers.at(-1)?.node.innerText ?? '' : snapshot?.source.text ?? '';

        await navigator.clipboard.writeText(text);
        flash(target);

        if (action === 'copy-selection') setTimeout(hide, 500);
      }
      else if (action === 'speak') {
        const text = answers.at(-1)?.node.innerText ?? '';

        if (text) await reader.start(text, null);
      }
      else if (action === 'depth') {
        typedDepth = typedDepth === 'fast' ? 'deep' : 'fast';
        render();
      }
      else if (action === 'mute-page') {
        pageMuted = true;
        hide();
      }
      else if (action === 'mute-all') {
        hide();
        await chrome.storage.local.set({ [SELECTION_BAR_KEY]: false });
      }
      else if (action === 'restore') {
        const restored = await rpc('reading_get');

        if (!restored.record) {
          throw new Error('这段问答已过期。重新选中文字。');
        }

        record = restored.record;
        // 问过几段时接着问的是最近那段。
        const latest = [...record!.turns].reverse().find(turn => turn.source)?.source;
        snapshot ??= { source: latest ? { ...record!.source, ...latest } : record!.source, range: null, rect: new DOMRect(innerWidth - 400, 80, 0, 0) };
        expanded = true;
        render();
        show();
        highlight();
      }
      else if (action === 'details') {
        closeMenu();
        const item = answers[Number(target.dataset.turn)];

        if (item) item.detailed = !item.detailed;
        render();
      }
      else if (action === 'retry') {
        const index = Number(target.dataset.turn);
        await send(record!.turns.at(-1)!.question, true, false, deepTurns.has(index) ? 'deep' : 'fast');
      }
      else if (action === 'deep') {
        closeMenu();
        await send(record!.turns.at(-1)!.question, false, false, 'deep');
      }
      else if (action === 'source-turn') {
        let located = false;
        const index = Number(target.dataset.turn);
        let source: Pick<ReadingSource, 'text' | 'surrounding' | 'location'> | undefined = record?.source;
        for (let i = 0; i <= index; i++) {
          const next = record?.turns[i]?.source;
          if (next) source = next;
        }
        if (source?.location) {
          try {
            const [start, startOffset, end, endOffset] = JSON.parse(source.location) as [number[], number, number[], number];
            const find = (path: number[]) => path.reduce<Node | undefined>((parent, child) => parent?.childNodes[child], document);
            const startNode = find(start), endNode = find(end);
            if (startNode && endNode) {
              const range = document.createRange();
              range.setStart(startNode, startOffset);
              range.setEnd(endNode, endOffset);
              if (clipSelection(range.toString().trim()) === source.text && selectionSurrounding(range, range.toString().trim(), READING_CONTEXT_LIMIT) === source.surrounding) {
                revealSource(startNode);
                located = true;
              }
            }
          } catch { /* 失效位置统一在引用旁提示。 */ }
        }
        if (!located) report('原文位置已变化，摘录仍保留。');
      }
      else if (action === 'transfer' || action === 'handoff') {
        closeMenu();

        if (action === 'transfer' || !record?.turns.length) {
          const source = snapshot?.source ?? record?.source;

          if (!source) throw new Error('先选中一段文字。');
          await rpc('ASK_SELECTION_TO_PANEL', { text: source.text });
          hide();

          return;
        }

        await rpc('reading_handoff');

        if (!record?.transferredConversationId) {
          report('正在转到侧栏…', true);
        }
      }
    })().catch(err => {
      report(err.message);

      if (!visible) {
        expanded = true;
        render();
        show();
      }
    });
  });
  // 点工具条和菜单不能清掉网页上的选区；输入框照常拿焦点。
  for (const part of [el('.bar'), menu, el('.chips'), el('.depth')]) part.addEventListener('pointerdown', event => event.preventDefault());
  el<HTMLFormElement>('.composer').addEventListener('submit', event => {
    event.preventDefault();

    if (readingBusy(record) && !input.value.trim()) {
      void rpc('reading_stop').then(result => update(result.record)).catch(err => report(err.message));
    }
    else {
      void typed(input.value);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(100, input.scrollHeight)}px`;
    rememberDraft();
    render();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      // 空回车在生成中什么也不做；有字就发出，生成中即改口。
      void typed(input.value);
    }
  });

  // 设置页的「划词工具条」开关：只管选中后自动弹出；⌘J 与右键菜单是用户主动发起，不受影响。
  let barEnabled = true;

  const applyBarSetting = (off: boolean) => {
    barEnabled = !off;

    if (!barEnabled && visible && !expanded) {
      hide();
    }
  };

  const applyAloudSetting = (on: boolean) => {
    aloudEnabled = on;
    el('[data-act="read"]').hidden = !on;
    if (!on) el('[data-act="speak"]').hidden = true;
    if (visible) render();
  };

  const applyPins = (value: unknown) => {
    pins = Array.isArray(value) ? value.filter((id): id is string => PROMPTS.some(prompt => prompt.id === id)) : [];
    renderPins();
  };

  const applyCardSize = (value: unknown) => {
    const next = readReadingCardSize(value);

    // 正在拉右下角时先记下，松手没拉动再用，不打断手指。
    if (resize) {
      pendingCardSize = next;

      return;
    }

    manualSize = next;
    if (visible) {
      applyManualSize();
      position();
    }
  };

  void chrome.storage.local.get([SELECTION_BAR_KEY, READING_ALOUD_KEY, PINS_KEY, READING_CARD_SIZE_KEY]).then(stored => {
    applyBarSetting(isSelectionBarOff(stored[SELECTION_BAR_KEY]));
    applyAloudSetting(isReadingAloudOn(stored[READING_ALOUD_KEY]));
    applyPins(stored[PINS_KEY]);
    applyCardSize(stored[READING_CARD_SIZE_KEY]);
  }).catch(() => {
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (retired()) {
      return;
    }

    if (area === 'local' && SELECTION_BAR_KEY in changes) {
      applyBarSetting(isSelectionBarOff(changes[SELECTION_BAR_KEY]!.newValue));
    }

    if (area === 'local' && READING_ALOUD_KEY in changes) applyAloudSetting(isReadingAloudOn(changes[READING_ALOUD_KEY]!.newValue));
    if (area === 'local' && PINS_KEY in changes) applyPins(changes[PINS_KEY]!.newValue);
    if (area === 'local' && READING_CARD_SIZE_KEY in changes) applyCardSize(changes[READING_CARD_SIZE_KEY]!.newValue);
  });

  function changedSelection(keyboard = false): void {
    const next = selectionSnapshot();

    // 选中以后常接着按住右 ⌥ 问这段：先让后台把听写连好，松开后少等一次握手。
    if (next) {
      void chrome.runtime.sendMessage({ type: PTT_WARM }).catch(() => {});
    }

    // 卡开着时选另一段不收起回答：记下这段，按住说话或打字问时就问它。
    if (visible && expanded && record?.turns.length) {
      if (next) {
        candidate = !sameSelection(next, snapshot) ? next : null;
        render();
      }

      return;
    }

    if (!barEnabled || pageMuted) {
      return;
    }

    if (!next || root.activeElement || sameSelection(next, snapshot) && visible) {
      return;
    }

    rememberDraft();
    selectionVersion++;
    snapshot = next;
    expanded = false;
    pinned = false;
    side = null;
    manualPos = null;
    closeMenu();
    report();
    render();
    show(keyboard);
  }

  // 扩展更新或重载后，后台给已打开的网页再装一份阅读卡（background/reinject.ts）。新的一份给旧宿主打上记号再删掉。
  // 旧的一份见到记号就撤掉自己的监听，不再接点击、选区和按键：否则用户点进新卡片时，旧卡片会收起并删掉两份共用的段落高亮。
  // 只认记号，不认宿主断开：有的网页会删掉 <html> 下的外来节点，那时这一份仍是网页里唯一的阅读卡。
  const listening = new AbortController();
  const { signal } = listening;
  const resizes = new ResizeObserver(position);

  function retired(): boolean {
    if (!host.hasAttribute(RETIRED)) {
      return false;
    }

    listening.abort();
    resizes.disconnect();
    clearInterval(navigationTimer);

    return true;
  }

  document.addEventListener('pointerdown', event => {
    if (retired()) return;
    clearTimeout(dismissTimer);
    dismissOnUp = false;

    if (event.composedPath().includes(host)) return;

    if (visible && expanded && record?.turns.length) dismissOnUp = true;
    else hide();
  }, { capture: true, signal });
  // 选字、按键只认用户真实输入：网页脚本伪造的事件不能弹出工具条、抢焦点、停掉本页的回答。
  document.addEventListener('pointerup', event => {
    if (event.isTrusted && !retired() && !event.composedPath().includes(host)) {
      setTimeout(() => {
        if (!dismissOnUp || selectionSnapshot()) {
          dismissOnUp = false;
          changedSelection();

          return;
        }

        // 双击、三击选字的第一下松开时还没有选区：过了连击间隔仍没选中文字才收。
        dismissTimer = setTimeout(() => {
          dismissOnUp = false;

          if (selectionSnapshot()) changedSelection();
          else hide();
        }, MULTI_CLICK_MS);
      }, 0);
    }
  }, { signal });
  document.addEventListener('keyup', event => {
    if (event.isTrusted && !retired() && (event.key === 'Shift' || event.key.startsWith('Arrow'))) {
      changedSelection(true);
    }
  }, { signal });
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || retired()) {
      return;
    }

    if (event.key === 'Escape') {
      if (swallowEscape) return;

      if (!menu.hidden || !answerMenu.hidden) closeMenu();
      else hide();

      return;
    }

    if (!visible || expanded || event.metaKey || event.ctrlKey || event.altKey || event.composedPath().includes(host) || isEditableTarget(event.target)) {
      return;
    }

    // 工具条开着时直接打字就是提问：先把焦点交给输入框，这个键的字（含输入法）随之落进去；网页自己的单键快捷键这一下不触发。
    const typing = (event.key.length === 1 && event.key !== ' ') || event.key === 'Process' || event.keyCode === 229;

    if (!typing) {
      return;
    }

    event.stopPropagation();
    void openReading(true).catch(err => report(err.message));
  }, { capture: true, signal });
  window.addEventListener('scroll', () => {
    if (retired()) {
      return;
    }

    hideBarTip();
    closeMenu();

    if (expanded) {
      position();
      recede();
    }
    else if (visible) {
      hide();
    }

    pushPointer();
  }, { capture: true, signal });
  const relayout = () => {
    if (!retired()) {
      hideBarTip();
      closeMenu();
      applyManualSize();
      position();
      pushPointer();
    }
  };
  window.addEventListener('resize', relayout, { signal });
  // 双指缩放只改可视视口，不触发 window 的 resize。
  visualViewport?.addEventListener('resize', relayout, { signal });
  visualViewport?.addEventListener('scroll', relayout, { signal });
  // 网页可以把指针捕获抢到宿主上：抬起事件到不了标题栏或把手时，在这里收尾，状态不留在拖动中。
  const endGestures = (event: PointerEvent) => {
    endDrag(event);
    endResize(event);
  };
  window.addEventListener('pointerup', endGestures, { capture: true, signal });
  window.addEventListener('pointercancel', endGestures, { capture: true, signal });
  resizes.observe(surface);
  window.addEventListener('pagehide', event => {
    if (event.isTrusted && !retired()) {
      void rpc('reading_leave').catch(() => {
      });
    }
  }, { signal });

  // SPA navigation has no content-script reinjection; release the old document UI.
  const navigation = () => {
    if (retired() || location.href === pageUrl) {
      return;
    }

    void rpc('reading_leave').catch(() => {
    });
    pageUrl = location.href;
    pageMuted = false;
    selectionVersion++;
    snapshot = null;
    record = undefined;
    expanded = false;
    manualPos = null;
    drag = null;
    resize = null;
    hide();
    restore.hidden = true;
  };

  window.addEventListener('popstate', navigation, { signal });
  const navigationTimer = setInterval(navigation, 1000);
  chrome.runtime.onMessage.addListener(raw => {
    if (retired()) {
      return;
    }

    if (raw?.type === 'reading_update' && raw.record?.threadId === record?.threadId) {
      update(raw.record);
    }

    if (raw?.type === 'ask-open' || raw?.type === 'ask-hotkey') {
      snapshot = selectionSnapshot();

      if (!snapshot && typeof raw.text === 'string' && clipSelection(raw.text)) {
        snapshot = { source: { text: clipSelection(raw.text)!, surrounding: '', truncated: raw.text.length > READING_SELECTION_LIMIT, tabId: 0, title: document.title, url: location.href }, range: null, rect: new DOMRect(200, 100, 0, 0) };
      }

      if (snapshot) {
        selectionVersion++;
        void openReading(true).catch(err => report(err.message));
      }
      else if (record) {
        expanded = true;
        render();
        show(true);
        input.focus();
      }
    }
  });
  chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
    if (raw?.type !== 'reading_voice_probe' && raw?.type !== 'reading_voice_ask') return;

    if (retired()) return;

    if (raw.type === 'reading_voice_probe') {
      respond(voiceTarget());

      return;
    }

    // 交不进卡时后台改交给助手，卡上不留错误。
    void voiceAsk(String(raw.question ?? '').trim()).then(() => respond({ ok: true }), () => respond({ ok: false }));

    return true;
  });
  chrome.runtime.onMessage.addListener((raw: { type?: unknown; capsule?: unknown; level?: unknown } | Partial<ReadingVoiceMessage> | undefined, sender) => {
    if (sender.id !== chrome.runtime.id || retired() || !raw) return;

    if (raw.type === PTT_LEVEL && 'level' in raw && typeof raw.level === 'number' && voice?.phase === 'listening') window.__sideagent?.cursor?.companionLevel?.(raw.level);

    // 底部胶囊出现了：这句话交给了助手，或没听清、没连上。卡片不再等它，光标也交还，助手要用它动手。
    if (raw.type === PTT_CAPSULE && 'capsule' in raw && raw.capsule && voice) {
      retract();
      endCompanion();
    }

    if (raw.type !== READING_VOICE || !('phase' in raw)) return;
    const message = raw as ReadingVoiceMessage;

    if (message.phase === 'heard' && voice?.phase === 'released') {
      voice.heard = message.text.trim();
      render();
    }
    else if (message.phase === 'speaking') speakingThread = message.threadId;
    else if (message.phase === 'quiet' && speakingThread === message.threadId) speakingThread = '';

    pushPointer();
  });

  installPushToTalkKeys({ start: companionStart, stop: companionStop, cancel: companionCancel });

  const ns = (window.__sideagent ??= {});
  ns.companionState = () => {
    const target = voice?.target ?? snapshot;
    const range = target?.range?.startContainer.isConnected ? target.range : null;
    const last = range ? [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0).at(-1) : undefined;
    const tip = ns.cursorState?.();
    const point = companion ? pointerPoint() : null;

    return {
      phase: companionPhase(),
      pointer: companion && tip ? { x: tip.x, y: tip.y, shown: !tip.hidden && !!point && !quiet } : null,
      target: companion && target ? {
        text: target.source.text,
        rect: last ? { x: last.x, y: last.y, width: last.width, height: last.height } : { x: 0, y: 0, width: 0, height: 0 },
        inView: !!last && last.bottom > 0 && last.top < innerHeight,
      } : null,
    };
  };

  void rpc('reading_get').then(result => {
    if (result.record && !record) {
      record = result.record;
      restore.hidden = !record?.turns.length;
    }
  }).catch(() => {
  });
}

boot();
