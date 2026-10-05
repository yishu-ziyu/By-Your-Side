/**
 * IndexedDB 上的最小 FileSystem 外观，只实现 pi-durable JSONL 核心用到的 11 个方法（其余返回 not_supported）。
 * 文件 = files 表一条元数据 + chunks 表按 [路径, 序号] 存的分块；追加只写一个新分块，不重写整个文件。
 * 每个写操作是一个 IndexedDB 事务；stats 记录事务数与写入字节，R4 用它算每轮写入代价。
 */
import type { Context } from "@earendil-works/chord";
import { err, FileError, type FileInfo, type FileSystem, ok, type Result } from "@earendil-works/pi-durable/env";

type Meta = { path: string; kind: "file" | "directory"; chunks: number; size: number; mtimeMs: number };
export type WriteStats = { txns: number; bytes: number; byOp: Record<string, number> };

const enc = new TextEncoder();
const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
const norm = (p: string) => "/" + p.split("/").filter((s) => s && s !== ".").join("/");
const range = (path: string) => IDBKeyRange.bound([path, 0], [path, Number.MAX_SAFE_INTEGER]);
const notSupported = (name: string) => async () => err<never, FileError>(new FileError("not_supported", `${name} is not supported by IdbFileSystem`));

export async function openIdbFileSystem(dbName: string): Promise<IdbFileSystem> {
  const open = indexedDB.open(dbName, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore("files", { keyPath: "path" }); open.result.createObjectStore("chunks"); };
  return new IdbFileSystem(await req(open));
}

export class IdbFileSystem implements FileSystem {
  readonly id = "idb";
  cwd = "/";
  stats: WriteStats = { txns: 0, bytes: 0, byOp: {} };
  constructor(readonly db: IDBDatabase) {}

  private async write(op: string, bytes: number, body: (files: IDBObjectStore, chunks: IDBObjectStore) => Promise<void> | void): Promise<Result<void, FileError>> {
    const tx = this.db.transaction(["files", "chunks"], "readwrite");
    const finished = done(tx);
    try { await body(tx.objectStore("files"), tx.objectStore("chunks")); await finished; } catch (e) { return err(new FileError("unknown", String(e))); }
    this.stats.txns++; this.stats.bytes += bytes; this.stats.byOp[op] = (this.stats.byOp[op] ?? 0) + 1;
    return ok(undefined);
  }

  private async read(path: string): Promise<Uint8Array | undefined> {
    const tx = this.db.transaction(["files", "chunks"], "readonly");
    const meta = await req<Meta | undefined>(tx.objectStore("files").get(path));
    if (!meta || meta.kind !== "file") return undefined;
    const parts = await req<Uint8Array[]>(tx.objectStore("chunks").getAll(range(path)));
    const out = new Uint8Array(meta.size);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  async absolutePath(path: string, _c: Context) { return ok<string, FileError>(norm(path.startsWith("/") ? path : `${this.cwd}/${path}`)); }
  async joinPath(parts: string[], _c: Context) { return ok<string, FileError>(norm(parts.join("/"))); }

  async readBinaryFile(path: string, _c: Context): Promise<Result<Uint8Array, FileError>> {
    const bytes = await this.read(norm(path));
    return bytes ? ok(bytes) : err(new FileError("not_found", `no such file: ${path}`, path));
  }

  async readTextFile(path: string, c: Context): Promise<Result<string, FileError>> {
    const r = await this.readBinaryFile(path, c);
    return r.ok ? ok(new TextDecoder().decode(r.value)) : r;
  }

  async appendFile(path: string, content: string | Uint8Array, _c: Context) {
    const p = norm(path), bytes = typeof content === "string" ? enc.encode(content) : content;
    return this.write("append", bytes.length, async (files, chunks) => {
      const meta = (await req<Meta | undefined>(files.get(p))) ?? { path: p, kind: "file", chunks: 0, size: 0, mtimeMs: 0 };
      chunks.put(bytes, [p, meta.chunks]);
      files.put({ ...meta, chunks: meta.chunks + 1, size: meta.size + bytes.length, mtimeMs: Date.now() });
    });
  }

  async writeFile(path: string, content: string | Uint8Array, _c: Context) {
    const p = norm(path), bytes = typeof content === "string" ? enc.encode(content) : content;
    return this.write("write", bytes.length, (files, chunks) => {
      chunks.delete(range(p));
      chunks.put(bytes, [p, 0]);
      files.put({ path: p, kind: "file", chunks: 1, size: bytes.length, mtimeMs: Date.now() } satisfies Meta);
    });
  }

  async truncateFile(path: string, size: number, c: Context) {
    const current = await this.readBinaryFile(path, c);
    if (!current.ok) return current;
    const next = new Uint8Array(size);
    next.set(current.value.subarray(0, size));
    const r = await this.writeFile(path, next, c);
    this.stats.byOp.write--; this.stats.byOp.truncate = (this.stats.byOp.truncate ?? 0) + 1;
    return r;
  }

  async renameFile(source: string, destination: string, c: Context) {
    const bytes = await this.read(norm(source));
    if (!bytes) return err<void, FileError>(new FileError("not_found", `no such file: ${source}`, source));
    const s = norm(source), d = norm(destination);
    return this.write("rename", bytes.length, (files, chunks) => {
      chunks.delete(range(s)); files.delete(s);
      chunks.delete(range(d));
      chunks.put(bytes, [d, 0]);
      files.put({ path: d, kind: "file", chunks: 1, size: bytes.length, mtimeMs: Date.now() } satisfies Meta);
    });
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, _c: Context) {
    const p = norm(path);
    return this.write("remove", 0, async (files, chunks) => {
      const meta = await req<Meta | undefined>(files.get(p));
      if (!meta && !options?.force) throw new Error(`no such file: ${p}`);
      files.delete(p); chunks.delete(range(p));
      if (options?.recursive) {
        for (const key of await req(files.getAllKeys(IDBKeyRange.bound(`${p}/`, `${p}/￿`)))) { files.delete(key); chunks.delete(range(String(key))); }
      }
    });
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, _c: Context) {
    const p = norm(path);
    return this.write("mkdir", 0, async (files) => {
      const existing = await req<Meta | undefined>(files.get(p));
      if (existing?.kind === "file") throw new Error(`not a directory: ${p}`);
      files.put({ path: p, kind: "directory", chunks: 0, size: 0, mtimeMs: Date.now() } satisfies Meta);
      void options;
    });
  }

  async listDir(path: string, _c: Context): Promise<Result<FileInfo[], FileError>> {
    const p = norm(path), prefix = p === "/" ? "/" : `${p}/`;
    const metas = await req<Meta[]>(this.db.transaction("files").objectStore("files").getAll(IDBKeyRange.bound(prefix, `${prefix}￿`)));
    return ok(metas.filter((m) => !m.path.slice(prefix.length).includes("/")).map((m) => ({ name: m.path.slice(prefix.length), path: m.path, kind: m.kind, size: m.size, mtimeMs: m.mtimeMs })));
  }

  async exists(path: string, _c: Context) { return ok<boolean, FileError>(!!(await req(this.db.transaction("files").objectStore("files").get(norm(path))))); }
  async flushFile(_path: string, _c: Context) { return ok<void, FileError>(undefined); }
  async cleanup(_c: Context) {}

  openTextLineReader = notSupported("openTextLineReader");
  readTextLines = notSupported("readTextLines");
  fileInfo = notSupported("fileInfo");
  canonicalPath = notSupported("canonicalPath");
  createTempDir = notSupported("createTempDir");
  createTempFile = notSupported("createTempFile");
}
