/**
 * 读 Office 文件（docx、xlsx、pptx 都是 zip）用的最小 zip 读取：只读中央目录，按名字取单个条目。
 * 解压用浏览器自带的 DecompressionStream("deflate-raw")，不打包第三方库；只支持 Office 实际会写的「存储」和「deflate」两种方式。
 */

export class ZipError extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  encrypted: boolean;
}

/** 单个条目解压后的上限：防止「zip 炸弹」把侧栏内存撑爆。 */
const ENTRY_MAX_BYTES = 200 * 1024 * 1024;

export class ZipReader {
  private readonly entries = new Map<string, ZipEntry>();

  private constructor(private readonly bytes: Uint8Array) {}

  static open(bytes: Uint8Array): ZipReader {
    const zip = new ZipReader(bytes);
    zip.readDirectory();

    return zip;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async bytesOf(name: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(name);

    if (!entry) return null;

    if (entry.encrypted) throw new ZipError("文件加了密码");

    if (entry.size > ENTRY_MAX_BYTES) throw new ZipError("文件里有一部分大得不正常");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const at = entry.localOffset;

    if (at + 30 > this.bytes.length || view.getUint32(at, true) !== 0x04034b50) throw new ZipError("文件已损坏");
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const raw = this.bytes.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return raw;

    if (entry.method !== 8) throw new ZipError("文件用了不支持的压缩方式");

    return inflateRaw(raw, entry.size);
  }

  async textOf(name: string): Promise<string | null> {
    const bytes = await this.bytesOf(name);

    return bytes ? new TextDecoder("utf-8").decode(bytes) : null;
  }

  private readDirectory(): void {
    const { bytes } = this;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 目录结尾记录在最后 22 字节起、往前最多再有 64KB 注释。
    let end = -1;

    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }

    if (end < 0) throw new ZipError("不是有效的 Office 文件");
    let count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);

    // zip64：条目数或目录位置放不下 16/32 位时，真实值在 zip64 目录结尾记录里。
    if (count === 0xffff || offset === 0xffffffff) {
      const locator = end - 20;

      if (locator >= 0 && view.getUint32(locator, true) === 0x07064b50) {
        const record = Number(view.getBigUint64(locator + 8, true));

        if (view.getUint32(record, true) === 0x06064b50) {
          count = Number(view.getBigUint64(record + 32, true));
          offset = Number(view.getBigUint64(record + 48, true));
        }
      }
    }

    const utf8 = new TextDecoder("utf-8");
    const legacy = new TextDecoder("utf-8", { fatal: false });

    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new ZipError("文件已损坏");
      const flags = view.getUint16(offset + 8, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
      let compressedSize = view.getUint32(offset + 20, true);
      let size = view.getUint32(offset + 24, true);
      let localOffset = view.getUint32(offset + 42, true);
      const extra = offset + 46 + nameLength;

      for (let p = extra; p + 4 <= extra + extraLength;) {
        const id = view.getUint16(p, true);
        const length = view.getUint16(p + 2, true);

        if (id === 0x0001) {
          let q = p + 4;

          if (size === 0xffffffff) { size = Number(view.getBigUint64(q, true)); q += 8; }

          if (compressedSize === 0xffffffff) { compressedSize = Number(view.getBigUint64(q, true)); q += 8; }

          if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(q, true));
        }

        p += 4 + length;
      }

      const name = (flags & 0x800 ? utf8 : legacy).decode(nameBytes);
      this.entries.set(name, { name, method: view.getUint16(offset + 10, true), compressedSize, size, localOffset, encrypted: (flags & 1) === 1 });
      offset = extra + extraLength + commentLength;
    }
  }
}

async function inflateRaw(raw: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.length;

    // 中央目录写的大小可能是假的：实际解出来超过上限就停。
    if (total > ENTRY_MAX_BYTES) { await reader.cancel(); throw new ZipError("文件里有一部分大得不正常"); }
    chunks.push(value);
  }

  const out = new Uint8Array(expected > 0 && expected === total ? expected : total);
  let at = 0;

  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }

  return out;
}
