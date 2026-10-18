/**
 * pi-durable 的 JSONL 存储只用到 FileSystem 的一小部分（absolutePath、joinPath、createDir、listDir、readBinaryFile、
 * writeFile、appendFile、truncateFile、flushFile、renameFile、remove）。这里用 OPFS（扩展自己的私有文件区）实现这部分，
 * 其余方法回 not_supported。
 *
 * OPFS 在文档里只有异步写入：createWritable() 写到临时副本，close() 时整体换上，所以每次 append 都会复制整个文件。
 * 同一路径的写入按顺序排队，否则两个并发 append 各自从旧副本开始，后关的会盖掉先关的。
 */
import type { Context } from "@earendil-works/chord";
import { err, FileError, ok, type FileInfo, type FileSystem, type Result } from "@earendil-works/pi-durable/env";

type R<T> = Promise<Result<T, FileError>>;

const parts = (path: string) => path.split("/").filter(Boolean);
const fail = <T>(code: FileError["code"], message: string, path?: string): Result<T, FileError> => err(new FileError(code, message, path));

function fromDom<T>(error: unknown, path: string): Result<T, FileError> {
  const name = (error as { name?: string })?.name;
  if (name === "NotFoundError") return fail("not_found", `not found: ${path}`, path);
  if (name === "TypeMismatchError") return fail("not_directory", `type mismatch: ${path}`, path);
  return fail("unknown", String(error), path);
}

export function createOpfsFileSystem(): FileSystem {
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(path: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(path) ?? Promise.resolve()).then(run, run);
    queues.set(path, next.catch(() => {}));
    return next;
  };

  const dir = async (segments: string[], create: boolean) => {
    let handle = await navigator.storage.getDirectory();
    for (const segment of segments) handle = await handle.getDirectoryHandle(segment, { create });
    return handle;
  };
  const file = async (path: string, create: boolean) => {
    const segments = parts(path);
    const name = segments.pop()!;
    return (await dir(segments, create)).getFileHandle(name, { create });
  };
  const write = (path: string, mutate: (w: FileSystemWritableFileStream, size: number) => Promise<void>, keep: boolean): R<void> =>
    serial(path, async () => {
      try {
        const handle = await file(path, true);
        const size = (await handle.getFile()).size;
        const writable = await handle.createWritable({ keepExistingData: keep });
        await mutate(writable, size);
        await writable.close();
        return ok(undefined);
      } catch (error) {
        return fromDom(error, path);
      }
    });
  const bytes = (content: string | Uint8Array) => (typeof content === "string" ? new TextEncoder().encode(content) : content);
  const unsupported = async () => fail<never>("not_supported", "not supported by the OPFS experiment file system");

  return {
    id: "opfs",
    cwd: "/",
    absolutePath: async (path: string) => ok(path.startsWith("/") ? path : `/${path}`),
    joinPath: async (list: string[]) => ok(`/${list.flatMap(parts).join("/")}`),
    async createDir(path: string) {
      try { await dir(parts(path), true); return ok(undefined); } catch (error) { return fromDom(error, path); }
    },
    async listDir(path: string): R<FileInfo[]> {
      try {
        const handle = await dir(parts(path), false);
        const out: FileInfo[] = [];
        for await (const [name, entry] of (handle as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
          const child = `${path.replace(/\/$/, "")}/${name}`;
          if (entry.kind === "file") {
            const f = await (entry as FileSystemFileHandle).getFile();
            out.push({ name, path: child, kind: "file", size: f.size, mtimeMs: f.lastModified });
          } else out.push({ name, path: child, kind: "directory", size: 0, mtimeMs: 0 });
        }
        return ok(out);
      } catch (error) { return fromDom(error, path); }
    },
    readBinaryFile: (path: string): R<Uint8Array> => serial(path, async () => {
      try { return ok(new Uint8Array(await (await (await file(path, false)).getFile()).arrayBuffer())); } catch (error) { return fromDom(error, path); }
    }),
    readTextFile: (path: string): R<string> => serial(path, async () => {
      try { return ok(await (await (await file(path, false)).getFile()).text()); } catch (error) { return fromDom(error, path); }
    }),
    writeFile: (path: string, content: string | Uint8Array) => write(path, (w) => w.write(bytes(content) as BufferSource), false),
    appendFile: (path: string, content: string | Uint8Array) => write(path, async (w, size) => { await w.seek(size); await w.write(bytes(content) as BufferSource); }, true),
    truncateFile: (path: string, size: number) => write(path, (w) => w.truncate(size), true),
    // close() 已把数据交给浏览器；OPFS 没有更强的落盘保证可要。
    flushFile: async () => ok(undefined),
    renameFile: (source: string, destination: string): R<void> => serial(source, async () => {
      try {
        const handle = await file(source, false);
        const target = parts(destination);
        const name = target.pop()!;
        // SAFETY: Chrome 的 FileSystemFileHandle.move(dir, name) 不在 TS DOM 库里。
        await (handle as unknown as { move(d: FileSystemDirectoryHandle, n: string): Promise<void> }).move(await dir(target, true), name);
        return ok(undefined);
      } catch (error) { return fromDom(error, source); }
    }),
    async remove(path: string, options?: { recursive?: boolean; force?: boolean }) {
      const segments = parts(path);
      const name = segments.pop()!;
      try { await (await dir(segments, false)).removeEntry(name, { recursive: !!options?.recursive }); return ok(undefined); } catch (error) {
        const result = fromDom<void>(error, path);
        return !result.ok && result.error.code === "not_found" && options?.force ? ok(undefined) : result;
      }
    },
    async exists(path: string) {
      try { await file(path, false); return ok(true); } catch { try { await dir(parts(path), false); return ok(true); } catch { return ok(false); } }
    },
    async fileInfo(path: string): R<FileInfo> {
      try {
        const f = await (await file(path, false)).getFile();
        return ok({ name: parts(path).at(-1)!, path, kind: "file", size: f.size, mtimeMs: f.lastModified });
      } catch (error) { return fromDom(error, path); }
    },
    canonicalPath: async (path: string) => ok(path),
    openTextLineReader: unsupported,
    readTextLines: unsupported,
    openBinaryReader: unsupported,
    openDirReader: unsupported,
    watch: unsupported,
    createTempDir: unsupported,
    createTempFile: unsupported,
    cleanup: async (_context: Context) => {},
  } as FileSystem;
}
