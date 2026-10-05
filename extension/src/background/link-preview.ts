import { LINK_PREVIEW_GET, previewableUrl, type LinkPreview } from '../shared/link-preview.js';

/**
 * Shift+悬停链接预览（#48）的后台一半：只读 GET 目标页，取标题和 2–3 行要点。
 * 不带登录态（credentials: omit），不调模型；按网址缓存几分钟。
 */

const TIMEOUT_MS = 4000;

const MAX_BYTES = 384 * 1024;

const CACHE_MS = 5 * 60_000;

const CACHE_MAX = 60;

const MAX_LINES = 3;

const LINE_CHARS = 160;

const MIN_PARAGRAPH_CHARS = 24;

const isString = (v: unknown): v is string => typeof v === 'string';

const cache = new Map<string, { at: number; preview: Promise<LinkPreview> }>();

export function installLinkPreview(): void {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== LINK_PREVIEW_GET) return;

    if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0) return;
    const url = isString(message.url) ? previewableUrl(message.url) : null;

    if (!url) { respond({ ok: false } satisfies LinkPreview);

 return; }

    void cachedPreview(url).then(respond, () => respond({ ok: false } satisfies LinkPreview));

    return true;
  });
}

function cachedPreview(url: string): Promise<LinkPreview> {
  const now = Date.now();
  const hit = cache.get(url);

  if (hit && now - hit.at < CACHE_MS) return hit.preview;
  const preview = loadPreview(url).catch((): LinkPreview => ({ ok: false }));
  cache.delete(url);
  cache.set(url, { at: now, preview });

  // 失败不缓存：网络恢复后再悬停可以重试。
  void preview.then(result => { if (!result.ok && cache.get(url)?.preview === preview) cache.delete(url); });

  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);

  return preview;
}

async function loadPreview(url: string): Promise<LinkPreview> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'follow', signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml' } });
    const type = response.headers.get('content-type') ?? '';

    if (!response.ok || !/html/i.test(type)) { void response.body?.cancel().catch(() => {});

 return { ok: false }; }

    const bytes = await readCapped(response);

    return extract(decode(bytes, type));
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();

  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();

    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }

  void reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;

  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.length - offset);
    out.set(part, offset);
    offset += part.byteLength;
  }

  return out;
}

/** 按响应头或页面开头的 <meta charset> 解码；不认识的编码退回 UTF-8。 */
function decode(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';

  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function extract(html: string): LinkPreview {
  const metas = new Map<string, string>();

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase();
    const content = attr(tag, 'content');

    if (key && content && !metas.has(key)) metas.set(key, clean(content));
  }

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = clip(clean(titleTag ?? '') || metas.get('og:title') || '', 120);

  const lines: string[] = [];

  const push = (text: string) => {
    if (lines.length >= MAX_LINES || text.length < MIN_PARAGRAPH_CHARS) return;

    if (lines.some(line => line.startsWith(text.slice(0, 40)) || text.startsWith(line.slice(0, 40)))) return;
    lines.push(clip(text, LINE_CHARS));
  };

  push(metas.get('description') || metas.get('og:description') || '');

  const body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');

  for (const match of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (lines.length >= MAX_LINES) break;
    push(clean(match[1] ?? ''));
  }

  return title || lines.length ? { ok: true, title, lines } : { ok: false };
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find(value => value !== undefined);
}

const ENTITIES = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' }));

function clean(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/\[\s*\d+\s*\]/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) => {
      if (code[0] !== '#') return ENTITIES.get(code.toLowerCase()) ?? whole;
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);

      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
