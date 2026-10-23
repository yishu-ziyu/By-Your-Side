import { installDragFeed } from "./drag-feed.js";
import { installGhostHud } from "./ghost-hud.js";
import { installLinkPreview } from "./link-preview.js";
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
import { createElement as icon, ArrowUp, Square, X, PanelRight, Lightbulb, Volume2, Ellipsis, Mic } from 'lucide';
import { sanitizeAnswerHtml } from '../shared/answer-html.js';
import { clipSelection, isEditableTarget, EXPLAIN_PROMPT, SELECTION_BAR_KEY, isSelectionBarOff } from '../shared/ask-selection.js';
import { READING_CONTEXT_LIMIT, READING_SELECTION_LIMIT, type ReadingSource } from '../../../shared/reading.js';
import { readingBusy, type ReadingRecord } from '../shared/reading-state.js';
import { renderMarkdownHtml } from '../shared/markdown.js';
import { ASK_STYLES } from './ask-styles.js';
import { createReadAloud } from './read-aloud.js';
import { syncColorTone } from '../shared/color-tone.js';

const HOST = 'data-sideagent-ask';

const RETIRED = 'data-sideagent-ask-retired';

interface SelectionSnapshot {
  source: ReadingSource;
  range: Range | null;
  rect: DOMRect;
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

  const node = range.commonAncestorContainer;
  const parent = node instanceof Element ? node : node.parentElement;
  const paragraph = parent?.closest('p,li,pre,blockquote,h1,h2,h3,td');

  const surrounding = paragraph ? [paragraph.previousElementSibling, paragraph, paragraph.nextElementSibling]
    .flatMap((e): string[] => e instanceof HTMLElement && !isEditableTarget(e) && !e.querySelector('input,textarea,[contenteditable]') && e.checkVisibility() ? [e.innerText] : [])
    .join('\n').slice(0, READING_CONTEXT_LIMIT) : '';

  return { source: { text, surrounding, truncated: raw.length > READING_SELECTION_LIMIT, tabId: 0, title: document.title, url: location.href }, range, rect };
}

/** 与样式宽度一致，用于判断正文旁是否放得下回答。 */
const CARD_WIDTH = 340;

const PLACE_MARGIN = 12;

/** 正文和回答之间留出的缝。 */
const BESIDE_GAP = 40;

/** 工具条和选区之间的距离，小三角画在这段距离里。 */
const LENS_GAP = 10;

const QUICK_QUESTIONS = [['举个例子', '举个例子'], ['为什么重要？', '这段话为什么重要？'], ['证据是什么？', '作者的证据是什么？']] as const;

/** 卡片顶上引用原文的长度：认得出是哪一段就够。 */
const QUOTE_CHARS = 36;

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
  installLinkPreview();
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
  root.innerHTML = `<style>${ASK_STYLES}</style>
    <section class="surface" role="dialog" aria-label="划词阅读" hidden>
      <div class="bar" role="toolbar" aria-label="划词"><button class="ask" data-act="ask" title="选中后直接打字也能问">问<span class="caret" aria-hidden="true"></span></button><span class="sep" aria-hidden="true"></span><button data-act="explain">解释</button><button data-act="read">朗读</button><button class="icon more" data-act="more" aria-label="更多" title="更多" aria-haspopup="menu" aria-expanded="false"></button></div>
      <div class="head" hidden><span class="q quote"></span><button class="icon small" data-act="handoff" aria-label="在侧栏继续" title="在侧栏继续"></button><button class="icon small" data-act="close" aria-label="收起" title="收起"></button></div>
      <div class="messages" tabindex="0" aria-label="阅读问答" hidden></div>
      <div class="error" role="status" hidden></div>
      <form class="composer" hidden><textarea rows="1" maxlength="2000" aria-label="关于选中文字的问题" placeholder="问这段话…"></textarea><button class="send" type="submit" aria-label="发送问题" title="发送问题"></button></form>
      <div class="chips" role="group" aria-label="常用问题" hidden>${QUICK_QUESTIONS.map(([label, question]) => `<button type="button" data-ask="${question}">${label}</button>`).join('')}</div>
      <span class="tail" aria-hidden="true"></span>
    </section>
    <div class="menu" role="menu" aria-label="更多" hidden><button role="menuitem" data-act="transfer">在侧栏继续</button><div class="rule" role="separator"></div><button role="menuitem" class="dim" data-act="mute-page">这一页不再弹出</button><button role="menuitem" class="dim" data-act="mute-all">关闭划词工具条</button></div>
    <button class="restore" data-act="restore" hidden>继续阅读</button>`;
  document.documentElement.append(host);
  const el = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  el('[data-act="explain"]').prepend(icon(Lightbulb));
  el('[data-act="read"]').prepend(icon(Volume2));
  el('[data-act="more"]').append(icon(Ellipsis));
  el('[data-act="handoff"]').append(icon(PanelRight));
  el('[data-act="close"]').append(icon(X));

  const surface = el('.surface');
  const menu = el('.menu');
  const more = el('[data-act="more"]');
  const messages = el('.messages');
  const input = el<HTMLTextAreaElement>('textarea');
  const submit = el<HTMLButtonElement>('.send');
  const restore = el('.restore');
  const error = el('.error');
  const reader = createReadAloud(root);
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
  }> = [];

  /** 哪几轮是用深度模型答的；记录里只存最近一次的档位。 */
  const deepTurns = new Set<number>();

  const drafts = new Map<string, string>();
  let pinned = false;

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
    more.setAttribute('aria-expanded', 'false');
  }

  function openMenu(): void {
    const anchor = more.getBoundingClientRect();
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    const below = anchor.bottom + 8 + box.height <= innerHeight - PLACE_MARGIN;
    menu.style.left = `${clamp(anchor.right - box.width, PLACE_MARGIN, innerWidth - box.width - PLACE_MARGIN)}px`;
    menu.style.top = `${below ? anchor.bottom + 8 : Math.max(PLACE_MARGIN, anchor.top - 8 - box.height)}px`;
    more.setAttribute('aria-expanded', 'true');
  }

  function animate(name: 'enter' | 'morph'): void {
    surface.classList.remove('enter', 'morph');
    void surface.offsetWidth;
    surface.classList.add(name);
  }

  function position(): void {
    // 按住说话问另一段时，卡片一按下就让到那段旁边：不压住用户刚选的字。
    const anchor = voice?.target ?? snapshot;

    if (!visible || !anchor) {
      return;
    }

    const live = anchor.range?.startContainer.isConnected ? anchor.range : null;
    const r = live ? live.getBoundingClientRect() : anchor.rect;
    const lines = live ? [...live.getClientRects()].filter(line => line.width > 0 && line.height > 0) : [];
    const first = lines[0] ?? r;
    const last = lines.at(-1) ?? r;
    const margin = PLACE_MARGIN;

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
    const roomy = !!blockRect && innerWidth - blockRect.right >= CARD_WIDTH + BESIDE_GAP + margin;
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
    const cap = beside ? innerHeight - margin * 2 : pinned ? 540 : Math.max(220, room[side]);
    surface.style.maxHeight = `${Math.min(innerHeight - margin * 2, cap)}px`;
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

  const questionLabel = (question: string) => question === EXPLAIN_PROMPT ? '解释这段文字' : question;

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
    surface.classList.toggle('expanded', expanded);
    surface.classList.toggle('composing', composing);
    el('.bar').hidden = expanded;
    el('.head').hidden = !answering;
    messages.hidden = !answering;
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
    const several = new Set([...sources, ...(waitingSource ? [waitingSource] : [])]).size > 1;

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
        answers.push({ turn: wrapper, question, node, summary, meta, metaKey: '', detailed: true, text: '' });
      }

      const item = answers[index]!;
      setSourceQuote(item.turn, several && (index === 0 || sources[index] !== sources[index - 1]) ? sources[index]! : '');
      const fixed = corrected.includes(index);
      item.question.replaceChildren(...turn.spoken ? [icon(Mic, { 'aria-label': '说的' })] : [], questionLabel(turn.question));

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
      }

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

        if (hasDetails) parts.push(metaButton(item.detailed ? '收起' : '展开全文', 'details', index));

        if (index === lastIndex && (turn.state === 'error' || turn.state === 'stopped')) parts.push(metaButton('重试', 'retry', index));

        if (index === lastIndex && done) {
          const label = document.createElement('span');
          label.textContent = deep ? '深度回答' : '快速回答';
          parts.push(label);

          if (!deep) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.textContent = '·';
            parts.push(dot, metaButton('用深度模型重答', 'deep', index));
          }
        }

        item.meta.replaceChildren(...parts);
      }
    }

    renderedTurns = turns.length;
    renderWaitingTurn(several && waitingSource !== sources.at(-1) ? waitingSource! : '');

    if (atBottom) {
      messages.scrollTop = messages.scrollHeight;
    }

    // 顶上引用的是这张卡现在理解的那段原文：等回答时是刚按住时选的那段，换了选段就跟着换。
    const quoted = (waitingSource ?? sources.at(-1) ?? snapshot?.source.text ?? '').replace(/\s+/g, ' ').trim();
    const quote = el('.head .q');
    quote.textContent = quoteOf(quoted);
    quote.title = quoted.slice(0, 400);
    const busy = readingBusy(record);
    // 生成中输入框有字时，按钮是改口；空着时才是停止。
    const stops = busy && !input.value.trim();
    const label = stops ? '停止回答' : busy ? '停止这条回答，按新问题重新回答' : '发送问题';
    submit.replaceChildren(icon(stops ? Square : ArrowUp));
    submit.setAttribute('aria-label', label);
    submit.title = label;
    submit.disabled = sending || (!busy && !input.value.trim());
    input.placeholder = candidate ? '问刚选中的这段…' : turns.length ? '接着问…' : '问这段话…';
    const handoff = el<HTMLButtonElement>('[data-act="handoff"]');
    handoff.disabled = busy || sending;
    const handoffLabel = record?.transferredConversationId ? '回到侧栏' : '在侧栏继续';
    handoff.setAttribute('aria-label', handoffLabel);
    handoff.title = handoffLabel;
    position();
    pushPointer();
  }

  const quoteOf = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim();

    return flat ? `「${flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}…` : flat}」` : '';
  };

  /** 第 index 问针对哪段原文：往前最近一个换过段的轮次，没有就是卡片打开时那段。 */
  function sourceOf(index: number): string {
    const turns = record?.turns ?? [];

    for (let i = index; i >= 0; i--) {
      const own = turns[i]?.source;

      if (own) return own.text;
    }

    return record?.source.text ?? '';
  }

  function setSourceQuote(turn: HTMLElement, text: string): void {
    let quote = turn.querySelector<HTMLElement>(':scope > .source');

    if (!text) {
      quote?.remove();

      return;
    }

    if (!quote) {
      quote = document.createElement('div');
      quote.className = 'source';
      turn.prepend(quote);
    }

    quote.textContent = quoteOf(text);
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
  function voiceTarget(): { selection?: string; asked?: string } {
    const card = visible && expanded && record?.turns.length ? record : undefined;
    const target = voice?.target ?? selectionSnapshot() ?? (card ? snapshot : null);

    if (!target) return {};
    const asked = card?.turns.at(-1)?.question;

    return { selection: target.source.text, ...(asked ? { asked: questionLabel(asked) } : {}) };
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
    // 名牌避开卡片：卡片顶上就是它理解的那段引用，不能被挡住。
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

    if (card && target.source.text !== snapshot?.source.text) {
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
    const moved = target.source.text !== snapshot?.source.text;
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

    if (previous && previous.source.text !== snapshot?.source.text) snapshot = previous;
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
    surface.classList.toggle('receding', surface.dataset.place !== 'beside');
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
      const result = await rpc('reading_send', { question, retry, correction, depth, spoken, ...(source ? { source: { text: source.text, surrounding: source.surrounding, truncated: source.truncated } } : {}) });

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

    if (!next || !question.trim()) return send(question, false, readingBusy(record));
    candidate = null;
    snapshot = next;
    side = null;
    glide();
    highlight();

    return send(question, false, readingBusy(record), 'fast', false, next.source);
  }

  root.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-act],[data-ask]');

    if (!target) {
      return;
    }

    const action = target.dataset.act;
    const quick = target.dataset.ask;

    void (async () => {
      report();

      if (quick) {
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
      else if (action === 'read') {
        // 朗读只在本页用浏览器声音出声，不发起任何阅读或页面任务。
        const current = snapshot;
        hide();

        if (current) {
          await reader.start(current.source.text, current.range);
        }
      }
      else if (action === 'close') {
        hide();
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
        const item = answers[Number(target.dataset.turn)];

        if (item) item.detailed = !item.detailed;
        render();
      }
      else if (action === 'retry') {
        const index = Number(target.dataset.turn);
        await send(record!.turns.at(-1)!.question, true, false, deepTurns.has(index) ? 'deep' : 'fast');
      }
      else if (action === 'deep') {
        await send(record!.turns.at(-1)!.question, false, false, 'deep');
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
  for (const part of [el('.bar'), menu, el('.chips')]) part.addEventListener('pointerdown', event => event.preventDefault());
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

  void chrome.storage.local.get(SELECTION_BAR_KEY).then(stored => applyBarSetting(isSelectionBarOff(stored[SELECTION_BAR_KEY]))).catch(() => {
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (retired()) {
      return;
    }

    if (area === 'local' && SELECTION_BAR_KEY in changes) {
      applyBarSetting(isSelectionBarOff(changes[SELECTION_BAR_KEY]!.newValue));
    }
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
        candidate = next.source.text !== snapshot?.source.text ? next : null;
        render();
      }

      return;
    }

    if (!barEnabled || pageMuted) {
      return;
    }

    if (!next || root.activeElement || next.source.text === snapshot?.source.text && visible) {
      return;
    }

    rememberDraft();
    selectionVersion++;
    snapshot = next;
    expanded = false;
    pinned = false;
    side = null;
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

      if (!menu.hidden) closeMenu();
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
      closeMenu();
      position();
      pushPointer();
    }
  };
  window.addEventListener('resize', relayout, { signal });
  // 双指缩放只改可视视口，不触发 window 的 resize。
  visualViewport?.addEventListener('resize', relayout, { signal });
  visualViewport?.addEventListener('scroll', relayout, { signal });
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
