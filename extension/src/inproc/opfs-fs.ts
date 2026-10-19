/**
 * pi-durable 的 JSONL 存储只用到 FileSystem 的一小部分（absolutePath、joinPath、createDir、listDir、readBinaryFile、
 * writeFile、appendFile、truncateFile、flushFile、renameFile、remove）。这里用 OPFS（扩展自己的私有文件区）实现这部分，
 * 其余方法回 not_supported。
 *
 * 写入交给 opfs-worker 原地写：页面里只有 createWritable()，它每次 close() 都复制整个文件，对话越长每次写越慢。
 * 同一路径的读写按顺序排队，否则读到写了一半的文件，或 rename 撞上 Worker 还开着的句柄。
 */
import type { Context } from "@earendil-works/chord";
import { err, FileError, ok, type FileInfo, type FileSystem, type Result } from "@earendil-works/pi-durable/env";
import type { OpfsWorkerRequest, OpfsWorkerResponse } from "./opfs-worker.js";

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
  let worker: Worker | undefined;
  let nextId = 0;
  const pending = new Map<number, (response: OpfsWorkerResponse) => void>();
  const write = (path: string, request: Omit<OpfsWorkerRequest, "id" | "path">): R<void> =>
    serial(path, async () => {
      if (!worker) {
        worker = new Worker(chrome.runtime.getURL("opfs-worker.js"), { type: "module" });
        worker.onmessage = (event: MessageEvent<OpfsWorkerResponse>) => {
          pending.get(event.data.id)?.(event.data);
          pending.delete(event.data.id);
        };
        // Worker 加载失败时不会回消息；不收尾的话这一路径的保存和后面排队的读写都会一直挂着，整个对话卡住。
        worker.onerror = (event) => {
          for (const [id, resolve] of pending) resolve({ id, error: { name: "Error", message: `opfs worker: ${event.message}` } });
          pending.clear();
          worker?.terminate();
          worker = undefined;
        };
      }
      const id = ++nextId;
      const response = await new Promise<OpfsWorkerResponse>((resolve) => {
        pending.set(id, resolve);
        worker!.postMessage({ id, path, ...request } satisfies OpfsWorkerRequest);
        // 只让这一次失败，不终止 Worker：它是所有会话共用的，别的会话可能正写到一半。
        setTimeout(() => {
          pending.get(id)?.({ id, error: { name: "Error", message: `opfs worker: no reply to ${request.op} ${path}` } });
          pending.delete(id);
        }, 15_000);
      });
      if (!response.error) return ok(undefined);
      console.error("[sideagent] opfs", request.op, path, response.error.name, response.error.message);
      return fromDom(response.error, path);
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
    writeFile: (path: string, content: string | Uint8Array) => write(path, { op: "write", data: bytes(content) }),
    appendFile: (path: string, content: string | Uint8Array) => write(path, { op: "append", data: bytes(content) }),
    truncateFile: (path: string, size: number) => write(path, { op: "truncate", size }),
    // Worker 每次操作完都 close()，数据已交给浏览器；OPFS 没有更强的落盘保证可要。
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
