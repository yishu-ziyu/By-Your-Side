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
import { PTT_WARM } from "../shared/ptt.js";
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
  installPushToTalkKeys();
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
    if (!visible || !snapshot) {
      return;
    }

    const live = snapshot.range?.startContainer.isConnected ? snapshot.range : null;
    const r = live ? live.getBoundingClientRect() : snapshot.rect;
    const lines = live ? [...live.getClientRects()].filter(line => line.width > 0 && line.height > 0) : [];
    const first = lines[0] ?? r;
    const last = lines.at(-1) ?? r;
    const margin = PLACE_MARGIN;

    // 还没有回答时是一条贴着选区的胶囊：放在第一行上方，小三角指着它；上方放不下才放到最后一行下方。
    if (!expanded || !record?.turns.length) {
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

    if (r.bottom < 0 || r.top > innerHeight) {
      pinned = true;
    }

    const block = pinned ? null : contentBlockOf(snapshot.range);
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

    surface.dataset.place = 'float';
    const left = clamp(r.left + r.width / 2 - box.width / 2, margin, innerWidth - box.width - margin);
    const bottomLimit = innerHeight - box.height - margin;
    const top = pinned ? margin : side === 'below' ? clamp(r.bottom + LENS_GAP, margin, bottomLimit) : clamp(r.top - box.height - LENS_GAP, margin, bottomLimit);
    surface.style.left = `${left}px`;
    surface.style.top = `${top}px`;
    surface.style.setProperty('--origin', side === 'above' ? 'bottom center' : 'top center');
  }

  function highlight(): void {
    if (snapshot?.range && HighlightClass) {
      highlights?.set(highlightName, new HighlightClass(snapshot.range));
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
    const answering = expanded && turns.length > 0;
    const composing = expanded && !turns.length;
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

    if (atBottom) {
      messages.scrollTop = messages.scrollHeight;
    }

    // 顶上引用的是这张卡理解的那段原文，换了选段就跟着换。
    const quoted = record?.source.text.replace(/\s+/g, ' ').trim() ?? '';
    const quote = el('.head .q');
    quote.textContent = quoted ? `「${quoted.length > QUOTE_CHARS ? `${quoted.slice(0, QUOTE_CHARS)}…` : quoted}」` : '';
    quote.title = quoted.slice(0, 400);
    const busy = readingBusy(record);
    // 生成中输入框有字时，按钮是改口；空着时才是停止。
    const stops = busy && !input.value.trim();
    const label = stops ? '停止回答' : busy ? '停止这条回答，按新问题重新回答' : '发送问题';
    submit.replaceChildren(icon(stops ? Square : ArrowUp));
    submit.setAttribute('aria-label', label);
    submit.title = label;
    submit.disabled = sending || (!busy && !input.value.trim());
    input.placeholder = turns.length ? '接着问…' : '问这段话…';
    const handoff = el<HTMLButtonElement>('[data-act="handoff"]');
    handoff.disabled = busy || sending;
    const handoffLabel = record?.transferredConversationId ? '回到侧栏' : '在侧栏继续';
    handoff.setAttribute('aria-label', handoffLabel);
    handoff.title = handoffLabel;
    position();
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

  /** 按住说话要知道这句话对着哪段：新选的文字优先，其次是开着的阅读卡那段。 */
  function voiceTarget(): { selection?: string; asked?: string } {
    const live = selectionSnapshot();
    const card = visible && expanded && record ? record : undefined;

    if (live && live.source.text !== card?.source.text) return { selection: live.source.text };

    if (!card) return {};
    const asked = card.turns.at(-1)?.question;

    return { selection: card.source.text, ...(asked ? { asked: questionLabel(asked) } : {}) };
  }

  /** 说的话交给阅读卡：选了别的段就换到那一段开卡，否则在开着的卡里接着问；还在回答时就是改口。 */
  async function voiceAsk(question: string): Promise<void> {
    const live = selectionSnapshot();
    const onCard = visible && expanded && !!record;

    if (live && (!onCard || live.source.text !== record!.source.text)) {
      rememberDraft();
      selectionVersion++;
      snapshot = live;
      await openReading();
    }
    else if (!onCard) {
      throw new Error('没有选中的文字。');
    }

    await send(question, false, readingBusy(record), 'fast', true);

    if (record?.turns.at(-1)?.question !== question) throw new Error('没能交给阅读卡。');
  }

  /** correction 只由输入框和说话发出（打字后回车、点发送、按住说话）：再点一次「解释」不算改口。spoken：说出来的，回答会被念出来。 */
  async function send(question: string, retry = false, correction = false, depth: 'fast' | 'deep' = 'fast', spoken = false): Promise<void> {
    if (opening) await opening.catch(() => {});

    if (!record || sending || !question.trim()) {
      return;
    }

    const threadId = record.threadId;
    sending = true;
    report();
    render();

    try {
      const result = await rpc('reading_send', { question, retry, correction, depth, spoken });

      if (record?.threadId !== threadId) {
        return;
      }

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
        snapshot ??= { source: record!.source, range: null, rect: new DOMRect(innerWidth - 400, 80, 0, 0) };
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
      void send(input.value, false, readingBusy(record));
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
      void send(input.value, false, readingBusy(record));
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
    if (!retired() && !event.composedPath().includes(host)) {
      hide();
    }
  }, { capture: true, signal });
  // 选字、按键只认用户真实输入：网页脚本伪造的事件不能弹出工具条、抢焦点、停掉本页的回答。
  document.addEventListener('pointerup', event => {
    if (event.isTrusted && !retired() && !event.composedPath().includes(host)) {
      setTimeout(() => changedSelection(), 0);
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
    }
    else if (visible) {
      hide();
    }
  }, { capture: true, signal });
  window.addEventListener('resize', () => {
    if (!retired()) {
      closeMenu();
      position();
    }
  }, { signal });
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
  void rpc('reading_get').then(result => {
    if (result.record && !record) {
      record = result.record;
      restore.hidden = !record?.turns.length;
    }
  }).catch(() => {
  });
}

boot();
