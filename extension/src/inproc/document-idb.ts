import { InProcessLock, type DocumentPersistence } from "@sideagent/agent/browser-core";
import { MEMORY_BACKUP_DIRTY, MEMORY_CHANGED, MEMORY_RESTORE_JOURNAL, isBackupDocumentKey } from "../shared/memory-backup.js";

const DB_NAME = "sideagent-memory";

const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };

    req.onsuccess = () => resolve(req.result);

    req.onerror = () => reject(req.error ?? new Error("记忆没能打开"));
  });
}

function isStoredText(value: unknown): value is string {
  return typeof value === "string";
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("记忆没能保存"));
    tx.onabort = () => reject(tx.error ?? new Error("记忆没能保存"));
  });
}

export class IdbDocument implements DocumentPersistence {
  private static db: Promise<IDBDatabase> | null = null;
  private readonly lock = new InProcessLock();

  constructor(private readonly key: string) {}

  private database(): Promise<IDBDatabase> {
    IdbDocument.db ??= openDb().catch(error => { IdbDocument.db = null; throw error; });

    return IdbDocument.db;
  }

  async read(): Promise<string | null> {
    const db = await this.database();
    const tx = db.transaction(STORE);
    const store = tx.objectStore(STORE);
    const req = store.get(this.key);
    const journal = store.get(MEMORY_RESTORE_JOURNAL);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => isBackupDocumentKey(this.key) && journal.result !== undefined ? reject(new Error("记忆恢复尚未完成，请稍后重试。")) : resolve(isStoredText(req.result) ? req.result : null);
      tx.onerror = () => reject(tx.error ?? new Error("记忆没能读出"));
      tx.onabort = () => reject(tx.error ?? new Error("记忆没能读出"));
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
    const store = tx.objectStore(STORE);
    const journal = store.get(MEMORY_RESTORE_JOURNAL);
    journal.onsuccess = () => {
      if (isBackupDocumentKey(this.key) && journal.result !== undefined || commitGuard && !commitGuard()) tx.abort();
      else { store.put(text, this.key); if (isBackupDocumentKey(this.key)) store.put(crypto.randomUUID(), MEMORY_BACKUP_DIRTY); }
    };
    await done(tx);
    if (isBackupDocumentKey(this.key)) void globalThis.chrome?.runtime?.sendMessage?.({ type: MEMORY_CHANGED })?.catch(() => {});
  }
}
