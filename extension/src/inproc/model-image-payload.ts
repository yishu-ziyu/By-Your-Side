const MIN_IMAGE_CHARS = 128 * 1024;
const CACHE_CHARS = 32 * 1024 * 1024;
const images = new Map<string, Promise<string>>();
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
    // 保留像素尺寸和透明度；坐标、用户保存的原图与会话里的原始证据不变。
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.94 });
    if (blob.type !== 'image/webp' || blob.size >= original.size * 0.8) return source;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return `data:image/webp;base64,${btoa(binary)}`;
  } finally { bitmap.close(); }
}

function compact(source: string): Promise<string> {
  const cached = images.get(source);
  if (cached) { images.delete(source); images.set(source, cached); return cached; }
  const pending = encode(source).catch(() => {
    console.warn('[sideagent] 图片传输编码失败，本次使用原图。');
    return source;
  });
  images.set(source, pending); retainedChars += source.length;
  while (retainedChars > CACHE_CHARS && images.size > 0) {
    const first = images.keys().next().value!;
    retainedChars -= first.length; images.delete(first);
  }
  return pending;
}

/** 只替换 Responses 图片字段的传输编码，工具文本和历史消息不参与转换。 */
export async function compactCodexImages(payload: unknown): Promise<unknown> {
  if (!record(payload) || !Array.isArray(payload.input)) return payload;
  const input: unknown[] = [];
  for (const item of payload.input) {
    if (!record(item)) { input.push(item); continue; }
    const field = Array.isArray(item.content) ? 'content' : Array.isArray(item.output) ? 'output' : null;
    if (!field) { input.push(item); continue; }
    const parts = item[field];
    if (!Array.isArray(parts)) { input.push(item); continue; }
    const encoded: unknown[] = [];
    for (const part of parts) {
      if (!record(part) || part.type !== 'input_image' || typeof part.image_url !== 'string'
        || !part.image_url.startsWith('data:image/png;base64,') || part.image_url.length < MIN_IMAGE_CHARS) { encoded.push(part); continue; }
      encoded.push({ ...part, image_url: await compact(part.image_url) });
    }
    input.push({ ...item, [field]: encoded });
  }
  return { ...payload, input };
}
