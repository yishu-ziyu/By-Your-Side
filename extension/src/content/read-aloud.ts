/** 划词朗读：用浏览器自带的 speechSynthesis 读选区，用 CSS Custom Highlight 标出当前句/词，不改页面 DOM。只在本页出声，不发任何任务或消息。 */
import { createElement as icon, Pause, Play, X } from 'lucide';

const SENTENCE = 'by-your-side-read-aloud';

const WORD = 'by-your-side-read-aloud-word';

const RATES = [1, 1.5, 2];

/** Chrome 读太长的一段会中途断掉，所以按句切，过长的句子再按逗号/空格切。 */
const MAX_CHUNK = 220;

const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,figcaption,div,section,article';

interface Segment { node: Text; at: number; offset: number; length: number }

interface Collected { text: string; segments: Segment[] }

interface ReadAloud { start(text: string, range: Range | null): Promise<void>; stop(): void }

interface Chunk { start: number; end: number }

// 旧版 Chrome 的 CSS 没有 highlights，用到处都带 ?. 容忍缺失。
const registry = CSS.highlights;

// 旧版 Chrome 没有全局 Highlight；存在性探测，缺失时划词朗读只出声不高亮。
const HighlightClass = typeof Highlight === 'undefined' ? undefined : Highlight;

/** 把选区里的可见文字连成一段朗读文本，同时记下每个文字节点在其中的位置，好把朗读进度映射回页面。 */
function collect(range: Range | null, fallback: string): Collected {
  if (!range?.startContainer.isConnected) {
    return { text: fallback, segments: [] };
  }

  const scope = range.commonAncestorContainer;
  const nodes: Text[] = scope instanceof Text ? [scope] : [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    // SAFETY: walker 用 SHOW_TEXT 创建，currentNode 只会是文字节点。
    nodes.push(walker.currentNode as Text);
  }

  const segments: Segment[] = [];
  let text = '';
  let block: Element | null = null;

  for (const node of nodes) {
    const parent = node.parentElement;

    if (!range.intersectsNode(node) || !parent || parent.closest('script,style,noscript,textarea') || !parent.checkVisibility()) {
      continue;
    }

    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;

    if (end <= start) {
      continue;
    }

    const nextBlock = parent.closest(BLOCK);

    if (text && nextBlock !== block) {
      text += '\n';
    }

    block = nextBlock;
    segments.push({ node, at: text.length, offset: start, length: end - start });
    text += node.data.slice(start, end);
  }

  return text.trim() ? { text, segments } : { text: fallback, segments: [] };
}

function split(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;

  const push = (end: number) => {
    let s = start;
    let e = end;

    while (s < e && /\s/.test(text[s]!)) s++;

    while (e > s && /\s/.test(text[e - 1]!)) e--;

    if (e > s) chunks.push({ start: s, end: e });
    start = end;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1] ?? '';
    const length = i + 1 - start;

    if (c === '\n'
      || /[。！？!?；]/.test(c) && !/[。！？!?；"”’」』)）]/.test(next)
      || c === '.' && (!next || /\s/.test(next))
      || length >= MAX_CHUNK && /[\s，,、]/.test(c)
      || length >= MAX_CHUNK * 1.5) {
      push(i + 1);
    }
  }

  push(text.length);

  return chunks;
}

function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | undefined {
  const prefix = lang.slice(0, 2);
  const score = (v: SpeechSynthesisVoice) => (v.lang.replace('_', '-') === lang ? 2 : 0) + (v.localService ? 1 : 0);

  return voices.filter(v => v.lang.toLowerCase().startsWith(prefix)).sort((a, b) => score(b) - score(a))[0];
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices();

  if (now.length) {
    return Promise.resolve(now);
  }

  return new Promise(resolve => {
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(speechSynthesis.getVoices());
    };

    const timer = setTimeout(done, 1500);
    speechSynthesis.addEventListener('voiceschanged', done);
  });
}

export function createReadAloud(root: ShadowRoot): ReadAloud {
  const bar = document.createElement('div');
  bar.className = 'reader';
  bar.hidden = true;
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', '朗读');
  bar.innerHTML = `<button class="icon" data-read="toggle"></button><span class="reader-label" role="status"></span><button class="reader-rate" data-read="rate" title="切换朗读速度"></button><button class="icon" data-read="close" aria-label="关闭朗读" title="关闭朗读"></button>`;
  root.append(bar);
  bar.querySelector('[data-read="close"]')!.append(icon(X));
  const toggle = bar.querySelector<HTMLButtonElement>('[data-read="toggle"]')!;
  const rateButton = bar.querySelector<HTMLButtonElement>('[data-read="rate"]')!;
  const label = bar.querySelector<HTMLElement>('.reader-label')!;

  const style = document.createElement('style');
  style.textContent = `::highlight(${SENTENCE}) { background: #e4ecfa; color: inherit; } ::highlight(${WORD}) { background: #c3d5f6; color: inherit; }`;
  document.documentElement.append(style);

  let text = '';
  let segments: Segment[] = [];
  let chunks: Chunk[] = [];
  let current = 0;
  let rate = 0;
  let playing = false;
  let failed = false;
  let generation = 0;
  let lang = 'en-US';
  let voice: SpeechSynthesisVoice | undefined;

  function rangeAt(start: number, end: number): Range | null {
    const first = segments.find(s => s.at + s.length > start);
    let last: Segment | undefined;

    for (let i = segments.length - 1; i >= 0 && !last; i--) {
      if (segments[i]!.at < end) last = segments[i];
    }

    if (!first || !last) {
      return null;
    }

    try {
      const range = document.createRange();
      range.setStart(first.node, first.offset + Math.max(0, start - first.at));
      range.setEnd(last.node, last.offset + Math.min(last.length, end - last.at));

      return range;
    }
    catch {
      return null;
    }
  }

  function mark(name: string, range: Range | null, priority = 0): void {
    if (!range || !HighlightClass) {
      registry?.delete(name);

      return;
    }

    const highlight = new HighlightClass(range);
    highlight.priority = priority;
    registry?.set(name, highlight);
  }

  function render(): void {
    toggle.replaceChildren(icon(playing ? Pause : Play));
    toggle.setAttribute('aria-label', playing ? '暂停朗读' : '继续朗读');
    toggle.title = playing ? '暂停' : '继续';
    toggle.disabled = failed;
    rateButton.disabled = failed;
    rateButton.textContent = `${RATES[rate]}×`;
    rateButton.setAttribute('aria-label', `朗读速度 ${RATES[rate]} 倍`);

    if (!failed) {
      label.textContent = playing ? '正在朗读' : '已暂停';
    }
  }

  /** 停声并清高亮；暂停也走这里，因为 speechSynthesis.pause() 在部分声音上不会立刻停。 */
  function silence(): void {
    generation++;
    playing = false;
    speechSynthesis.cancel();
    mark(SENTENCE, null);
    mark(WORD, null);
  }

  function fail(message: string): void {
    silence();
    failed = true;
    label.textContent = message;
    bar.hidden = false;
    render();
  }

  function speakFrom(index: number): void {
    silence();
    const gen = generation;
    playing = true;
    render();

    const next = (k: number) => {
      if (gen !== generation) {
        return;
      }

      if (k >= chunks.length) {
        stop();

        return;
      }

      current = k;
      const { start, end } = chunks[k]!;
      mark(SENTENCE, rangeAt(start, end));
      mark(WORD, null);
      const utterance = new SpeechSynthesisUtterance(text.slice(start, end));
      utterance.lang = lang;
      utterance.rate = RATES[rate]!;

      if (voice) {
        utterance.voice = voice;
      }

      utterance.onboundary = event => {
        if (gen !== generation || event.name !== 'word') {
          return;
        }

        const at = start + event.charIndex;
        // 有的声音不给 charLength；只对拉丁文字按词补算，中文没有长度就只保留句子高亮。
        const length = event.charLength || /^[A-Za-z0-9À-ɏ'’-]+/.exec(text.slice(at, end))?.[0].length || 0;
        mark(WORD, length ? rangeAt(at, at + length) : null, 1);
      };

      utterance.onend = () => next(k + 1);
      utterance.onerror = event => {
        if (gen === generation && event.error !== 'interrupted' && event.error !== 'canceled') {
          fail('朗读没有成功，请稍后再试。');
        }
      };

      speechSynthesis.speak(utterance);
    };

    next(index);
  }

  function stop(): void {
    if (playing || !bar.hidden) {
      silence();
    }

    bar.hidden = true;
    failed = false;
  }

  async function start(fallback: string, range: Range | null): Promise<void> {
    stop();
    bar.hidden = false;
    render();

    if (!('speechSynthesis' in window)) {
      fail('这个浏览器不支持朗读。');

      return;
    }

    ({ text, segments } = collect(range, fallback));
    chunks = split(text);
    current = 0;

    // 去掉原生选区底色，让当前句的高亮看得见。
    if (segments.length) {
      getSelection()?.removeAllRanges();
    }

    const gen = generation;
    const voices = await loadVoices();

    if (gen !== generation || bar.hidden) {
      return;
    }

    if (!voices.length) {
      fail('这台设备没有可用的朗读声音。');

      return;
    }

    const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0;
    const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
    lang = cjk * 4 > latin ? 'zh-CN' : 'en-US';
    voice = pickVoice(voices, lang);
    speakFrom(0);
  }

  bar.addEventListener('pointerdown', event => event.preventDefault());
  bar.addEventListener('click', event => {
    // SAFETY: 监听器挂在工具条上，点击目标是其内部元素（按钮或图标）。
    const action = (event.target as Element).closest('[data-read]')?.getAttribute('data-read');

    if (action === 'close') {
      stop();
    }
    else if (action === 'toggle') {
      if (playing) {
        silence();
        render();
      }
      else {
        speakFrom(current);
      }
    }
    else if (action === 'rate') {
      rate = (rate + 1) % RATES.length;

      if (playing) {
        speakFrom(current);
      }
      else {
        render();
      }
    }
  });
  window.addEventListener('pagehide', stop);

  return { start, stop };
}
