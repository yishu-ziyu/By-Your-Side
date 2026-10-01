/**
 * 扩展里的记忆与过往任务：整份 JSON 存在 IndexedDB 的一条记录里，格式与本机宿主的文件相同。
 * 只在这台电脑的这个扩展里，不同步、不上传；卸载扩展即删除。
 */
import { InProcessLock, type DocumentPersistence } from "@sideagent/agent/browser-core";

const DB_NAME = "sideagent-memory";

const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };

    req.onsuccess = () => resolve(req.result);

    req.onerror = () => reject(req.error ?? new Error("记忆存储打不开"));
  });
}

/** 这一键里只存 JSON 文本；别的形状当作没有。 */
function isStoredText(value: unknown): value is string {
  return typeof value === "string";
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("记忆写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("记忆写入被中止"));
  });
}

export class IdbDocument implements DocumentPersistence {
  private static db: Promise<IDBDatabase> | null = null;
  /** 扩展里只有 offscreen 一个核心实例在写，进程内互斥就够；navigator.locks 另防同扩展的其他页面。 */
  private readonly lock = new InProcessLock();

  constructor(private readonly key: string) {}

  private database(): Promise<IDBDatabase> {
    IdbDocument.db ??= openDb().catch(error => { IdbDocument.db = null; throw error; });

    return IdbDocument.db;
  }

  async read(): Promise<string | null> {
    const db = await this.database();
    const req = db.transaction(STORE).objectStore(STORE).get(this.key);

    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(isStoredText(req.result) ? req.result : null);
      req.onerror = () => reject(req.error ?? new Error("记忆读取失败"));
    });
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    // SAFETY: offscreen 页与 Node 测试里都可能没有 navigator；缺省时只用进程内互斥。
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;

    return this.lock.run(() => locks ? locks.request(`${DB_NAME}:${this.key}`, fn) : fn());
  }

  async write(text: string, commitGuard?: () => boolean): Promise<void> {
    const db = await this.database();

    if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
    const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
    tx.objectStore(STORE).put(text, this.key);
    await done(tx);
  }
}
