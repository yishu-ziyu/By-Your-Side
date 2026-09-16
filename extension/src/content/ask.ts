/** Selection → local reading conversation. UI never sends task/steer messages. */
import { createElement as icon, Sparkles, ArrowUp, Square, X, Copy, PanelRight, RotateCcw } from 'lucide';
import DOMPurify from 'dompurify';
import { clipSelection, isEditableTarget, EXPLAIN_PROMPT } from '../shared/ask-selection.js';
import { READING_CONTEXT_LIMIT, READING_SELECTION_LIMIT, type ReadingSource } from '../../../shared/reading.js';
import { readingBusy, type ReadingRecord } from '../shared/reading-state.js';
import { renderMarkdownHtml } from '../shared/markdown.js';
import { ASK_STYLES } from './ask-styles.js';

const HOST = 'data-sideagent-ask';
interface SelectionSnapshot { source: ReadingSource; range: Range | null; rect: DOMRect }

export function selectionSnapshot(): SelectionSnapshot | null {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (isEditableTarget(selection.anchorNode?.parentElement ?? null) || isEditableTarget(selection.focusNode?.parentElement ?? null)) return null;
  const raw = selection.toString().trim(), text = clipSelection(raw);
  if (!text) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const node = range.commonAncestorContainer;
  const parent = node instanceof Element ? node : node.parentElement;
  const paragraph = parent?.closest('p,li,pre,blockquote,h1,h2,h3,td');
  const surrounding = paragraph ? [paragraph.previousElementSibling, paragraph, paragraph.nextElementSibling]
    .filter((e): e is HTMLElement => e instanceof HTMLElement && !isEditableTarget(e) && !e.querySelector('input,textarea,[contenteditable]') && e.checkVisibility())
    .map(e => e.innerText).join('\n').slice(0, READING_CONTEXT_LIMIT) : '';
  return {source: {text, surrounding, truncated: raw.length > READING_SELECTION_LIMIT, tabId: 0, title: document.title, url: location.href}, range, rect};
}

function boot(): void {
  if (window !== window.top || document.contentType !== 'text/html') return;
  document.querySelector(`[${HOST}]`)?.remove();
  const host = document.createElement('div');
  host.setAttribute(HOST, '1');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645';
  const root = host.attachShadow({mode: 'closed'});
  root.innerHTML = `<style>${ASK_STYLES}</style>
    <section class="surface" role="dialog" aria-label="划词阅读" hidden>
      <div class="bar"><button class="ask" data-act="ask"><span class="identity"></span>问 AI</button><button class="explain" data-act="explain">解释</button></div>
      <div class="header" hidden><span class="identity"></span><span class="site"></span><button class="icon" data-act="close" aria-label="收起阅读" title="收起阅读"></button></div>
      <details class="quote" hidden><summary></summary><p></p><div class="limit" hidden>已截取前 8000 字</div></details>
      <div class="messages" tabindex="0" aria-label="阅读问答" hidden></div>
      <div class="error" role="status" hidden></div>
      <form class="composer" hidden><textarea rows="1" maxlength="2000" aria-label="关于选中文字的问题" placeholder="问问这段文字…"></textarea><button class="send" type="submit" aria-label="发送问题" title="发送问题"></button></form>
      <div class="footer" hidden><button data-act="copy">复制</button><button data-act="retry" hidden>重试</button><button data-act="handoff">在侧栏继续</button></div>
    </section>
    <button class="restore" data-act="restore" hidden>继续阅读</button>`;
  document.documentElement.append(host);
  const el = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  for (const item of root.querySelectorAll('.identity')) item.append(icon(Sparkles));
  for (const [action, symbol] of [['close', X], ['copy', Copy], ['retry', RotateCcw], ['handoff', PanelRight]] as const) el(`[data-act="${action}"]`).prepend(icon(symbol));
  const surface = el('.surface'), messages = el('.messages'), input = el<HTMLTextAreaElement>('textarea');
  const submit = el<HTMLButtonElement>('.send'), restore = el('.restore'), error = el('.error');
  let snapshot: SelectionSnapshot | null = null;
  let record: ReadingRecord | undefined;
  let expanded = false, visible = false, sending = false, selectionVersion = 0;
  let lastFocus: HTMLElement | null = null;
  let pageUrl = location.href;
  let renderedThread = '', renderedTurns = 0;
  const answers: Array<{node: HTMLElement; status: HTMLElement; text: string}> = [];
  const drafts = new Map<string, string>();
  let pinned = false;
  const highlightName = `by-your-side-reading`;
  const highlights = (CSS as typeof CSS & {highlights?: Map<string, unknown>}).highlights;
  const HighlightClass = (globalThis as unknown as {Highlight?: new (...ranges: Range[]) => unknown}).Highlight;
  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `::highlight(${highlightName}) { background: #dfe8f8; color: inherit; }`;
  document.documentElement.append(highlightStyle);

  const report = (message = '', informational = false) => { error.textContent = message; error.hidden = !message; error.classList.toggle('info', informational); };
  async function rpc(type: string, extra: Record<string, unknown> = {}): Promise<any> {
    const result = await chrome.runtime.sendMessage({type, threadId: record?.threadId, ...extra});
    if (!result?.ok) throw new Error(result?.error ?? '扩展连接已断开，请刷新页面后重试。');
    return result;
  }
  const rememberDraft = () => { if (record) drafts.set(record.threadId, input.value); };
  function position(): void {
    if (!visible || !snapshot) return;
    const r = snapshot.range?.startContainer.isConnected ? snapshot.range.getBoundingClientRect() : snapshot.rect;
    if (r.bottom < 0 || r.top > innerHeight) pinned = true;
    const margin = 12;
    const available = Math.max(r.top - margin - 8, innerHeight - r.bottom - margin - 8);
    surface.style.maxHeight = expanded ? `${Math.min(innerHeight - margin * 2, pinned ? 540 : Math.max(220, available))}px` : '';
    const box = surface.getBoundingClientRect();
    const left = Math.max(margin, Math.min(r.left + r.width / 2 - box.width / 2, innerWidth - box.width - margin));
    const above = r.top - box.height - 8;
    const below = r.bottom + 8;
    const top = pinned ? margin : above >= margin ? above : below + box.height <= innerHeight - margin ? below : Math.max(margin, Math.min(r.top, innerHeight - box.height - margin));
    surface.style.left = `${left}px`;
    surface.style.top = `${top}px`;
    surface.style.transformOrigin = above >= margin ? 'bottom center' : 'top center';
  }
  function highlight(): void {
    if (snapshot?.range && HighlightClass) highlights?.set(highlightName, new HighlightClass(snapshot.range));
  }
  function show(keyboard = false): void {
    visible = true; surface.hidden = false; restore.hidden = true;
    surface.classList.toggle('enter', !keyboard);
    position();
  }
  function hide(): void {
    const restoreFocus = Boolean(root.activeElement);
    rememberDraft(); visible = false; surface.hidden = true;
    restore.hidden = !record;
    highlights?.delete(highlightName);
    if (restoreFocus && lastFocus?.isConnected) lastFocus.focus({preventScroll: true});
  }
  function update(next: ReadingRecord): void {
    if (record?.threadId === next.threadId && record.updatedAt > next.updatedAt) return;
    record = next;
    if (next.handoffError) report(next.handoffError);
    else if (next.transferredConversationId) report();
    if (expanded) render();
  }
  function render(): void {
    const source = record?.source ?? snapshot?.source;
    surface.classList.toggle('expanded', expanded);
    el('.bar').hidden = expanded;
    for (const selector of ['.header', '.quote', '.composer']) el(selector).hidden = !expanded;
    messages.hidden = !expanded || !record?.turns.length;
    el('.footer').hidden = !expanded || !record?.turns.length;
    if (!expanded || !source) { position(); return; }
    el('.site').textContent = new URL(source.url).hostname;
    el('.quote summary').textContent = `“${source.text.replace(/\s+/g, ' ').slice(0, 64)}${source.text.length > 64 ? '…' : ''}”`;
    el('.quote p').textContent = source.text;
    el('.limit').hidden = !source.truncated;
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 36;
    if (renderedThread !== record?.threadId || renderedTurns > (record?.turns.length ?? 0)) {
      messages.replaceChildren(); answers.length = 0; renderedThread = record?.threadId ?? ''; renderedTurns = 0;
    }
    for (const [index, turn] of (record?.turns ?? []).entries()) {
      if (!answers[index]) {
        const wrapper = document.createElement('article'); wrapper.className = 'turn';
        const question = document.createElement('div'); question.className = 'question'; question.textContent = turn.question === EXPLAIN_PROMPT ? '解释这段文字' : turn.question;
        const node = document.createElement('div'); node.className = 'answer';
        const status = document.createElement('div'); status.className = 'status'; status.setAttribute('role', 'status');
        wrapper.append(question, node, status); messages.append(wrapper);
        answers.push({node, status, text: ''});
      }
      const item = answers[index]!;
      if (item.text !== turn.answer) {
        item.node.innerHTML = DOMPurify.sanitize(renderMarkdownHtml(turn.answer), {FORBID_TAGS: ['img','video','audio','iframe','style','form','input','button']});
        for (const link of item.node.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        item.text = turn.answer;
      }
      item.status.textContent = turn.state === 'pending' ? '正在回答…' : turn.state === 'streaming' ? '正在生成…' : turn.state === 'stopped' ? '已停止，内容已保留' : turn.state === 'error' ? turn.error ?? '回答未完成，可以重试。' : '';
    }
    renderedTurns = record?.turns.length ?? 0;
    if (atBottom) messages.scrollTop = messages.scrollHeight;
    const busy = readingBusy(record), last = record?.turns.at(-1);
    submit.replaceChildren(icon(busy ? Square : ArrowUp));
    submit.setAttribute('aria-label', busy ? '停止回答' : '发送问题');
    submit.title = busy ? '停止回答' : '发送问题';
    submit.disabled = sending || (!busy && !input.value.trim());
    input.placeholder = record?.turns.length ? '继续问这段文字…' : '问问这段文字…';
    el<HTMLButtonElement>('[data-act="handoff"]').disabled = busy || sending;
    el('[data-act="handoff"]').lastChild!.textContent = record?.transferredConversationId ? '回到侧栏' : '在侧栏继续';
    el<HTMLButtonElement>('[data-act="copy"]').disabled = !last?.answer;
    el('[data-act="retry"]').hidden = !last || !['error','stopped'].includes(last.state);
    position();
  }
  async function enter(keyboard = false): Promise<void> {
    if (!snapshot) return;
    const version = selectionVersion;
    const result = await rpc('reading_open', {source: snapshot.source});
    if (version !== selectionVersion) return;
    rememberDraft(); record = result.record; input.value = drafts.get(record!.threadId) ?? '';
    expanded = true; pinned = false; lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    render(); show(keyboard); highlight(); input.focus({preventScroll: true});
  }
  async function send(question: string, retry = false): Promise<void> {
    if (!record || sending || !question.trim()) return;
    const threadId = record.threadId;
    sending = true; report(); render();
    try {
      const result = await rpc('reading_send', {question, retry});
      if (record?.threadId !== threadId) return;
      update(result.record);
      if (record?.turns.at(-1)?.state !== 'error') {input.value = ''; rememberDraft();}
    } catch (err) {report(String(err instanceof Error ? err.message : err));}
    finally { sending = false; render(); }
  }
  root.addEventListener('click', event => {
    const action = (event.target as Element).closest('[data-act]')?.getAttribute('data-act');
    if (!action) return;
    void (async () => {
      report();
      if (action === 'ask') await enter();
      else if (action === 'explain') { await enter(); await send(EXPLAIN_PROMPT); }
      else if (action === 'close') hide();
      else if (action === 'restore') {
        const restored = await rpc('reading_get');
        if (!restored.record) throw new Error('阅读记录已过期，请重新划词。');
        record = restored.record;
        snapshot ??= {source: record!.source, range: null, rect: new DOMRect(innerWidth - 400, 80, 0, 0)};
        expanded = true; render(); show(); highlight();
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(record?.turns.at(-1)?.answer ?? '');
        el('[data-act="copy"]').lastChild!.textContent = '已复制';
      } else if (action === 'retry') await send(record!.turns.at(-1)!.question, true);
      else if (action === 'handoff') { await rpc('reading_handoff'); if (!record?.transferredConversationId) report('正在交接阅读记录…', true); }
    })().catch(err => {report(err.message); if (!visible) {expanded = true; render(); show();}});
  });
  // Preserve native selection when activating the toolbar, without blocking input focus.
  el('.bar').addEventListener('pointerdown', event => event.preventDefault());
  el<HTMLFormElement>('.composer').addEventListener('submit', event => {
    event.preventDefault();
    if (readingBusy(record)) void rpc('reading_stop').then(result => update(result.record)).catch(err => report(err.message));
    else void send(input.value);
  });
  input.addEventListener('input', () => {input.style.height = 'auto'; input.style.height = `${Math.min(100, input.scrollHeight)}px`; rememberDraft(); render();});
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); if (!readingBusy(record)) void send(input.value);
    }
  });
  function changedSelection(keyboard = false): void {
    const next = selectionSnapshot();
    if (!next || root.activeElement || next.source.text === snapshot?.source.text && visible) return;
    rememberDraft(); selectionVersion++; snapshot = next; expanded = false; pinned = false; report(); render(); show(keyboard);
  }
  document.addEventListener('pointerdown', event => {if (!event.composedPath().includes(host)) hide();}, true);
  document.addEventListener('pointerup', event => {if (!event.composedPath().includes(host)) setTimeout(() => changedSelection(), 0);});
  document.addEventListener('keyup', event => {if (event.key === 'Shift' || event.key.startsWith('Arrow')) changedSelection(true);});
  document.addEventListener('keydown', event => {if (event.key === 'Escape') hide();});
  window.addEventListener('scroll', () => {if (expanded) position(); else if (visible) hide();}, true);
  window.addEventListener('resize', position);
  new ResizeObserver(position).observe(surface);
  window.addEventListener('pagehide', () => {void rpc('reading_leave').catch(() => {});});
  // SPA navigation has no content-script reinjection; release the old document UI.
  const navigation = () => {
    if (location.href === pageUrl) return;
    void rpc('reading_leave').catch(() => {});
    pageUrl = location.href; selectionVersion++; snapshot = null; record = undefined; expanded = false; hide(); restore.hidden = true;
  };
  window.addEventListener('popstate', navigation);
  setInterval(navigation, 1000);
  chrome.runtime.onMessage.addListener(raw => {
    if (raw?.type === 'reading_update' && raw.record?.threadId === record?.threadId) update(raw.record);
    if (raw?.type === 'ask-open' || raw?.type === 'ask-hotkey') {
      snapshot = selectionSnapshot();
      if (!snapshot && typeof raw.text === 'string' && clipSelection(raw.text)) snapshot = {source: {text: clipSelection(raw.text)!, surrounding: '', truncated: raw.text.length > READING_SELECTION_LIMIT, tabId: 0, title: document.title, url: location.href}, range: null, rect: new DOMRect(200, 100, 0, 0)};
      if (snapshot) {selectionVersion++; void enter(true).catch(err => report(err.message));}
      else if (record) {expanded = true; render(); show(true); input.focus();}
    }
  });
  void rpc('reading_get').then(result => {if (result.record && !record) {record = result.record; restore.hidden = false;}}).catch(() => {});
}
boot();
