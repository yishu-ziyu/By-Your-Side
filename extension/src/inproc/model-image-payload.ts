const MIN_IMAGE_CHARS = 128 * 1024;
const CACHE_CHARS = 32 * 1024 * 1024;
const images = new Map<string, { result: Promise<string>; chars: number }>();
let retainedChars = 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function encode(source: string): Promise<string> {
  const original = await (await fetch(source)).blob();
  const bitmap = await createImageBitmap(original);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return source;
    context.drawImage(bitmap, 0, 0);
    // Only the transport encoding changes: preserve dimensions, alpha and original stored evidence.
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.94 });
    if (blob.type !== 'image/webp' || blob.size >= original.size * 0.8) return source;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return `data:image/webp;base64,${btoa(binary)}`;
  } finally { bitmap.close(); }
}

async function compact(source: string): Promise<string> {
  if (!source.startsWith('data:image/png;base64,') || source.length < MIN_IMAGE_CHARS) return source;
  // Hash keys avoid retaining another copy of every large uncompressed screenshot.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)));
  const key = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
  const cached = images.get(key);
  if (cached) { images.delete(key); images.set(key, cached); return cached.result; }
  const entry = { result: Promise.resolve(''), chars: 0 };
  entry.result = encode(source).catch(() => {
    console.warn('[sideagent] 图片传输编码失败，本次使用原图。');
    return source;
  }).then(value => {
    if (images.get(key) === entry) {
      entry.chars = value.length; retainedChars += entry.chars;
      while (retainedChars > CACHE_CHARS && images.size) {
        const first = images.keys().next().value!;
        retainedChars -= images.get(first)!.chars; images.delete(first);
      }
    }
    return value;
  });
  images.set(key, entry);
  return entry.result;
}

async function contentParts(parts: unknown[]): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const part of parts) {
    if (!record(part)) { result.push(part); continue; }
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      result.push({ ...part, image_url: await compact(part.image_url) });
    } else if (part.type === 'image_url' && record(part.image_url) && typeof part.image_url.url === 'string') {
      result.push({ ...part, image_url: { ...part.image_url, url: await compact(part.image_url.url) } });
    } else if (part.type === 'image' && record(part.source) && part.source.type === 'base64'
      && part.source.media_type === 'image/png' && typeof part.source.data === 'string') {
      const encoded = await compact(`data:image/png;base64,${part.source.data}`);
      const comma = encoded.indexOf(',');
      result.push({ ...part, source: { ...part.source, media_type: encoded.slice(5, encoded.indexOf(';')), data: encoded.slice(comma + 1) } });
    } else if (part.type === 'tool_result' && Array.isArray(part.content)) {
      result.push({ ...part, content: await contentParts(part.content) });
    } else result.push(part);
  }
  return result;
}

/** Transform only protocol image fields; text, tool arguments and persisted conversation objects stay intact. */
export async function compactModelImages(payload: unknown): Promise<unknown> {
  if (!record(payload)) return payload;
  const field = Array.isArray(payload.input) ? 'input' : Array.isArray(payload.messages) ? 'messages' : null;
  if (!field) return payload;
  const messages = payload[field];
  if (!Array.isArray(messages)) return payload;
  const transformed: unknown[] = [];
  for (const item of messages) {
    if (!record(item)) { transformed.push(item); continue; }
    const field = Array.isArray(item.content) ? 'content' : Array.isArray(item.output) ? 'output' : null;
    const parts = field ? item[field] : null;
    transformed.push(field && Array.isArray(parts) ? { ...item, [field]: await contentParts(parts) } : item);
  }
  return { ...payload, [field]: transformed };
}
