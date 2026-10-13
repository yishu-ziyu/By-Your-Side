import { installDragFeed } from "./drag-feed.js";
import { installEdgePill } from "./edge-pill.js";
import { installGhostHud } from "./ghost-hud.js";
import { installLinkPreview } from "./link-preview.js";
import { installMarginaliaTracker } from "./marginalia-tracker.js";
import { installNudge } from "./nudge.js";
import { installSonarPinpoint } from "./sonar-pinpoint.js";
import { installMemoryMark } from "./memory-mark.js";
import { installPushToTalkKeys } from "./ptt.js";
/** Selection → local reading conversation. UI only relays selection or reading records; never task/steer messages. */
import { createElement as icon, Sparkles, ArrowUp, Square, X, Copy, PanelRight, RotateCcw } from 'lucide';
import DOMPurify from 'dompurify';
import { clipSelection, isEditableTarget, EXPLAIN_PROMPT, SELECTION_BAR_KEY, isSelectionBarOff } from '../shared/ask-selection.js';
import { READING_CONTEXT_LIMIT, READING_SELECTION_LIMIT, type ReadingSource } from '../../../shared/reading.js';
import { readingBusy, type ReadingRecord } from '../shared/reading-state.js';
import { renderMarkdownHtml } from '../shared/markdown.js';
import { ASK_STYLES } from './ask-styles.js';
import { createReadAloud } from './read-aloud.js';

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

/** 展开后的卡片宽度。右侧空白够不够，按这个宽度加两侧间距算，和样式里的 384px 一致。 */
const CARD_WIDTH = 384;

const PLACE_MARGIN = 12;

/** 正文和卡片之间留出的缝，细线画在这道缝里，避开卡片的阴影。 */
const BESIDE_GAP = 28;

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

function boot(): void {
  if (window !== window.top || document.contentType !== 'text/html') {
    return;
  }

  installSonarPinpoint();
  installMemoryMark();
  installPushToTalkKeys();
  installDragFeed();
  installMarginaliaTracker();
  installGhostHud();
  installEdgePill();
  installLinkPreview();
  installNudge();
  const previous = document.querySelector(`[${HOST}]`);
  previous?.setAttribute(RETIRED, '1');
  previous?.remove();
  const host = document.createElement('div');
  host.setAttribute(HOST, '1');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${ASK_STYLES}</style>
    <div class="link" hidden></div>
    <section class="surface" role="dialog" aria-label="划词阅读" hidden>
      <div class="bar"><button class="ask" data-act="ask"><span class="identity"></span>问助手</button><button class="explain" data-act="explain">解释</button><button data-act="read">朗读</button><button data-act="transfer">在侧栏继续</button></div>
      <div class="header" hidden><span class="identity"></span><span class="site"></span><button class="icon" data-act="close" aria-label="收起阅读" title="收起阅读"></button></div>
      <details class="quote" hidden><summary></summary><p></p><div class="limit" hidden>已截取前 8000 字</div></details>
      <div class="messages" tabindex="0" aria-label="阅读问答" hidden></div>
      <div class="error" role="status" hidden></div>
      <form class="composer" hidden><div class="depth" role="radiogroup" aria-label="回答快慢"><button type="button" role="radio" data-depth="fast" aria-checked="true" title="用快速模型">快速</button><button type="button" role="radio" data-depth="deep" aria-checked="false" title="用主模型">深度</button></div><textarea rows="1" maxlength="2000" aria-label="关于选中文字的问题" placeholder="问问这段文字…"></textarea><button class="send" type="submit" aria-label="发送问题" title="发送问题"></button></form>
      <div class="footer" hidden><button data-act="copy">复制</button><button data-act="retry" hidden>重试</button><button data-act="handoff">在侧栏继续</button></div>
    </section>
    <button class="restore" data-act="restore" hidden>继续阅读</button>`;
  document.documentElement.append(host);
  const el = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  for (const item of root.querySelectorAll('.identity')) {
    item.append(icon(Sparkles));
  }

  for (const [action, symbol] of [['close', X], ['copy', Copy], ['retry', RotateCcw], ['handoff', PanelRight]] as const) {
    el(`[data-act="${action}"]`).prepend(icon(symbol));
  }

  const surface = el('.surface');
  const link = el('.link');
  const messages = el('.messages');
  const input = el<HTMLTextAreaElement>('textarea');
  const submit = el<HTMLButtonElement>('.send');
  const restore = el('.restore');
  const error = el('.error');
  const reader = createReadAloud(root);
  let snapshot: SelectionSnapshot | null = null;
  let record: ReadingRecord | undefined;
  let expanded = false;
  let visible = false;
  let sending = false;
  let selectionVersion = 0;
  let lastFocus: HTMLElement | null = null;
  let pageUrl = location.href;
  let renderedThread = '';
  let renderedTurns = 0;

  const answers: Array<{
    turn: HTMLElement;
    question: HTMLElement;
    node: HTMLElement;
    status: HTMLElement;
    fold: HTMLButtonElement;
    text: string;
  }> = [];

  /** 被改口停下的旧回答默认折叠；这里记用户展开了哪几轮。 */
  const unfolded = new Set<number>();

  const drafts = new Map<string, string>();
  let pinned = false;
  /** 卡片放在选区哪一边：打开时定一次，之后回答变长也不换边，免得卡片跳位。右侧空白够放时不用这一边。 */
  let side: 'above' | 'below' | null = null;
  /** 下一问用快速模型还是主模型。旧记录没有这个字段，按快速。 */
  let depth: 'fast' | 'deep' = 'fast';
  const highlightName = `by-your-side-reading`;

  const highlights = (CSS as typeof CSS & {
    highlights?: Map<string, unknown>;
  }).highlights;

  const HighlightClass = (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;

  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `::highlight(${highlightName}) { background: #dfe8f8; color: inherit; }`;
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

  const syncDepth = () => {
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-depth]')) {
      button.setAttribute('aria-checked', String(button.dataset.depth === depth));
    }
  };

  function position(): void {
    if (!visible || !snapshot) {
      link.hidden = true;

      return;
    }

    const r = snapshot.range?.startContainer.isConnected ? snapshot.range.getBoundingClientRect() : snapshot.rect;

    if (r.bottom < 0 || r.top > innerHeight) {
      pinned = true;
    }

    const margin = PLACE_MARGIN;
    const block = pinned ? null : contentBlockOf(snapshot.range);
    const blockRect = block?.getBoundingClientRect();
    const roomy = !!blockRect && innerWidth - blockRect.right >= CARD_WIDTH + BESIDE_GAP + margin;
    const besideRegion = roomy && block && blockRect ? {
      left: blockRect.right + 1,
      right: innerWidth - 1,
      top: Math.max(0, Math.min(blockRect.top, r.top)),
      bottom: Math.min(innerHeight, Math.max(blockRect.bottom, r.top + Math.min(540, innerHeight - margin * 2))),
    } : null;
    // 正文右侧到窗口右边缘真是空白、并且放得下卡片和两侧间距时，贴在正文旁边；否则仍上下浮着。
    const beside = !pinned && !!besideRegion && !!block && gutterBlank(host, block, besideRegion);
    const room = { above: r.top - margin - 8, below: innerHeight - r.bottom - margin - 8 };
    // 默认放在选区下方：顺着阅读方向，不盖住上面的标题和正文；下方放不下一张展开卡片时才放上方。
    side ??= room.below >= 220 || room.below >= room.above ? 'below' : 'above';
    const cap = beside ? innerHeight - margin * 2 : pinned ? 540 : Math.max(220, room[side]);
    surface.style.maxHeight = expanded ? `${Math.min(innerHeight - margin * 2, cap)}px` : '';
    const box = surface.getBoundingClientRect();

    if (beside && blockRect) {
      const left = blockRect.right + BESIDE_GAP;
      const top = Math.max(margin, Math.min(r.top, innerHeight - box.height - margin));
      surface.style.left = `${left}px`;
      surface.style.top = `${top}px`;
      surface.style.transformOrigin = 'left center';
      surface.dataset.place = 'beside';
      const y1 = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight);
      link.style.left = `${blockRect.right}px`;
      link.style.top = `${y1 - 0.5}px`;
      link.style.width = `${Math.max(0, left - blockRect.right)}px`;
      link.hidden = false;

      return;
    }

    link.hidden = true;
    surface.dataset.place = 'float';
    const left = Math.max(margin, Math.min(r.left + r.width / 2 - box.width / 2, innerWidth - box.width - margin));
    const bottomLimit = innerHeight - box.height - margin;
    const top = pinned ? margin : side === 'below' ? Math.max(margin, Math.min(r.bottom + 8, bottomLimit)) : Math.max(margin, Math.min(r.top - box.height - 8, bottomLimit));
    surface.style.left = `${left}px`;
    surface.style.top = `${top}px`;
    surface.style.transformOrigin = side === 'above' ? 'bottom center' : 'top center';
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
    surface.classList.toggle('enter', !keyboard);
    position();
  }

  function hide(): void {
    const restoreFocus = Boolean(root.activeElement);
    rememberDraft();
    visible = false;
    surface.hidden = true;
    link.hidden = true;
    restore.hidden = !record;
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

  function render(): void {
    const source = record?.source ?? snapshot?.source;
    surface.classList.toggle('expanded', expanded);
    el('.bar').hidden = expanded;

    for (const selector of ['.header', '.quote', '.composer']) {
      el(selector).hidden = !expanded;
    }

    messages.hidden = !expanded || !record?.turns.length;
    el('.footer').hidden = !expanded;

    if (!expanded || !source) {
      position();

      return;
    }

    el('.site').textContent = new URL(source.url).hostname;
    el('.quote summary').textContent = `“${source.text.replace(/\s+/g, ' ').slice(0, 64)}${source.text.length > 64 ? '…' : ''}”`;
    el('.quote p').textContent = source.text;
    el('.limit').hidden = !source.truncated;
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 36;

    if (renderedThread !== record?.threadId || renderedTurns > (record?.turns.length ?? 0)) {
      messages.replaceChildren();
      answers.length = 0;
      unfolded.clear();
      renderedThread = record?.threadId ?? '';
      renderedTurns = 0;
    }

    for (const [index, turn] of (record?.turns ?? []).entries()) {
      if (!answers[index]) {
        const wrapper = document.createElement('article');
        wrapper.className = 'turn';
        const question = document.createElement('div');
        question.className = 'question';
        question.textContent = turn.question === EXPLAIN_PROMPT ? '解释这段文字' : turn.question;
        const node = document.createElement('div');
        node.className = 'answer';
        const status = document.createElement('div');
        status.className = 'status';
        status.setAttribute('role', 'status');
        // 展开键放在状态播报区外面，读屏不会把它念进状态；只建一次，点完焦点还在它上面。
        const fold = document.createElement('button');
        fold.className = 'fold';
        fold.dataset.act = 'fold';
        fold.dataset.turn = String(index);
        fold.hidden = true;
        const foot = document.createElement('div');
        foot.className = 'foot';
        foot.append(status, fold);
        wrapper.append(question, node, foot);
        messages.append(wrapper);
        answers.push({ turn: wrapper, question, node, status, fold, text: '' });
      }

      const item = answers[index]!;
      const corrected = record?.correctedTurns ?? [];

      if (corrected.includes(index) && !item.question.querySelector('.tag')) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '已按新问题重答';
        item.question.append(tag);
      }

      const foldable = turn.state === 'stopped' && corrected.includes(index + 1) && Boolean(turn.answer.trim());
      item.turn.classList.toggle('folded', foldable && !unfolded.has(index));
      item.fold.hidden = !foldable;
      item.fold.textContent = unfolded.has(index) ? '收起' : '展开';
      item.fold.setAttribute('aria-expanded', String(unfolded.has(index)));

      if (item.text !== turn.answer) {
        item.node.innerHTML = DOMPurify.sanitize(renderMarkdownHtml(turn.answer), { FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'style', 'form', 'input', 'button'] });

        const lead = item.node.firstElementChild;

        if (lead instanceof HTMLParagraphElement) lead.classList.add('lead');

        for (const anchor of item.node.querySelectorAll('a')) {
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
        }

        item.text = turn.answer;
      }

      item.status.textContent = turn.state === 'pending' ? '正在回答…' : turn.state === 'streaming' ? '正在回答…' : turn.state === 'stopped' ? '已停止回答，内容已保留' : turn.state === 'error' ? turn.error ?? '回答未完成，可以重试。' : '';
    }

    renderedTurns = record?.turns.length ?? 0;

    if (atBottom) {
      messages.scrollTop = messages.scrollHeight;
    }

    const busy = readingBusy(record);
    const last = record?.turns.at(-1);
    // 生成中输入框有字时，按钮是改口；空着时才是停止。
    const stops = busy && !input.value.trim();
    const label = stops ? '停止回答' : busy ? '停止这条回答，按新问题重新回答' : '发送问题';
    submit.replaceChildren(icon(stops ? Square : ArrowUp));
    submit.setAttribute('aria-label', label);
    submit.title = label;
    submit.disabled = sending || (!busy && !input.value.trim());
    input.placeholder = record?.turns.length ? '继续问这段文字…' : '问问这段文字…';
    el<HTMLButtonElement>('[data-act="handoff"]').disabled = busy || sending;
    el('[data-act="handoff"]').lastChild!.textContent = record?.transferredConversationId ? '回到侧栏' : '在侧栏继续';
    el('[data-act="copy"]').hidden = !record?.turns.length;
    el<HTMLButtonElement>('[data-act="copy"]').disabled = !last?.answer;
    el('[data-act="retry"]').hidden = !last || !['error', 'stopped'].includes(last.state);
    position();
  }

  async function enter(keyboard = false): Promise<void> {
    if (!snapshot) {
      return;
    }

    const version = selectionVersion;
    const result = await rpc('reading_open', { source: snapshot.source });

    if (version !== selectionVersion) {
      return;
    }

    rememberDraft();
    record = result.record;
    depth = record?.depth === 'deep' ? 'deep' : 'fast';
    syncDepth();
    input.value = drafts.get(record!.threadId) ?? '';
    expanded = true;
    pinned = false;
    side = null;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    render();
    show(keyboard);
    highlight();
    input.focus({ preventScroll: true });
  }

  /** correction 只由输入框发出（打字后回车或点发送）：再点一次「解释」不算改口。 */
  async function send(question: string, retry = false, correction = false): Promise<void> {
    if (!record || sending || !question.trim()) {
      return;
    }

    const threadId = record.threadId;
    sending = true;
    report();
    render();

    try {
      const result = await rpc('reading_send', { question, retry, correction, depth });

      if (record?.threadId !== threadId) {
        return;
      }

      update(result.record);

      if (record?.turns.at(-1)?.state !== 'error') {
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
    const target = (event.target as Element).closest<HTMLElement>('[data-act]');
    const action = target?.getAttribute('data-act');

    if (!action) {
      return;
    }

    void (async () => {
      report();

      if (action === 'ask') {
        await enter();
      }
      else if (action === 'explain') {
        await enter();
        await send(EXPLAIN_PROMPT);
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
      else if (action === 'restore') {
        const restored = await rpc('reading_get');

        if (!restored.record) {
          throw new Error('这段问答已过期。重新选中文字。');
        }

        record = restored.record;
        depth = record?.depth === 'deep' ? 'deep' : 'fast';
        syncDepth();
        snapshot ??= { source: record!.source, range: null, rect: new DOMRect(innerWidth - 400, 80, 0, 0) };
        expanded = true;
        render();
        show();
        highlight();
      }
      else if (action === 'fold') {
        const index = Number(target!.dataset.turn);

        if (!unfolded.delete(index)) {
          unfolded.add(index);
        }

        render();
      }
      else if (action === 'copy') {
        await navigator.clipboard.writeText(record?.turns.at(-1)?.answer ?? '');
        el('[data-act="copy"]').lastChild!.textContent = '已复制';
      }
      else if (action === 'retry') {
        await send(record!.turns.at(-1)!.question, true);
      }
      else if (action === 'transfer' || action === 'handoff') {
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
  // Preserve native selection when activating the toolbar, without blocking input focus.
  el('.bar').addEventListener('pointerdown', event => event.preventDefault());
  el('.depth').addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-depth]');

    if (!button) return;
    event.preventDefault();
    depth = button.dataset.depth === 'deep' ? 'deep' : 'fast';
    syncDepth();
  });
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
    if (!barEnabled) {
      return;
    }

    const next = selectionSnapshot();

    if (!next || root.activeElement || next.source.text === snapshot?.source.text && visible) {
      return;
    }

    rememberDraft();
    selectionVersion++;
    snapshot = next;
    expanded = false;
    pinned = false;
    side = null;
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
  document.addEventListener('pointerup', event => {
    if (!retired() && !event.composedPath().includes(host)) {
      setTimeout(() => changedSelection(), 0);
    }
  }, { signal });
  document.addEventListener('keyup', event => {
    if (!retired() && (event.key === 'Shift' || event.key.startsWith('Arrow'))) {
      changedSelection(true);
    }
  }, { signal });
  document.addEventListener('keydown', event => {
    if (!retired() && event.key === 'Escape') {
      hide();
    }
  }, { signal });
  window.addEventListener('scroll', () => {
    if (retired()) {
      return;
    }

    if (expanded) {
      position();
    }
    else if (visible) {
      hide();
    }
  }, { capture: true, signal });
  window.addEventListener('resize', () => {
    if (!retired()) {
      position();
    }
  }, { signal });
  resizes.observe(surface);
  window.addEventListener('pagehide', () => {
    if (!retired()) {
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
        void enter(true).catch(err => report(err.message));
      }
      else if (record) {
        depth = record.depth === 'deep' ? 'deep' : 'fast';
        syncDepth();
        expanded = true;
        render();
        show(true);
        input.focus();
      }
    }
  });
  void rpc('reading_get').then(result => {
    if (result.record && !record) {
      record = result.record;
      restore.hidden = false;
    }
  }).catch(() => {
  });
}

boot();
