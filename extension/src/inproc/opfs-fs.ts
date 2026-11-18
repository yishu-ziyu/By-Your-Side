import type { Context } from "@earendil-works/chord";
import { err, FileError, ok, type FileInfo, type FileSystem, type Result } from "@earendil-works/pi-durable/env";
import type { OpfsWorkerEvent, OpfsWorkerRequest, OpfsWorkerResponse } from "./opfs-worker.js";

type R<T> = Promise<Result<T, FileError>>;
type WriteOutcome = OpfsWorkerResponse & { interrupted?: true; appendOffset?: number };

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
  const confirmsAppend = async (path: string, offset: number, data: Uint8Array): Promise<boolean> => {
    try {
      const saved = await (await file(path, false)).getFile();
      if (saved.size !== offset + data.byteLength) return false;
      const suffix = new Uint8Array(await saved.slice(offset).arrayBuffer());

      return suffix.length === data.length && suffix.every((byte, i) => byte === data[i]);
    } catch {
      return false;
    }
  };
  let worker: Worker | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve: (response: WriteOutcome) => void; timer: ReturnType<typeof setTimeout>; appendOffset?: number }>();
  const receive = (response: OpfsWorkerEvent) => {
    const entry = pending.get(response.id);
    if (!entry) return;
    if ("appendOffset" in response) {
      entry.appendOffset = response.appendOffset;
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(response.id);
    entry.resolve(response);
  };
  const failAllPending = (message: string) => {
    const active = [...pending.entries()];
    pending.clear();
    worker?.terminate();
    worker = undefined;
    for (const [entryId, entry] of active) {
      clearTimeout(entry.timer);
      entry.resolve({ id: entryId, interrupted: true, appendOffset: entry.appendOffset, error: { name: "Error", message } });
    }
  };
  const write = (path: string, request: Omit<OpfsWorkerRequest, "id" | "path">): R<void> =>
    serial(path, async () => {
      if (!worker) {
        const started = new Worker(chrome.runtime.getURL("opfs-worker.js"), { type: "module" });
        worker = started;
        started.onmessage = (event: MessageEvent<OpfsWorkerEvent>) => { if (worker === started) receive(event.data); };
        started.onerror = (event) => { if (worker === started) failAllPending(`opfs worker: ${event.message}`); };
      }
      const id = ++nextId;
      const response = await new Promise<WriteOutcome>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) failAllPending(`opfs worker: no reply to ${request.op} ${path}`);
        }, 15_000);
        pending.set(id, { resolve, timer });
        worker!.postMessage({ id, path, ...request, ...(request.op === "append" ? { reportAppendOffset: true } : {}) } satisfies OpfsWorkerRequest);
      });
      if (!response.error) return ok(undefined);
      if (response.interrupted) {
        if (request.op === "append" && request.data && response.appendOffset !== undefined
          && await confirmsAppend(path, response.appendOffset, request.data)) return ok(undefined);

        return fail("unknown", `OPFS write outcome unknown: ${path}. Reopen and verify before retrying.`, path);
      }
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
    appendFile: (path: string, content: string | Uint8Array) => write(path, { op: "append", data: typeof content === "string" ? bytes(content) : content.slice() }),
    truncateFile: (path: string, size: number) => write(path, { op: "truncate", size }),
    flushFile: async () => ok(undefined),
    renameFile: (source: string, destination: string): R<void> => serial(source, async () => {
      try {
        const handle = await file(source, false);
        const target = parts(destination);
        const name = target.pop()!;
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
